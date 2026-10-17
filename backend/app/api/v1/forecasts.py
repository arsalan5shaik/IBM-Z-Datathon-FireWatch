from datetime import date as Date
from datetime import datetime, timedelta

from fastapi import APIRouter, Query, Request

from app.errors import APIError
from app.schemas.geojson import FeatureCollection
from app.services.forecast_store import category
from app.services.grid import bbox as parse_bbox
from app.services.time import day_hours, iso, utc_hour

router = APIRouter(prefix="/api/v1/forecasts", tags=["forecasts"])


def hour_value(text):
    try:
        return utc_hour(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        raise APIError(
            "invalid_hour", "Hour must be an aware, aligned ISO 8601 timestamp", 422
        ) from None


@router.get(
    "/risk",
    response_model=FeatureCollection,
    summary="BBox-filtered 3 km risk; exactly one UTC hour or California date",
)
def risk(
    request: Request,
    bbox: str = Query(max_length=100),
    hour: str | None = None,
    date: Date | None = None,
    aggregation: str = "max_hourly_risk",
):
    if (hour is None) == (date is None):
        raise APIError("invalid_time_selection", "Specify exactly one of hour or date", 422)
    if aggregation not in {"max_hourly_risk", "mean_hourly_risk"}:
        raise APIError("invalid_aggregation", "Unknown risk-index aggregation", 422)
    try:
        bounds = parse_bbox(bbox)
    except ValueError:
        raise APIError("invalid_bbox", "Invalid or excessive WGS84 bbox", 422) from None
    store = request.app.state.forecasts
    manifest, grid = store.snapshot()
    try:
        cells = grid.query(bounds, store.settings.max_response_cells)
    except ValueError:
        raise APIError(
            "response_too_large", "Use a smaller bbox; results are not truncated", 422
        ) from None
    expected = [hour_value(hour)] if hour else day_hours(date)
    selected = [h for h in expected if h in manifest.hours]
    if not selected:
        raise APIError("forecast_hour_unavailable", "No forecast hours in requested selection", 404)
    scores = {cell: [] for cell in cells}
    generated = []
    score_type = target_type = None
    for timestamp in selected:
        artifact, values = store.hour(manifest, grid, timestamp)
        if score_type and (
            score_type != artifact.score_type or target_type != artifact.target_type
        ):
            raise APIError("forecast_artifact_invalid", "Mixed score/target semantics")
        score_type, target_type = artifact.score_type, artifact.target_type
        generated.append(iso(artifact.generated_at))
        for cell in cells:
            if cell in values:
                scores[cell].append(values[cell])
    features = []
    for cell, values in scores.items():
        score = (
            (max(values) if aggregation == "max_hourly_risk" else sum(values) / len(values))
            if values
            else None
        )
        properties = {
            "cell_id": cell,
            "risk_score": score,
            "risk_category": category(score),
            "score_type": score_type,
            "target_type": target_type,
            "coverage_hours": len(values),
            "missing_hours": len(expected) - len(values),
            "partial_day": bool(date and len(values) != len(expected)),
        }
        properties["forecast_date" if date else "forecast_hour"] = (
            str(date) if date else iso(expected[0])
        )
        features.append(
            {"type": "Feature", "id": cell, "geometry": grid.cells[cell], "properties": properties}
        )
    metadata = store.metadata(manifest) | {
        "aggregation": aggregation if date else None,
        "aggregation_is_probability": False,
        "timezone": "America/Los_Angeles" if date else "UTC",
        "expected_hours": len(expected),
        "coverage_hours": len(selected),
        "partial_day": bool(date and len(selected) != len(expected)),
        "incomplete_cells": sum(len(v) != len(expected) for v in scores.values()),
        "generated_at_min": min(generated),
        "generated_at_max": max(generated),
        "returned_cells": len(cells),
        "truncated": False,
    }
    return {"type": "FeatureCollection", "metadata": metadata, "features": features}


@router.get("/cell/{cell_id}", summary="Up to 168 UTC values with explicit missing slots")
def history(request: Request, cell_id: str, start: str | None = None, end: str | None = None):
    store = request.app.state.forecasts
    manifest, grid = store.snapshot()
    if cell_id not in grid.cells:
        raise APIError("cell_not_found", "Unknown grid cell", 404)
    first = hour_value(start) if start else manifest.active_window_start
    stop = hour_value(end) if end else manifest.active_window_end_exclusive
    if not manifest.active_window_start <= first < stop <= manifest.active_window_end_exclusive:
        raise APIError(
            "invalid_window", "Range must be inside the 168-hour window; end is exclusive", 422
        )
    values = []
    while first < stop:
        record = {"forecast_hour": iso(first), "risk_score": None, "missing": True}
        if first in manifest.hours:
            artifact, scores = store.hour(manifest, grid, first)
            record |= {
                "risk_score": scores.get(cell_id),
                "missing": cell_id not in scores,
                "score_type": artifact.score_type,
                "target_type": artifact.target_type,
                "generated_at": iso(artifact.generated_at),
            }
        values.append(record)
        first += timedelta(hours=1)
    return {"cell_id": cell_id, "metadata": store.metadata(manifest), "hours": values}
