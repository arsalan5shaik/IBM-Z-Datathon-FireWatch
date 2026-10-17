"""All predictions here are explicit mock fixtures, not model output."""

import copy
import json
import multiprocessing
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.errors import APIError
from app.jobs.roll_window import Revision, Roller
from app.main import create_app
from app.persistence.atomic import JobLocked, atomic_json, single_owner
from app.persistence.sqlite import read_job
from app.schemas.forecast import Manifest
from app.services.forecast_store import ForecastStore
from app.services.jsonio import read_json
from app.services.score_index import index_path
from app.services.time import iso, next_hour
from tests.conftest_forecasts import EXAMPLES

NOW = datetime(2026, 3, 8, 7, 30, tzinfo=UTC)


class MockGenerator:
    def __init__(self, grid):
        self.grid = grid
        self.calls = []
        self.failure = None

    def generate(self, hours, revision, staging):
        self.calls.append(list(hours))
        output = {}
        for hour in hours:
            document = read_json(EXAMPLES / "forecast-hour.example.json")
            document.update(revision.model_dump(mode="json"))
            document.update(forecast_hour=iso(hour), generated_at=iso(NOW))
            document["predictions"] = [
                {"cell_id": f["properties"]["cell_id"], "risk_score": 0.72}
                for f in self.grid["features"]
            ]
            path = staging / hour.strftime("%Y%m%dT%H00Z.json")
            path.write_text(json.dumps(document))
            output[hour] = path
        if self.failure == "missing":
            output[hours[-1]].unlink()
        elif self.failure == "malformed":
            output[hours[-1]].write_text('{"predictions": NaN}')
        elif self.failure == "partial":
            raise RuntimeError("Mock generator partial failure")
        elif self.failure == "incomplete":
            document["predictions"] = document["predictions"][:1]
            atomic_json(output[hours[-1]], document)
        return output


def make_deployment(tmp_path):
    settings = Settings(
        _env_file=None,
        repo_root=tmp_path,
        allow_fixture_data=True,
        job_enabled=True,
        scheduler_owner="backend",
        min_free_disk_mb=1,
    )
    grid = read_json(EXAMPLES / "grid.mock.geojson")
    atomic_json(settings.shared_data_dir / "grid.geojson", grid)
    revision = Revision(
        data_mode="fixture",
        grid_version=grid["metadata"]["grid_version"],
        model_version="mock-model-v1",
        feature_version="mock-features-v1",
        input_revision="mock-weather-v1",
        score_type="relative_risk",
        target_type="mock_fire_activity",
    )
    adapter = MockGenerator(grid)
    return settings, revision, adapter


@pytest.fixture
def deployment(tmp_path):
    return make_deployment(tmp_path)


@pytest.fixture(scope="module")
def published_template(tmp_path_factory):
    # Build a genuine published baseline once; copy it for isolated failure and
    # rollover scenarios instead of repeating the same 168-hour setup in each.
    settings, revision, adapter = make_deployment(tmp_path_factory.mktemp("published-baseline"))
    Roller(settings, adapter).run(revision, NOW)
    return settings


@pytest.fixture
def seeded_deployment(deployment, published_template):
    settings, revision, adapter = deployment
    shutil.copytree(
        published_template.shared_data_dir, settings.shared_data_dir, dirs_exist_ok=True
    )
    return settings, revision, adapter


def manifest(settings):
    return Manifest.model_validate(
        read_json(settings.shared_data_dir / "predictions/manifest.json")
    )


def test_bootstrap_reader_index_and_status(deployment, monkeypatch):
    settings, revision, adapter = deployment
    result = Roller(settings, adapter).run(revision, NOW)
    assert result == {"generated_hours": 168, "reused_hours": 0, "published": True}
    current = manifest(settings)
    assert len(current.hours) == 168
    assert current.hours[0] == next_hour(NOW)
    assert current.hours[-1] == current.hours[0] + timedelta(hours=167)
    assert current.grid_artifact.startswith("grids/")
    assert current.validated_cell_count == 2
    assert read_job(settings.sqlite_path)["last_success_at"] == iso(NOW)
    app = create_app(settings)

    from app.services import forecast_store

    original = forecast_store.read_json
    reads = []

    def observed(path):
        reads.append(path)
        assert "objects" not in path.parts, "Published requests must use the derived score index"
        return original(path)

    monkeypatch.setattr(forecast_store, "read_json", observed)
    with TestClient(app) as client:
        query = {"hour": iso(current.hours[0]), "bbox": "-120,36.22,-119.98,36.24"}
        response = client.get("/api/v1/forecasts/risk", params=query)
        assert response.status_code == 200, response.text
        assert response.json()["metadata"]["data_mode"] == "fixture"
        history = client.get("/api/v1/forecasts/cell/MOCK_CA_000")
        assert history.status_code == 200
        assert len(history.json()["hours"]) == 168
        assert all(row["risk_score"] == 0.72 for row in history.json()["hours"])
        status = client.get("/api/v1/status").json()
        assert status["data_mode"] == "fixture"
        assert status["forecast"]["valid_hour_count"] == 168
        assert status["forecast"]["missing_hour_count"] == 0
        assert status["forecast"]["model_version"] == revision.model_version
        assert status["scheduler"]["owner"] == "backend"
    assert sum(p.suffix == ".geojson" for p in reads) == 1
    assert len(adapter.calls) == 1  # GET never calls the generator.


@pytest.mark.parametrize("elapsed, generated", [(0, 0), (1, 1), (5, 5), (170, 168)])
def test_rollover_reuse_and_missed_hours(seeded_deployment, elapsed, generated):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    old = manifest(settings)
    original_bytes = (roller.predictions / "manifest.json").read_bytes()
    result = roller.run(revision, NOW + timedelta(hours=elapsed))
    assert result["generated_hours"] == generated
    assert result["reused_hours"] == 168 - generated
    new = manifest(settings)
    for hour in set(old.hours) & set(new.hours):
        assert old.artifacts[iso(hour)] == new.artifacts[iso(hour)]
    if elapsed == 0:
        assert not result["published"]
        assert (roller.predictions / "manifest.json").read_bytes() == original_bytes
        assert len(adapter.calls) == 0
    else:
        assert len(adapter.calls[-1]) == generated


@pytest.mark.parametrize(
    "field", ["input_revision", "model_version", "feature_version", "grid_version"]
)
def test_revision_invalidates_whole_window_without_dependency_map(seeded_deployment, field):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    old = manifest(settings)
    changed = revision.model_copy(update={field: getattr(revision, field) + "-v2"})
    if field == "grid_version":
        grid = copy.deepcopy(adapter.grid)
        grid["metadata"]["grid_version"] = changed.grid_version
        for feature in grid["features"]:
            feature["properties"]["grid_version"] = changed.grid_version
        atomic_json(settings.shared_data_dir / "grid.geojson", grid)
        adapter.grid = grid
    result = roller.run(changed, NOW)
    assert result["generated_hours"] == 168
    new = manifest(settings)
    assert set(old.artifacts.values()).isdisjoint(new.artifacts.values())
    store = ForecastStore(settings)
    loaded, grid = store.snapshot()
    assert loaded.grid_version == changed.grid_version
    assert store.hour(loaded, grid, loaded.hours[0], ["MOCK_CA_000"])[1] == {"MOCK_CA_000": 0.72}
    # A reader holding the prior manifest can still read its original grid/artifacts.
    assert (settings.shared_data_dir / old.grid_artifact).exists()
    assert all((roller.predictions / name).exists() for name in old.artifacts.values())


@pytest.mark.parametrize("failure", ["missing", "malformed", "partial", "incomplete"])
def test_generation_failure_preserves_last_good_and_recovers(seeded_deployment, failure):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    original = (roller.predictions / "manifest.json").read_bytes()
    adapter.failure = failure
    with pytest.raises((OSError, ValueError, RuntimeError)):
        roller.run(revision, NOW + timedelta(hours=1))
    assert (roller.predictions / "manifest.json").read_bytes() == original
    assert read_job(settings.sqlite_path)["last_error"] == "forecast_rollover_failed"
    store = ForecastStore(settings)
    current, grid = store.snapshot()
    assert store.metadata(current, NOW)["stale"]
    assert store.hour(current, grid, current.hours[0])[1]
    adapter.failure = None
    assert roller.run(revision, NOW + timedelta(hours=1))["generated_hours"] == 1
    assert read_job(settings.sqlite_path)["last_error"] is None


class SimulatedCrash(BaseException):
    pass


@pytest.mark.parametrize("phase", ["artifact_published", "before_manifest", "after_manifest"])
def test_crash_publication_and_recovery(seeded_deployment, phase):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    old = manifest(settings)

    def crash(point):
        if point == phase:
            raise SimulatedCrash()

    with pytest.raises(SimulatedCrash):
        Roller(settings, adapter, crash).run(revision, NOW + timedelta(hours=1))
    store = ForecastStore(settings)
    current, grid = store.snapshot()
    assert all(store.hour(current, grid, h, ["MOCK_CA_000"])[1] for h in current.hours)
    assert (current.active_window_start != old.active_window_start) == (phase == "after_manifest")
    result = roller.run(revision, NOW + timedelta(hours=1))
    assert result["generated_hours"] == (0 if phase == "after_manifest" else 1)


@pytest.mark.parametrize("corruption", ["missing", "malformed"])
def test_repair_published_bad_hour(seeded_deployment, corruption):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    current = manifest(settings)
    path = roller.predictions / current.artifacts[iso(current.hours[50])]
    if corruption == "missing":
        path.unlink()
    else:
        path.write_text("broken JSON")
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/status").json()["forecast"]["valid_hour_count"] == 167
    assert roller.run(revision, NOW)["generated_hours"] == 1
    assert len(adapter.calls[-1]) == 1


def test_manifest_and_grid_recovery(seeded_deployment):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    old = manifest(settings)
    roller.run(revision, NOW + timedelta(hours=1))
    (roller.predictions / "manifest.json").write_text("truncated")
    (settings.shared_data_dir / "grid.geojson").write_text("unpublished upstream grid")
    store = ForecastStore(settings)
    recovered, grid = store.snapshot()
    assert recovered._recovered
    assert recovered.active_window_start == old.active_window_start
    assert store.metadata(recovered, NOW)["stale"]
    assert store.hour(recovered, grid, recovered.hours[0])[1]
    atomic_json(settings.shared_data_dir / "grid.geojson", adapter.grid)
    roller.run(revision, NOW + timedelta(hours=1))
    assert not store.snapshot()[0]._recovered


@pytest.mark.parametrize(
    "now",
    [
        datetime(2026, 3, 8, 9, 59, tzinfo=UTC),  # California spring-forward
        datetime(2026, 11, 1, 8, 59, tzinfo=UTC),  # California fall-back
        datetime(2026, 12, 31, 23, 59, tzinfo=UTC),
        datetime(2026, 1, 1, 0, 0, tzinfo=UTC),
    ],
)
def test_utc_windows_across_dst_and_year_boundary(deployment, now):
    settings, revision, adapter = deployment
    Roller(settings, adapter).run(revision, now)
    current = manifest(settings)
    assert current.active_window_start == next_hour(now)
    assert (
        current.active_window_end_exclusive - current.active_window_start
    ).total_seconds() == 604800
    assert len(set(current.hours)) == 168
    store = ForecastStore(settings)
    assert not store.metadata(current, now)["stale"]
    assert store.metadata(current, next_hour(now))["stale"]


def hold_lock(path, ready, release):
    with single_owner(path):
        ready.set()
        release.wait(20)


def test_process_lock_and_recovery_after_owner_dies(deployment):
    settings, revision, adapter = deployment
    roller = Roller(settings, adapter)
    context = multiprocessing.get_context("spawn")
    ready, release = context.Event(), context.Event()
    process = context.Process(
        target=hold_lock, args=(roller.predictions / ".scheduler.lock", ready, release)
    )
    process.start()
    try:
        assert ready.wait(15)
        with pytest.raises(JobLocked):
            roller.run(revision, NOW)
        assert not adapter.calls
    finally:
        process.terminate()
        process.join(10)
    assert roller.run(revision, NOW)["generated_hours"] == 168


def test_no_forecast_until_bootstrap_commits(deployment):
    settings, revision, adapter = deployment

    def crash(phase):
        if phase == "before_manifest":
            raise SimulatedCrash()

    with pytest.raises(SimulatedCrash):
        Roller(settings, adapter, crash).run(revision, NOW)
    with pytest.raises(APIError):
        ForecastStore(settings).snapshot()
    assert Roller(settings, adapter).run(revision, NOW)["generated_hours"] == 168


def test_scheduler_requires_owner_and_fixture_opt_in(deployment):
    settings, revision, adapter = deployment
    for update in (
        {"job_enabled": False},
        {"scheduler_owner": "ml"},
        {"allow_fixture_data": False},
    ):
        with pytest.raises(ValueError):
            Roller(settings.model_copy(update=update), adapter).run(revision, NOW)
    assert not adapter.calls


def test_concurrent_rollovers_publish_once(seeded_deployment):
    settings, revision, adapter = seeded_deployment
    entered, release = Event(), Event()

    def pause(phase):
        if phase == "before_manifest":
            entered.set()
            assert release.wait(15)

    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(
            Roller(settings, adapter, pause).run, revision, NOW + timedelta(hours=1)
        )
        try:
            assert entered.wait(15)
            with pytest.raises(JobLocked):
                Roller(settings, adapter).run(revision, NOW + timedelta(hours=1))
        finally:
            release.set()
        assert first.result(timeout=15)["generated_hours"] == 1
    assert len(adapter.calls) == 1
    assert not Roller(settings, adapter).run(revision, NOW + timedelta(hours=1))["published"]


def test_retention_protects_both_snapshots_and_unrelated_data(seeded_deployment):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    old = manifest(settings)
    orphan = roller.predictions / "objects/orphan.json"
    orphan_index = index_path(orphan)
    orphan_grid = settings.shared_data_dir / "grids/orphan.geojson"
    unrelated = settings.shared_data_dir / "teammate.json"
    staging = roller.predictions / ".generation-orphan"
    staging.mkdir()
    (staging / "partial.json").write_text("{}")
    files = [orphan, orphan_index, orphan_grid, unrelated]
    for path in files:
        path.write_text("{}")
    protected = [roller.predictions / name for name in old.artifacts.values()]
    for path in [*files, *protected, staging]:
        os.utime(path, (NOW.timestamp() - 172800, NOW.timestamp() - 172800))
    roller.run(revision, NOW + timedelta(hours=1))
    assert not orphan.exists() and not orphan_index.exists() and not orphan_grid.exists()
    assert not staging.exists()
    assert unrelated.exists()
    assert all(path.exists() for path in protected)


def test_low_disk_preserves_snapshot(seeded_deployment, monkeypatch):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    before = (roller.predictions / "manifest.json").read_bytes()
    monkeypatch.setattr(shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
    with pytest.raises(OSError, match="disk space"):
        roller.run(revision, NOW + timedelta(hours=1))
    assert (roller.predictions / "manifest.json").read_bytes() == before
    assert not adapter.calls


def test_missing_index_falls_back_read_only_and_scheduler_rebuilds(seeded_deployment):
    settings, revision, adapter = seeded_deployment
    roller = Roller(settings, adapter)
    current = manifest(settings)
    source = roller.predictions / current.artifacts[iso(current.hours[0])]
    index = index_path(source)
    index.write_text("corrupt derived cache")
    store = ForecastStore(settings)
    loaded, grid = store.snapshot()
    assert store.hour(loaded, grid, loaded.hours[0], ["MOCK_CA_000"])[1]["MOCK_CA_000"] == 0.72
    assert index.read_text() == "corrupt derived cache"  # GET never repairs/writes.
    result = roller.run(revision, NOW)
    assert result["generated_hours"] == 0 and not adapter.calls
    assert index.read_bytes().startswith(b"SQLite format 3")


def test_healthy_status_uses_actual_published_freshness(seeded_deployment, monkeypatch):
    settings, _, _ = seeded_deployment
    from app.services import forecast_store

    class Clock:
        @staticmethod
        def now(tz):
            return NOW

    monkeypatch.setattr(forecast_store, "datetime", Clock)
    with TestClient(create_app(settings)) as client:
        status = client.get("/api/v1/status").json()
        assert status["forecast"]["status"] == "healthy"
        assert status["forecast"]["stale"] is False
        assert status["data_mode"] == "fixture"
