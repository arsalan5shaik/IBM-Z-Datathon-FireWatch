import json
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.services.grid import Grid, bbox, geometry_bounds
from app.services.time import day_hours
from tests.conftest_forecasts import mock_forecasts


@pytest.fixture
def deployed(tmp_path):
    return mock_forecasts(tmp_path)


def query_bounds(grid):
    w, s, e, n = geometry_bounds(grid["features"][0]["geometry"])
    return f"{w + 0.001},{s + 0.001},{e - 0.001},{n - 0.001}"


def test_bbox_hour_and_history(deployed):
    app, grid, _, _ = deployed
    with TestClient(app) as client:
        response = client.get(
            "/api/v1/forecasts/risk",
            params={"hour": "2026-03-08T08:00:00Z", "bbox": query_bounds(grid)},
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["type"] == "FeatureCollection"
        assert data["metadata"]["data_mode"] == "fixture"
        assert data["metadata"]["source"] == "mock_fixture"
        assert len(data["features"]) == 1
        assert data["features"][0]["properties"]["risk_score"] == 0.72
        assert data["features"][0]["properties"]["risk_category"] == "high"
        assert data["features"][0]["geometry"] == grid["features"][0]["geometry"]
        history = client.get("/api/v1/forecasts/cell/MOCK_CA_000").json()["hours"]
        assert len(history) == 168
        assert history[0]["risk_score"] == 0.72
        assert sum(h["missing"] for h in history) == 167


def test_dst_partial_day(deployed):
    assert len(day_hours(date(2026, 3, 8))) == 23
    assert len(day_hours(date(2026, 11, 1))) == 25
    app, grid, _, _ = deployed
    with TestClient(app) as client:
        response = client.get(
            "/api/v1/forecasts/risk", params={"date": "2026-03-08", "bbox": query_bounds(grid)}
        )
        data = response.json()
        assert data["metadata"]["expected_hours"] == 23
        assert data["metadata"]["coverage_hours"] == 1
        assert data["metadata"]["partial_day"] is True
        assert data["metadata"]["aggregation_is_probability"] is False


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"hour": "2026-03-08T08:00:00Z", "date": "2026-03-08"},
        {"hour": "2026-03-08T08:01:00Z"},
        {"hour": "2026-03-08T08:00:00"},
        {"date": "2026-03-08", "aggregation": "probability"},
    ],
)
def test_bad_query(deployed, params):
    app, grid, _, _ = deployed
    with TestClient(app) as client:
        assert (
            client.get(
                "/api/v1/forecasts/risk", params={"bbox": query_bounds(grid)} | params
            ).status_code
            == 422
        )


@pytest.mark.parametrize(
    "value", ["nan,32,-114,42", "0,0,180,90", "-120,38,-121,39", "-120,38,-119", "-181,30,-120,31"]
)
def test_bad_bbox(value):
    with pytest.raises(ValueError):
        bbox(value)


def test_missing_cell_is_not_zero(deployed, tmp_path):
    app, grid, artifact, _ = deployed
    artifact["predictions"] = []
    (tmp_path / "predictions/20260308T0800Z.json").write_text(json.dumps(artifact))
    with TestClient(app) as client:
        data = client.get(
            "/api/v1/forecasts/risk",
            params={"hour": "2026-03-08T08:00:00Z", "bbox": query_bounds(grid)},
        ).json()
        assert data["features"][0]["properties"]["risk_score"] is None
        assert data["metadata"]["incomplete_cells"] == 1


@pytest.mark.parametrize(
    "change",
    [
        {"model_version": "wrong"},
        {"grid_version": "wrong"},
        {"predictions": [{"cell_id": "unknown", "risk_score": 0.3}]},
    ],
)
def test_mismatched_artifacts(deployed, tmp_path, change):
    app, grid, artifact, _ = deployed
    (tmp_path / "predictions/20260308T0800Z.json").write_text(json.dumps(artifact | change))
    with TestClient(app) as client:
        response = client.get(
            "/api/v1/forecasts/risk",
            params={"hour": "2026-03-08T08:00:00Z", "bbox": query_bounds(grid)},
        )
        assert response.status_code == 503


def test_missing_data_and_fixture_opt_in(client, tmp_path):
    assert client.get("/api/v1/forecasts/cell/any").status_code == 503
    app, _, _, _ = mock_forecasts(tmp_path)
    app.state.forecasts.settings = app.state.settings.model_copy(
        update={"allow_fixture_data": False}
    )
    with TestClient(app) as c:
        assert c.get("/api/v1/forecasts/cell/MOCK_CA_000").status_code == 503


def test_grid_validation_and_limit(deployed):
    _, document, _, _ = deployed
    grid = Grid(document)
    with pytest.raises(ValueError):
        grid.query((-124, 32, -114, 42), 1)
    document["features"].append(document["features"][0])
    with pytest.raises(ValueError):
        Grid(document)


def test_reject_path_escape(deployed, tmp_path):
    app, _, _, manifest = deployed
    manifest["artifacts"] = {"2026-03-08T08:00:00Z": "../../private.json"}
    (tmp_path / "predictions/manifest.json").write_text(json.dumps(manifest))
    with TestClient(app) as client:
        assert client.get("/api/v1/forecasts/cell/MOCK_CA_000").status_code == 503
