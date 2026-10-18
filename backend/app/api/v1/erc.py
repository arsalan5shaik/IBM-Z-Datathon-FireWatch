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
        or data.get("kind") != "experimental_stockton_weather_driven_erc_g_probe"
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
        "publication_mode": "manual_probe_snapshot",
        "forecast_skill_validated": False,
        "official_danger_categories": False,
        "prediction_count": len(data["predictions"]),
    }


@router.get("/metadata")
def get_metadata(request: Request):
    return metadata(load_snapshot(request))


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
        "predictions": sorted(predictions, key=lambda row: row["valid_date"]),
    }


@router.get("/cells/{cell_id}/explain")
def explain_cell(
    request: Request,
    cell_id: str,
    date: str,
    snapshot_id: str,
):
    """Explain the raw V6 ERC-G prediction for one stored cell/day."""
    from functools import lru_cache

    import numpy as np
    import xgboost as xgb

    @lru_cache(maxsize=1)
    def load_model():
        model_path = (
            request.app.state.settings.repo_root
            / "ml-prep/models/releases/firewatch_erc_v6_2023_2025/model.json"
        )

        digest = __import__("hashlib").sha256(model_path.read_bytes()).hexdigest()
        if digest != MODEL_SHA256:
            raise HTTPException(503, "Frozen V6 model checksum mismatch")

        model = xgb.Booster()
        model.load_model(str(model_path))
        return model

    data = load_snapshot(request)

    if data["snapshot_id"] != snapshot_id:
        raise HTTPException(409, "Requested snapshot is not current")

    record = next(
        (
            row for row in data["predictions"]
            if row["cell_id"] == cell_id and row["valid_date"] == date
        ),
        None,
    )

    if record is None:
        raise HTTPException(404, "No prediction for requested cell/date")

    features = record["features"]
    values = np.array([[features[name] for name in FEATURES]], dtype=np.float32)

    model = load_model()
    matrix = xgb.DMatrix(values, feature_names=list(FEATURES))

    raw = float(model.predict(matrix)[0])
    contributions = model.predict(matrix, pred_contribs=True)[0]

    baseline = float(contributions[-1])
    shap_values = contributions[:-1]

    additivity_error = abs(baseline + float(shap_values.sum()) - raw)

    if abs(raw - record["erc_g_raw"]) > 1e-3 or additivity_error > 1e-3:
        raise HTTPException(503, "Model prediction/SHAP verification failed")

    return {
        "snapshot_id": snapshot_id,
        "cell_id": cell_id,
        "valid_date": date,
        "metric": "ERC-G",
        "model_version": MODEL_VERSION,
        "prediction_raw": raw,
        "prediction_display": max(0.0, raw),
        "baseline": baseline,
        "features": [
            {
                "name": name,
                "value": features[name],
                "shap_value": float(shap_values[i]),
            }
            for i, name in enumerate(FEATURES)
        ],
        "additivity_error": additivity_error,
        "data_status": "ok",
        "explanation_type": "TreeSHAP",
        "forecast_skill_validated": False,
    }
