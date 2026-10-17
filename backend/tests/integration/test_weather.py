from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.time import iso
from app.services.weather_cache import WeatherCache
from tests.unit.test_weather_cache import MockProvider
from tests.unit.test_weather_provider import NOW


@pytest.fixture
def deployed(tmp_path):
    settings = Settings(_env_file=None, repo_root=tmp_path)
    provider = MockProvider()
    clock = [NOW]
    app = create_app(settings)
    app.state.weather = WeatherCache(provider, settings, lambda: clock[0])
    with TestClient(app) as client:
        yield client, provider, clock, app


def test_weather_wind_shared_cache_and_status(deployed):
    client, provider, _, _ = deployed
    params = {"latitude": 36.51, "longitude": -120.01, "hour": iso(NOW + timedelta(hours=1))}
    weather = client.get("/api/v1/weather", params=params)
    assert weather.status_code == 200, weather.text
    data = weather.json()
    assert data["temperature_c"] == 20 and data["wind_speed_kmh"] == 10
    assert data["latitude"] == 36.5 and data["longitude"] == -120
    assert data["issued_at"] is None and data["data_kind"] == "forecast"
    result = client.get(
        "/api/v1/wind", params={"bbox": "-120.2,36.4,-119.8,36.6", "hour": params["hour"]}
    )
    assert result.status_code == 200, result.text
    assert result.json()["features"][0]["geometry"]["coordinates"] == [-120, 36.5]
    assert result.json()["features"][0]["properties"]["wind_direction_deg"] == 90
    assert result.json()["metadata"]["cache_status"] == "fresh"
    assert provider.calls == 1
    status = client.get("/api/v1/status").json()
    assert status["providers"]["weather"]["status"] == "healthy"
    assert status["forecast"]["valid_hour_count"] == 0  # Weather is not wildfire prediction.


@pytest.mark.parametrize(
    "params",
    [
        {"latitude": 45, "longitude": -120},
        {"latitude": 36},
        {"latitude": "nan", "longitude": -120},
        {"latitude": 36, "longitude": -120, "cell_id": "duplicate"},
        {"latitude": 36, "longitude": -120, "hour": "2026-10-17T12:03:00Z"},
        {"latitude": 36, "longitude": -120, "hour": "2026-10-17T12:00:00"},
    ],
)
def test_weather_input_validation(deployed, params):
    client, provider, _, _ = deployed
    response = client.get("/api/v1/weather", params={"hour": iso(NOW)} | params)
    assert response.status_code == 422
    assert provider.calls == 0


@pytest.mark.parametrize("bbox", ["bad", "-130,32,-110,43", "-120,37,-121,36"])
def test_wind_input_validation(deployed, bbox):
    client, provider, _, _ = deployed
    assert client.get("/api/v1/wind", params={"bbox": bbox, "hour": iso(NOW)}).status_code == 422
    assert provider.calls == 0


def test_outage_stale_and_missing_hour(deployed):
    client, provider, clock, _ = deployed
    params = {"latitude": 36.5, "longitude": -120, "hour": iso(NOW)}
    assert client.get("/api/v1/weather", params=params).status_code == 200
    provider.fail = True
    clock[0] += timedelta(hours=1)
    result = client.get("/api/v1/weather", params=params)
    assert result.json()["cache_status"] == "stale"
    missing = client.get(
        "/api/v1/weather", params=params | {"hour": iso(NOW + timedelta(hours=180))}
    )
    assert (
        missing.status_code == 404 and missing.json()["error"]["code"] == "weather_hour_unavailable"
    )
    clock[0] += timedelta(hours=4)
    assert client.get("/api/v1/weather", params=params).status_code == 503


def test_null_hour_is_not_zero(deployed):
    client, provider, _, _ = deployed
    provider.data["hourly"]["precipitation"][1] = None
    result = client.get(
        "/api/v1/wind",
        params={"bbox": "-120.2,36.4,-119.8,36.6", "hour": iso(NOW + timedelta(hours=1))},
    )
    assert result.status_code == 404
