"""Explicitly mock fixture deployment helper; never used in production."""

import json
from pathlib import Path

from app.config import Settings
from app.main import create_app

EXAMPLES = Path(__file__).resolve().parents[2] / "shared/examples"


def mock_forecasts(directory, **overrides):
    directory.mkdir(parents=True, exist_ok=True)
    predictions = directory / "predictions"
    predictions.mkdir(exist_ok=True)
    grid = json.loads((EXAMPLES / "grid.mock.geojson").read_text())
    hour = json.loads((EXAMPLES / "forecast-hour.example.json").read_text())
    manifest = json.loads((EXAMPLES / "forecast-manifest.example.json").read_text())
    (directory / "grid.geojson").write_text(json.dumps(grid))
    (predictions / "20260308T0800Z.json").write_text(json.dumps(hour))
    (predictions / "manifest.json").write_text(json.dumps(manifest))
    settings = Settings(
        _env_file=None, shared_data_dir=directory, allow_fixture_data=True, **overrides
    )
    return create_app(settings), grid, hour, manifest
