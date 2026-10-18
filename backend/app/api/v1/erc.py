"""Read-only experimental V6 daily ERC-G forecasts."""

import json
import math
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/v1/erc", tags=["experimental-erc-g"])

MODEL_VERSION = "firewatch_erc_v6_2023_2025"
MODEL_SHA256 = (
    "cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33"
)

FEATURES = (
    "temp_max_c", "rh_min_pct", "wind_mean_ms", "precip_mm",
    "elevation_mean_m", "lat", "lon", "day_sin", "day_cos",
    "precip_7d_mm", "precip_30d_mm", "temp_mean_7d_c",
    "rh_mean_7d_pct", "dry_days_14d", "wind_mean_7d_ms",
)


def load_snapshot(request: Request):
    directory = request.app.state.settings.shared_data_dir
    path = Path(directory) / "erc-v6" / "current.json"

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(
            status_code=503,
            detail="No valid ERC-G snapshot has been published",
        ) from None

    if (
        data.get("model_version") != MODEL_VERSION
        or data.get("model_sha256") != MODEL_SHA256
        or data.get("kind") not in (
            "experimental_stockton_weather_driven_erc_g_probe",
            "experimental_multicell_weather_driven_erc_g_probe",
        )
        or not data.get("snapshot_id")
    ):
        raise HTTPException(status_code=503, detail="Invalid model provenance")

    predictions = data.get("predictions")
    if not isinstance(predictions, list) or not predictions:
        raise HTTPException(status_code=503, detail="Missing predictions")

    seen = set()
    for row in predictions:
        key = (row.get("cell_id"), row.get("valid_date"))
        values = row.get("features")

        if (
            not all(isinstance(k, str) and k for k in key)
            or key in seen
            or row.get("data_status") != "ok"
            or not isinstance(values, dict)
            or tuple(values.keys()) != FEATURES
        ):
            raise HTTPException(status_code=503, detail="Invalid feature records")

        seen.add(key)

        for name in FEATURES:
            value = values[name]
            if (
                not isinstance(value, (float, int))
                or isinstance(value, bool)
                or not math.isfinite(value)
            ):
                raise HTTPException(status_code=503, detail="Invalid feature value")

        raw = row.get("erc_g_raw")
        displayed = row.get("erc_g_display")
        if (
            not isinstance(raw, (float, int))
            or not math.isfinite(raw)
            or not isinstance(displayed, (float, int))
            or not math.isfinite(displayed)
            or abs(displayed - max(0, raw)) > 1e-5
        ):
            raise HTTPException(status_code=503, detail="Invalid model score")

    return data


def metadata(data):
    return {
        "snapshot_id": data["snapshot_id"],
        "model_version": data["model_version"],
        "model_sha256": data["model_sha256"],
        "provider": data.get("provider"),
        "provider_issue_time_utc": data.get("provider_issue_time_utc"),
        "retrieved_at_utc": data.get("retrieved_at_utc"),
        "temporal_resolution": "daily",
        "metric": "ERC-G",
        "data_mode": "experimental_live_weather_probe",
        "publication_mode": data.get("publication_mode", "manual_probe_snapshot"),
        "forecast_skill_validated": False,
        "official_danger_categories": False,
        "prediction_count": len(data["predictions"]),
    }


@router.get("/metadata")
def get_metadata(request: Request):
    return metadata(load_snapshot(request))



@router.get("/points")
def get_forecast_points(request: Request, lead_day: int = 1):
    """Only published predictions; color is relative to current day's cell scores."""
    if not 1 <= lead_day <= 7:
        raise HTTPException(422, "lead_day must be 1 through 7")
    snapshot = load_snapshot(request)
    names = snapshot.get("cell_names") or {}
    points = []
    for row in snapshot["predictions"]:
        if row.get("lead_day") != lead_day:
            continue
        features = row["features"]
        lat, lon = features["lat"], features["lon"]
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        points.append({
            "cell_id": row["cell_id"],
            "location_name": names.get(row["cell_id"], row["cell_id"]),
            "latitude": lat,
            "longitude": lon,
            "forecast_days": 7,
            "valid_date": row["valid_date"],
            "erc_g_display": row["erc_g_display"],
        })
    values = [p["erc_g_display"] for p in points]
    return {
        "snapshot_id": snapshot["snapshot_id"],
        "model_version": snapshot["model_version"],
        "metric": "ERC-G",
        "coverage": "published_cells_only",
        "color_scale": "relative_across_forecasted_cells_not_danger_categories",
        "lead_day": lead_day,
        "min_score": min(values) if values else None,
        "max_score": max(values) if values else None,
        "points": points,
    }


@router.get("/cells/{cell_id}")
def get_cell(request: Request, cell_id: str):
    data = load_snapshot(request)
    predictions = [
        {
            "cell_id": row["cell_id"],
            "valid_date": row["valid_date"],
            "lead_day": row["lead_day"],
            "erc_g_raw": row["erc_g_raw"],
            "erc_g_display": row["erc_g_display"],
            "data_status": row["data_status"],
            "relative_erc_category": None,
            "category_status": "not_calibrated",
        }
        for row in data["predictions"]
        if row["cell_id"] == cell_id
    ]

    if not predictions:
        raise HTTPException(status_code=404, detail="Cell not in current snapshot")

    return {
        **metadata(data),
        "cell_id": cell_id,
        "location_name": (data.get("cell_names") or {}).get(cell_id),
        "predictions": sorted(predictions, key=lambda row: row["valid_date"]),
    }


@router.get("/cells/{cell_id}/explain")
def explain_cell(
    request: Request,
    cell_id: str,
    date: str,
    snapshot_id: str,
):
    """Serve verified TreeSHAP explanations for the published snapshot."""
    snapshot = load_snapshot(request)

    if snapshot["snapshot_id"] != snapshot_id:
        raise HTTPException(409, "Requested snapshot is not current")

    path = (
        Path(request.app.state.settings.shared_data_dir)
        / "erc-v6"
        / "explanations-current.json"
    )

    try:
        explanations = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(503, "SHAP explanations are not available") from None

    if (
        explanations.get("snapshot_id") != snapshot_id
        or explanations.get("model_sha256") != MODEL_SHA256
    ):
        raise HTTPException(503, "SHAP explanations are not current")

    for record in explanations.get("explanations", []):
        if (
            record.get("cell_id") == cell_id
            and record.get("valid_date") == date
            and record.get("snapshot_id") == snapshot_id
        ):
            return record

    raise HTTPException(404, "No explanation for requested cell/date")
