import copy
import json

import pytest
from pydantic import ValidationError

from app.schemas.forecast import HourArtifact, Manifest
from app.services.jsonio import read_json
from tests.conftest_forecasts import EXAMPLES


@pytest.fixture
def artifact():
    return read_json(EXAMPLES / "forecast-hour.example.json")


def test_examples_and_exported_schema_match(artifact):
    assert HourArtifact.model_validate(artifact).data_mode == "fixture"
    assert Manifest.model_validate(read_json(EXAMPLES / "forecast-manifest.example.json")).hours
    for name, model in (("forecast-hour.v1", HourArtifact), ("forecast-manifest.v1", Manifest)):
        schema = read_json(EXAMPLES.parent / "schemas" / f"{name}.schema.json")
        schema.pop("$schema")
        assert schema == model.model_json_schema()


@pytest.mark.parametrize(
    "change",
    [
        {"schema_version": "2"},
        {"model_version": ""},
        {"feature_version": None},
        {"input_revision": ""},
        {"grid_resolution_m": 1000},
        {"data_mode": "real"},
        {"forecast_hour": "2026-03-08T08:00:00"},
        {"forecast_hour": "2026-03-08T08:01:00Z"},
        {"generated_at": "2026-03-08T08:00:00"},
        {"score_type": "probability"},
    ],
)
def test_invalid_metadata(artifact, change):
    with pytest.raises(ValidationError):
        HourArtifact.model_validate(artifact | change)


@pytest.mark.parametrize("score", [float("nan"), float("inf"), -0.1, 1.1, "0.5", True])
def test_invalid_scores(artifact, score):
    artifact["predictions"][0]["risk_score"] = score
    with pytest.raises(ValidationError):
        HourArtifact.model_validate(artifact)


def test_duplicates_and_missing(artifact):
    artifact["predictions"].append(copy.deepcopy(artifact["predictions"][0]))
    with pytest.raises(ValidationError):
        HourArtifact.model_validate(artifact)
    artifact.pop("target_type")
    with pytest.raises(ValidationError):
        HourArtifact.model_validate(artifact)


@pytest.mark.parametrize("text", ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', "{bad"])
def test_invalid_json(tmp_path, text):
    path = tmp_path / "bad.json"
    path.write_text(text)
    with pytest.raises(ValueError):
        read_json(path)


def test_size_bound(tmp_path):
    path = tmp_path / "large.json"
    path.write_text(json.dumps([0] * 10))
    with pytest.raises(ValueError):
        read_json(path, max_bytes=5)
