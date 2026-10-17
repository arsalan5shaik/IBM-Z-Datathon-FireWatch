import json
import subprocess
from datetime import UTC, datetime

import pytest
from pydantic import SecretStr

from app.config import Settings
from app.jobs.roll_window import Revision
from app.persistence import atomic
from app.persistence.sqlite import read_job, record_job
from app.schemas.forecast import Manifest
from app.services.jsonio import read_json
from app.services.prediction_adapter import CLIAdapter, GenerationUnavailable
from tests.conftest_forecasts import EXAMPLES


def test_failed_atomic_replace_keeps_old_document(tmp_path, monkeypatch):
    path = tmp_path / "manifest.json"
    atomic.atomic_json(path, {"revision": "old"})

    def fail(*args):
        raise OSError("Mock disk failure")

    monkeypatch.setattr(atomic.os, "replace", fail)
    with pytest.raises(OSError):
        atomic.atomic_json(path, {"revision": "new"})
    assert read_json(path) == {"revision": "old"}
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize(
    "reference", ["../escape.json", "/absolute.json", "C:/outside.json", "..\\outside"]
)
def test_references_reject_escape(reference):
    document = read_json(EXAMPLES / "forecast-manifest.example.json")
    for field in ("grid_artifact", "boundary_artifact"):
        with pytest.raises(ValueError):
            Manifest.model_validate(document | {field: reference})
    with pytest.raises(ValueError):
        Manifest.model_validate(document | {"artifacts": {document["hours"][0]: reference}})


def test_unknown_reference_hour_is_rejected():
    document = read_json(EXAMPLES / "forecast-manifest.example.json")
    with pytest.raises(ValueError):
        Manifest.model_validate(document | {"artifacts": {"unknown": "objects/example.json"}})


def test_job_metadata_retains_success_after_failure(tmp_path):
    path = tmp_path / "jobs.sqlite3"
    assert read_job(path) == {}
    record_job(path, "forecast", "2026-03-08T07:00:00Z", "2026-03-08T08:00:00Z", True, None)
    record_job(path, "forecast", "2026-03-08T08:00:00Z", "2026-03-08T09:00:00Z", False, "failure")
    assert read_job(path)["last_success_at"] == "2026-03-08T07:00:00Z"
    assert read_job(path)["last_error"] == "failure"
    path.write_bytes(b"broken database")
    assert read_job(path)["last_error"] == "job_metadata_unavailable"


def test_cli_request_retry_and_redacted_failure(tmp_path, monkeypatch):
    settings = Settings(
        _env_file=None,
        repo_root=tmp_path,
        forecast_generator_cmd=SecretStr('["mock-ml", "--fixture"]'),
        generator_retry_seconds=0,
        generator_max_retries=1,
    )
    document = read_json(EXAMPLES / "forecast-hour.example.json")
    revision = Revision(**{field: document[field] for field in Revision.model_fields})
    hours = [datetime(2026, 3, 8, 8, tzinfo=UTC)]
    output = tmp_path / "20260308T0800Z.json"
    attempts = []

    def run(argv, **kwargs):
        request = read_json(tmp_path / "request.json")
        assert request["hours"] == ["2026-03-08T08:00:00Z"]
        assert request["revision"]["data_mode"] == "fixture"
        assert argv[-2:] == ["--request", str(tmp_path / "request.json")]
        assert kwargs["shell"] is False
        assert kwargs["timeout"] == settings.generator_timeout_seconds
        assert not output.exists()  # Retry discards incomplete attempt outputs.
        output.write_text(json.dumps(document))
        attempts.append(argv)
        if len(attempts) == 1:
            raise subprocess.TimeoutExpired("secret-command", 1)

    monkeypatch.setattr(subprocess, "run", run)
    assert CLIAdapter(settings).generate(hours, revision, tmp_path) == {hours[0]: output}
    assert len(attempts) == 2

    def fail(*args, **kwargs):
        raise OSError("secret provider details")

    monkeypatch.setattr(subprocess, "run", fail)
    with pytest.raises(GenerationUnavailable, match="failed or timed out") as error:
        CLIAdapter(settings).generate(hours, revision, tmp_path)
    assert "secret" not in str(error.value)


@pytest.mark.parametrize("command", [None, '"shell command"', "[]", '[""]'])
def test_cli_requires_explicit_argv(tmp_path, command):
    settings = Settings(_env_file=None, repo_root=tmp_path, forecast_generator_cmd=command)
    with pytest.raises(GenerationUnavailable):
        CLIAdapter(settings).generate([], None, tmp_path)
