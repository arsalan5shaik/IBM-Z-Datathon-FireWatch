"""Precompute TreeSHAP for the currently published V6 snapshot."""

import hashlib
import json
import os
import tempfile
from pathlib import Path

import numpy as np
import xgboost as xgb

ROOT = Path("/home/linux1/IBM-Z-Datathon-FireWatch")
DATA = ROOT / "shared/data/erc-v6"
MODEL = ROOT / "ml-prep/models/releases/firewatch_erc_v6_2023_2025/model.json"
EXPECTED_SHA = "cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33"

snapshot_bytes = (DATA / "current.json").read_bytes()
snapshot = json.loads(snapshot_bytes)

assert hashlib.sha256(MODEL.read_bytes()).hexdigest() == EXPECTED_SHA
assert snapshot["model_sha256"] == EXPECTED_SHA

booster = xgb.Booster()
booster.load_model(str(MODEL))

from app.api.v1.erc import FEATURES

results = []

for row in snapshot["predictions"]:
    values = np.array(
        [[row["features"][name] for name in FEATURES]],
        dtype=np.float32,
    )

    matrix = xgb.DMatrix(values, feature_names=list(FEATURES))
    prediction = float(booster.predict(matrix)[0])
    contributions = booster.predict(matrix, pred_contribs=True)[0]

    baseline = float(contributions[-1])
    shap_values = contributions[:-1]
    error = abs(baseline + float(shap_values.sum()) - prediction)

    if abs(prediction - row["erc_g_raw"]) > 1e-3 or error > 1e-3:
        raise RuntimeError("SHAP/model verification failed")

    results.append({
        "snapshot_id": snapshot["snapshot_id"],
        "cell_id": row["cell_id"],
        "valid_date": row["valid_date"],
        "metric": "ERC-G",
        "model_version": snapshot["model_version"],
        "prediction_raw": prediction,
        "prediction_display": max(0.0, prediction),
        "baseline": baseline,
        "features": [
            {
                "name": name,
                "value": row["features"][name],
                "shap_value": float(shap_values[i]),
            }
            for i, name in enumerate(FEATURES)
        ],
        "additivity_error": error,
        "data_status": "ok",
        "explanation_type": "TreeSHAP",
        "forecast_skill_validated": False,
    })

# Never publish explanations belonging to a superseded forecast.
if (DATA / "current.json").read_bytes() != snapshot_bytes:
    raise RuntimeError("Snapshot changed during SHAP generation; retry")

output = {
    "snapshot_id": snapshot["snapshot_id"],
    "model_sha256": EXPECTED_SHA,
    "explanations": results,
}

fd, temporary = tempfile.mkstemp(
    prefix=".shap-",
    suffix=".json",
    dir=DATA,
)

try:
    with os.fdopen(fd, "w") as handle:
        json.dump(output, handle, separators=(",", ":"), allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())

    os.chmod(temporary, 0o644)
    os.replace(temporary, DATA / "explanations-current.json")
except BaseException:
    Path(temporary).unlink(missing_ok=True)
    raise

print("SHAP PUBLISHED")
print("Snapshot:", output["snapshot_id"])
print("Explanations:", len(results))
print("Max additivity error:", max(x["additivity_error"] for x in results))
