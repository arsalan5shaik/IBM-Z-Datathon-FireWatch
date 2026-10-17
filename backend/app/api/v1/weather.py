from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Query, Request

from app.api.v1.forecasts import hour_value
from app.errors import APIError
from app.schemas.geojson import FeatureCollection
from app.schemas.weather import WeatherHour
from app.services.grid import CA_BBOX, geometry_bounds
from app.services.grid import bbox as parse_bbox
from app.services.time import iso
from app.services.weather_cache import display_points, hour_revision, sample_point, selected_hour

router = APIRouter(prefix="/api/v1", tags=["weather"])


class WeatherResponse(WeatherHour):
    latitude: float
    longitude: float
    provider_latitude: float
    provider_longitude: float
    source: Literal["Open-Meteo"] = "Open-Meteo"
    data_kind: Literal["forecast"] = "forecast"
    fetched_at: datetime
    issued_at: None = None
    cache_status: Literal["fresh", "stale"]
    revision: str
    sampling: str = "Nearest 0.5-degree display anchor; not a 3 km weather pixel"


@router.get(
    "/weather",
    response_model=WeatherResponse,
    summary="Normalized forecast at a display sampling point; no inference",
)
async def weather(
    request: Request,
    hour: str = Query(min_length=20, max_length=40),
    latitude: float | None = Query(default=None, ge=32, le=42.1),
    longitude: float | None = Query(default=None, ge=-125, le=-114),
    cell_id: str | None = Query(default=None, max_length=80),
):
    timestamp = hour_value(hour)
    if cell_id is not None:
        if latitude is not None or longitude is not None:
            raise APIError("invalid_location", "Choose coordinates or cell_id", 422)
        _, grid = request.app.state.forecasts.snapshot()
        if cell_id not in grid.cells:
            raise APIError("cell_not_found", "Unknown grid cell", 404)
        west, south, east, north = geometry_bounds(grid.cells[cell_id])
        latitude, longitude = (south + north) / 2, (west + east) / 2
    if latitude is None or longitude is None:
        raise APIError("invalid_location", "Specify latitude/longitude or cell_id", 422)
    west, south, east, north = CA_BBOX
    if not (west <= longitude <= east and south <= latitude <= north):
        raise APIError("invalid_location", "Outside California bounding extent", 422)
    point = sample_point(latitude, longitude)
    [(entry, state)] = await request.app.state.weather.get([point])
    row = selected_hour(entry, timestamp)
    return row.model_dump() | {
        "latitude": point.latitude,
        "longitude": point.longitude,
        "provider_latitude": entry.forecast.latitude,
        "provider_longitude": entry.forecast.longitude,
        "fetched_at": entry.forecast.fetched_at,
        "cache_status": state,
        "revision": hour_revision(point, row),
    }


@router.get(
    "/wind",
    response_model=FeatureCollection,
    summary="Cached hourly forecast wind/weather samples; direction is FROM north",
)
async def wind(
    request: Request,
    bbox: str = Query(max_length=100),
    hour: str = Query(min_length=20, max_length=40),
    density: Literal["low", "medium", "high"] = "medium",
):
    timestamp = hour_value(hour)
    try:
        bounds = parse_bbox(bbox)
    except ValueError:
        raise APIError("invalid_bbox", "Invalid or excessive WGS84 bbox", 422) from None
    west, south, east, north = CA_BBOX
    if bounds[0] < west or bounds[1] < south or bounds[2] > east or bounds[3] > north:
        raise APIError("invalid_bbox", "Use a bbox inside the California bounding extent", 422)
    points = display_points(bounds)
    if density == "low":
        points = points[::2]
    entries = await request.app.state.weather.get(points)
    features, missing, fetched, stale = [], [], [], False
    for entry, state in entries:
        fetched.append(entry.forecast.fetched_at)
        stale = stale or state == "stale"
        try:
            row = selected_hour(entry, timestamp)
        except APIError:
            missing.append(entry.point.anchor_id)
            continue
        features.append(
            {
                "type": "Feature",
                "id": entry.point.anchor_id,
                "geometry": {
                    "type": "Point",
                    "coordinates": [entry.point.longitude, entry.point.latitude],
                },
                "properties": row.model_dump(mode="json")
                | {
                    "source": "Open-Meteo",
                    "fetched_at": iso(entry.forecast.fetched_at),
                    "cache_status": state,
                    "revision": hour_revision(entry.point, row),
                    "data_kind": "forecast",
                },
            }
        )
    if not features:
        raise APIError(
            "weather_hour_unavailable", "No complete weather samples at requested hour", 404
        )
    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "source": "Open-Meteo",
            "data_kind": "forecast",
            "forecast_hour": iso(timestamp),
            "fetched_at": iso(min(fetched)),
            "generated_at": iso(min(fetched)),
            "issued_at": None,
            "cache_status": "stale" if stale else "fresh",
            "stale": stale,
            "missing_anchor_ids": missing,
            "complete": not missing,
            "sampling": "0.5-degree display lattice; provider elevation downscaling",
            "wind_direction_convention": "FROM north; add 180 degrees for arrows toward flow",
            "provider_model": "best_match",
            "provider_native_resolution": "variable",
            "returned_points": len(features),
            "truncated": False,
        },
    }
