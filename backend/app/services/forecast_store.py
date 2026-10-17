from collections import OrderedDict
from datetime import UTC, datetime
from threading import RLock

from app.errors import APIError
from app.schemas.forecast import HourArtifact, Manifest
from app.services.grid import Grid
from app.services.jsonio import read_json
from app.services.time import iso


class ForecastStore:
    def __init__(self, settings):
        self.settings = settings
        self.directory = settings.shared_data_dir
        self.grid = None
        self.grid_stamp = None
        self.cache = OrderedDict()
        self.lock = RLock()

    def snapshot(self):
        with self.lock:
            try:
                manifest = Manifest.model_validate(
                    read_json(self.directory / "predictions/manifest.json")
                )
                path = self.directory / "grid.geojson"
                stamp = (path.stat().st_mtime_ns, path.stat().st_size)
                if self.grid is None or stamp != self.grid_stamp:
                    boundary_path = self.directory / "california.geojson"
                    boundary = (
                        read_json(boundary_path)["geometry"] if boundary_path.exists() else None
                    )
                    grid = Grid(read_json(path), boundary)
                    self.grid, self.grid_stamp = grid, stamp
                    self.cache.clear()
                if (
                    manifest.grid_version != self.grid.version
                    or manifest.data_mode != self.grid.mode
                ):
                    raise ValueError("Manifest/grid mismatch")
                if manifest.data_mode == "fixture" and not self.settings.allow_fixture_data:
                    raise ValueError("Fixture mode not enabled")
                return manifest, self.grid
            except (OSError, ValueError, KeyError, TypeError):
                raise APIError(
                    "forecast_not_ready", "Validated forecast artifacts are unavailable"
                ) from None

    def artifact_path(self, manifest, hour):
        name = manifest.artifacts.get(iso(hour), hour.strftime("%Y%m%dT%H00Z.json"))
        root = (self.directory / "predictions").resolve()
        path = (root / name).resolve()
        if not path.is_relative_to(root) or path == root or path.suffix != ".json":
            raise ValueError("Invalid artifact reference")
        return path

    def hour(self, manifest, grid, hour):
        if hour not in manifest.hours:
            raise APIError("forecast_hour_unavailable", "Requested hour is unavailable", 404)
        with self.lock:
            try:
                path = self.artifact_path(manifest, hour)
                info = path.stat()
                key = (str(path), info.st_mtime_ns, info.st_size)
                if key in self.cache:
                    artifact, values = self.cache.pop(key)
                else:
                    artifact = HourArtifact.model_validate(read_json(path))
                    values = {p.cell_id: p.risk_score for p in artifact.predictions}
                for field in (
                    "grid_version",
                    "model_version",
                    "feature_version",
                    "input_revision",
                    "data_mode",
                ):
                    if getattr(artifact, field) != getattr(manifest, field):
                        raise ValueError("Artifact/manifest mismatch")
                if artifact.forecast_hour != hour or values.keys() - grid.cells.keys():
                    raise ValueError("Unexpected hour or grid cells")
                self.cache[key] = artifact, values
                while len(self.cache) > self.settings.forecast_cache_hours:
                    self.cache.popitem(last=False)
                return artifact, values
            except (OSError, ValueError, KeyError, TypeError):
                raise APIError(
                    "forecast_artifact_invalid", "Forecast artifact failed validation"
                ) from None

    @staticmethod
    def metadata(manifest):
        return {
            "data_mode": manifest.data_mode,
            "source": "mock_fixture" if manifest.data_mode == "fixture" else "ml_artifact",
            "published_at": iso(manifest.published_at),
            "active_window_start": iso(manifest.active_window_start),
            "active_window_end_exclusive": iso(manifest.active_window_end_exclusive),
            "model_version": manifest.model_version,
            "feature_version": manifest.feature_version,
            "input_revision": manifest.input_revision,
            "grid_version": manifest.grid_version,
            "grid_resolution_m": 3000,
            "stale": datetime.now(UTC) >= manifest.active_window_start,
            "risk_categories": {"low": [0, 0.4], "elevated": [0.4, 0.7], "high": [0.7, 1]},
            "risk_colors": {"low": "orange", "elevated": "red", "high": "purple"},
        }


def category(score):
    return (
        "unavailable"
        if score is None
        else "high"
        if score >= 0.7
        else "elevated"
        if score >= 0.4
        else "low"
    )
