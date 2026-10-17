"""Export proposed shared schemas from the same models used by the backend."""

import json
from pathlib import Path

from app.schemas.forecast import HourArtifact, Manifest

if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2] / "shared/schemas"
    root.mkdir(parents=True, exist_ok=True)
    for name, model in (("forecast-hour.v1", HourArtifact), ("forecast-manifest.v1", Manifest)):
        schema = model.model_json_schema() | {
            "$schema": "https://json-schema.org/draft/2020-12/schema"
        }
        (root / f"{name}.schema.json").write_text(
            json.dumps(schema, indent=2) + "\n", encoding="utf-8"
        )
