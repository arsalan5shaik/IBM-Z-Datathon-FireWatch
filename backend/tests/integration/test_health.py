from datetime import datetime

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_lifespan_and_readiness(app):
    assert app.state.runtime.ready is False
    with TestClient(app) as client:
        assert client.get("/health/live").json() == {"status": "alive"}
        assert client.get("/health/ready").json() == {"status": "ready"}
        assert app.state.runtime.ready is True
    assert app.state.runtime.ready is False


def test_not_initialized_is_not_ready(app):
    with TestClient(app) as client:
        app.state.runtime.ready = False
        result = client.get("/health/ready")
        assert result.status_code == 503
        assert result.json()["error"]["code"] == "service_not_ready"
        assert client.get("/health/live").status_code == 200


def test_no_data_is_truthful(client):
    result = client.get("/api/v1/status")
    assert result.status_code == 200
    data = result.json()
    assert data["status"] == "degraded"
    assert data["data_mode"] == "unavailable"
    assert data["api"]["status"] == "healthy"
    forecast = data["forecast"]
    assert forecast["valid_hour_count"] == 0
    assert forecast["missing_hour_count"] == 168
    assert forecast["stale"] is True
    for field in ("model_version", "grid_version", "last_success_at", "active_window_start"):
        assert forecast[field] is None
    assert all(p["status"] == "unavailable" for p in data["providers"].values())
    assert all(p["source_observed_at"] is None for p in data["providers"].values())
    assert data["scheduler"]["enabled"] is False
    assert datetime.fromisoformat(data["checked_at"].replace("Z", "+00:00")).utcoffset().days == 0
    assert result.headers["cache-control"] == "no-store"


def test_keys_do_not_imply_live_data_or_network(tmp_path):
    # The autouse fixture rejects real HTTP transports throughout startup and GETs.
    app = create_app(Settings(_env_file=None, repo_root=tmp_path, firms_map_key="mock-key"))
    with TestClient(app) as client:
        assert client.get("/api/v1/status").json()["data_mode"] == "unavailable"
    assert not (tmp_path / "shared").exists()


def test_app_instances_do_not_share_state(settings):
    first = create_app(settings)
    second = create_app(settings)
    with TestClient(first):
        assert first.state.runtime.ready
        assert not second.state.runtime.ready
