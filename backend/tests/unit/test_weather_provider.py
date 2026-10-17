import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from app.config import Settings
from app.errors import APIError
from app.schemas.weather import WeatherPoint
from app.services.weather_provider import OpenMeteoProvider, normalize

NOW = datetime(2026, 10, 17, 12, tzinfo=UTC)


def response(hours=169):
    return {
        "latitude": 36.5,
        "longitude": -120,
        "utc_offset_seconds": 0,
        "hourly_units": {
            "time": "unixtime",
            "temperature_2m": "°C",
            "relative_humidity_2m": "%",
            "precipitation": "mm",
            "wind_speed_10m": "km/h",
            "wind_direction_10m": "°",
            "wind_gusts_10m": "km/h",
        },
        "hourly": {
            "time": [int(NOW.timestamp()) + i * 3600 for i in range(hours)],
            **{
                key: [value] * hours
                for key, value in {
                    "temperature_2m": 20,
                    "relative_humidity_2m": 30,
                    "precipitation": 0,
                    "wind_speed_10m": 10,
                    "wind_direction_10m": 90,
                    "wind_gusts_10m": 15,
                }.items()
            },
        },
    }


def test_normalization_and_units():
    data = response()
    assert len(normalize(data, NOW).hours) == 169
    data["hourly_units"].update(temperature_2m="°F", wind_speed_10m="m/s", precipitation="inch")
    data["hourly"]["temperature_2m"] = [68] * 169
    data["hourly"]["precipitation"] = [1] * 169
    hour = normalize(data, NOW).hours[0]
    assert hour.temperature_c == 20 and hour.wind_speed_kmh == 36
    assert hour.precipitation_mm == 25.4 and hour.forecast_hour.tzinfo == UTC
    data["hourly"]["temperature_2m"][0] = None
    assert not normalize(data, NOW).hours[0].complete


@pytest.mark.parametrize(
    "change", ["offset", "alignment", "length", "unit", "variable", "nan", "duplicate"]
)
def test_invalid_provider_data(change):
    data = response()
    if change == "offset":
        data["utc_offset_seconds"] = 3600
    if change == "alignment":
        data["hourly"]["time"][0] += 1
    if change == "length":
        data["hourly"]["precipitation"].pop()
    if change == "unit":
        data["hourly_units"]["wind_speed_10m"] = "unknown"
    if change == "variable":
        del data["hourly"]["temperature_2m"]
    if change == "nan":
        data["hourly"]["temperature_2m"][0] = float("nan")
    if change == "duplicate":
        data["hourly"]["time"][1] = data["hourly"]["time"][0]
    with pytest.raises((ValueError, KeyError)):
        normalize(data, NOW)


@pytest.mark.parametrize("status", [200, 400, 429, 500, "timeout", "bad_json"])
def test_provider_mock_http(status):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.params["forecast_hours"] == "169"
        if status == "timeout":
            raise httpx.ReadTimeout("mock")
        if status == "bad_json":
            return httpx.Response(200, content=b"invalid")
        return httpx.Response(status, json=response())

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = OpenMeteoProvider(client, Settings(_env_file=None, provider_max_retries=0))
            points = [WeatherPoint(anchor_id="test", latitude=36.5, longitude=-120)]
            if status == 200:
                assert len((await provider.fetch(points, NOW))[0].hours) == 169
            else:
                with pytest.raises(APIError):
                    await provider.fetch(points, NOW)

    asyncio.run(run())
    assert len(calls) == 1


def test_batched_provider_retry_after_rate_limit(monkeypatch):
    calls, delays = [], []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after": "2"})
        return httpx.Response(200, json=[response(), response()])

    async def sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", sleep)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = OpenMeteoProvider(client, Settings(_env_file=None, provider_max_retries=1))
            points = [
                WeatherPoint(anchor_id=f"test{i}", latitude=36.5, longitude=-120) for i in range(2)
            ]
            assert len(await provider.fetch(points, NOW)) == 2

    asyncio.run(run())
    assert len(calls) == 2 and delays == [2]
