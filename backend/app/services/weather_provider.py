"""Bounded Open-Meteo forecast client, injectable and independent of storage."""

import asyncio
import json
import logging
from datetime import UTC, datetime

import httpx
from pydantic import BaseModel, ConfigDict

from app.errors import APIError
from app.schemas.weather import WeatherForecast, WeatherHour

VARIABLES = {
    "temperature_2m": "temperature_c",
    "relative_humidity_2m": "relative_humidity_pct",
    "precipitation": "precipitation_mm",
    "wind_speed_10m": "wind_speed_kmh",
    "wind_direction_10m": "wind_direction_deg",
    "wind_gusts_10m": "wind_gust_kmh",
}


class ProviderResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)
    latitude: float
    longitude: float
    utc_offset_seconds: int
    hourly_units: dict[str, str]
    hourly: dict[str, list[float | int | None]]


def normalize(document, fetched_at):
    raw = ProviderResponse.model_validate(document)
    if raw.utc_offset_seconds != 0 or raw.hourly_units.get("time") != "unixtime":
        raise ValueError("Provider must return UTC epoch seconds")
    times = raw.hourly["time"]
    if not times or len(times) > 384:
        raise ValueError("Invalid hourly count")
    columns = {}
    for variable, field in VARIABLES.items():
        values = raw.hourly[variable]
        if len(values) != len(times):
            raise ValueError("Hourly arrays have different lengths")
        unit = raw.hourly_units[variable]
        if field == "temperature_c" and unit in {"°C", "°F"}:
            convert = (lambda v: (v - 32) * 5 / 9) if unit == "°F" else float
        elif field in {"wind_speed_kmh", "wind_gust_kmh"} and unit in {"km/h", "m/s", "mp/h", "kn"}:
            factor = {"km/h": 1, "m/s": 3.6, "mp/h": 1.609344, "kn": 1.852}[unit]

            def convert(v, factor=factor):
                return v * factor
        elif field == "precipitation_mm" and unit in {"mm", "inch"}:
            convert = (lambda v: v * 25.4) if unit == "inch" else float
        elif (field == "relative_humidity_pct" and unit == "%") or (
            field == "wind_direction_deg" and unit == "°"
        ):
            convert = float
        else:
            raise ValueError("Unsupported provider units")
        columns[field] = [None if v is None else convert(v) for v in values]
    hours = []
    for i, timestamp in enumerate(times):
        if timestamp is None or timestamp % 3600:
            raise ValueError("Unaligned provider timestamp")
        hours.append(
            WeatherHour(
                forecast_hour=datetime.fromtimestamp(timestamp, UTC),
                **{field: values[i] for field, values in columns.items()},
            )
        )
    return WeatherForecast(
        latitude=raw.latitude, longitude=raw.longitude, fetched_at=fetched_at, hours=hours
    )


class OpenMeteoProvider:
    def __init__(self, client: httpx.AsyncClient, settings):
        self.client, self.settings = client, settings

    async def fetch(self, points, now):
        if not 1 <= len(points) <= self.settings.weather_batch_size:
            raise ValueError("Invalid provider batch size")
        params = {
            "latitude": ",".join(str(p.latitude) for p in points),
            "longitude": ",".join(str(p.longitude) for p in points),
            "hourly": ",".join(VARIABLES),
            "timezone": "GMT",
            "timeformat": "unixtime",
            "forecast_hours": 169,
            "temperature_unit": "celsius",
            "wind_speed_unit": "kmh",
            "precipitation_unit": "mm",
        }
        for attempt in range(self.settings.provider_max_retries + 1):
            retry_after = 0
            try:
                response = await self.client.get(
                    "https://api.open-meteo.com/v1/forecast",
                    params=params,
                    timeout=self.settings.request_timeout_seconds,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    try:
                        retry_after = min(
                            5, max(0, float(response.headers.get("retry-after", "0")))
                        )
                    except ValueError:
                        pass
                    raise httpx.TransportError("Retryable provider response")
                response.raise_for_status()
                if len(response.content) > 8_000_000:
                    raise ValueError("Provider payload too large")
                payload = response.json()
                documents = payload if isinstance(payload, list) else [payload]
                if len(documents) != len(points):
                    raise ValueError("Missing batch locations")
                forecasts = [normalize(d, now) for d in documents]
                logging.getLogger("firewatch.weather").info(
                    json.dumps(
                        {
                            "source": "open-meteo",
                            "outcome": "success",
                            "locations": len(points),
                        }
                    )
                )
                return forecasts
            except (httpx.TransportError, httpx.TimeoutException):
                if attempt < self.settings.provider_max_retries:
                    await asyncio.sleep(max(retry_after, 0.25 * 2**attempt))
                    continue
            except (httpx.HTTPStatusError, ValueError, KeyError, TypeError, OverflowError):
                pass
            break
        logging.getLogger("firewatch.weather").warning(
            '{"source":"open-meteo","outcome":"unavailable"}'
        )
        raise APIError("weather_provider_unavailable", "Weather forecast provider unavailable", 503)
