"""Single-owner, manifest-last rolling forecast publication.

Run: python -m app.jobs.roll_window --revision path/to/revision.json
The generator is ML-owned and receives a JSON request; GETs never call it.
"""

import argparse
import hashlib
import json
import shutil
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from app.config import Settings
from app.persistence.atomic import atomic_json, single_owner
from app.persistence.sqlite import record_job
from app.schemas.forecast import Contract, HourArtifact, Manifest, Version
from app.services.grid import Grid
from app.services.jsonio import read_json
from app.services.prediction_adapter import CLIAdapter
from app.services.score_index import build_index, index_path, read_index
from app.services.time import iso, next_hour


class Revision(Contract):
    data_mode: Literal["fixture", "live"]
    grid_version: Version
    model_version: Version
    feature_version: Version
    input_revision: Version
    score_type: Literal["relative_risk", "calibrated_probability"]
    target_type: Version


def digest(document):
    return hashlib.sha256(
        json.dumps(document, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def validated(path, hour, revision, grid):
    artifact = HourArtifact.model_validate(read_json(path))
    check_revision(artifact, hour, revision)
    if {p.cell_id for p in artifact.predictions} != grid.cells.keys():
        raise ValueError("Incomplete or unexpected grid cells")
    return artifact


def check_revision(artifact, hour, revision):
    if artifact.forecast_hour != hour:
        raise ValueError("Wrong forecast hour")
    for field in Revision.model_fields:
        if getattr(artifact, field) != getattr(revision, field):
            raise ValueError("Revision mismatch")


def safe_path(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError("Artifact path outside store")
    return path


class Roller:
    def __init__(self, settings, adapter=None, hook=None):
        self.settings = settings
        self.adapter = adapter or CLIAdapter(settings)
        self.hook = hook or (lambda phase: None)
        self.root = settings.shared_data_dir
        self.predictions = self.root / "predictions"

    def run(self, revision, now=None):
        if not self.settings.job_enabled or self.settings.scheduler_owner != "backend":
            raise ValueError("Backend does not own the enabled schedule")
        if revision.data_mode == "fixture" and not self.settings.allow_fixture_data:
            raise ValueError("Fixture mode not enabled")
        now = now or datetime.now(UTC)
        if now.utcoffset() is None:
            raise ValueError("Timezone required")
        now = now.astimezone(UTC)
        start = next_hour(now)
        self.predictions.mkdir(parents=True, exist_ok=True)
        with single_owner(self.predictions / ".scheduler.lock"):
            try:
                result = self._run(revision, now, start)
            except Exception:
                record_job(
                    self.settings.sqlite_path,
                    "forecast",
                    iso(now),
                    iso(start),
                    False,
                    "forecast_rollover_failed",
                )
                raise
            record_job(self.settings.sqlite_path, "forecast", iso(now), iso(start), True, None)
            return result

    def _run(self, revision, now, start):
        if shutil.disk_usage(self.predictions).free < self.settings.min_free_disk_mb * 1_000_000:
            raise OSError("Insufficient disk space for safe publication")
        grid_doc = read_json(self.root / "grid.geojson")
        boundary_path = self.root / "california.geojson"
        boundary = read_json(boundary_path)["geometry"] if boundary_path.exists() else None
        grid = Grid(grid_doc, boundary)
        if grid.version != revision.grid_version or grid.mode != revision.data_mode:
            raise ValueError("Grid/revision mismatch")
        grid_name = f"grids/{digest(grid_doc)}.geojson"
        grid_path = self.root / grid_name
        if not grid_path.exists():
            atomic_json(grid_path, grid_doc)
        boundary_name = "california.geojson"
        if boundary is not None:
            boundary_doc = {"type": "Feature", "geometry": boundary, "properties": {}}
            boundary_name = f"grids/boundary-{digest(boundary_doc)}.geojson"
            atomic_json(self.root / boundary_name, boundary_doc)
        previous = None
        for name in ("manifest.json", "manifest.previous.json"):
            try:
                previous = Manifest.model_validate(read_json(self.predictions / name))
                break
            except (OSError, ValueError):
                continue
        same_grid = False
        previous_healthy = False
        if previous:
            try:
                same_grid = digest(
                    read_json(safe_path(self.root, previous.grid_artifact))
                ) == digest(grid_doc)
                # Never overwrite the backup with a manifest referencing damaged data.
                previous_healthy = self.healthy(previous)
            except (OSError, ValueError, KeyError, TypeError):
                pass
        wanted = [start + timedelta(hours=i) for i in range(168)]
        references = {}
        missing = []
        for hour in wanted:
            if previous and same_grid and hour in previous.hours:
                relative = previous.artifacts.get(iso(hour), hour.strftime("%Y%m%dT%H00Z.json"))
                try:
                    path = safe_path(self.predictions, relative)
                    indexed = read_index(path, [])
                    if indexed is not None and relative.startswith("objects/"):
                        artifact, _, count = indexed
                        check_revision(artifact, hour, revision)
                        if count != len(grid.cells):
                            raise ValueError("Incomplete indexed cells")
                        references[iso(hour)] = relative
                        continue
                    artifact = validated(path, hour, revision, grid)
                    # Migrate legacy mutable hour names to immutable content-addressed copies.
                    name = f"objects/{digest(artifact.model_dump(mode='json'))}.json"
                    if not (self.predictions / name).exists():
                        atomic_json(self.predictions / name, artifact.model_dump(mode="json"))
                    if read_index(self.predictions / name, []) is None:
                        build_index(self.predictions / name, artifact)
                    references[iso(hour)] = name
                    continue
                except (OSError, ValueError):
                    pass
            missing.append(hour)
        current_path = self.predictions / "manifest.json"
        current_matches = False
        try:
            current_matches = Manifest.model_validate(read_json(current_path)) == previous
        except (OSError, ValueError):
            pass
        if (
            not missing
            and previous
            and current_matches
            and previous.active_window_start == start
            and previous.artifacts == references
            and previous.grid_artifact == grid_name
            and previous.boundary_artifact == boundary_name
        ):
            return {"generated_hours": 0, "reused_hours": 168, "published": False}
        if missing:
            with tempfile.TemporaryDirectory(prefix=".generation-", dir=self.predictions) as name:
                outputs = self.adapter.generate(missing, revision, Path(name))
                if set(outputs) != set(missing):
                    raise ValueError("Generator did not produce requested hours")
                for hour in missing:
                    artifact = validated(outputs[hour], hour, revision, grid)
                    payload = artifact.model_dump(mode="json")
                    relative = f"objects/{digest(payload)}.json"
                    atomic_json(self.predictions / relative, payload)
                    build_index(self.predictions / relative, artifact)
                    references[iso(hour)] = relative
                    self.hook("artifact_published")
        manifest = Manifest(
            schema_version="1.0",
            data_mode=revision.data_mode,
            active_window_start=start,
            active_window_end_exclusive=start + timedelta(hours=168),
            grid_version=revision.grid_version,
            model_version=revision.model_version,
            feature_version=revision.feature_version,
            input_revision=revision.input_revision,
            hours=wanted,
            artifacts=references,
            published_at=now,
            grid_artifact=grid_name,
            validated_cell_count=len(grid.cells),
            boundary_artifact=boundary_name,
        )
        self.hook("before_manifest")
        if previous and previous_healthy:
            atomic_json(
                self.predictions / "manifest.previous.json", previous.model_dump(mode="json")
            )
        atomic_json(self.predictions / "manifest.json", manifest.model_dump(mode="json"))
        self.hook("after_manifest")
        try:
            backup = Manifest.model_validate(read_json(self.predictions / "manifest.previous.json"))
        except (OSError, ValueError):
            backup = None
        self.prune(manifest, backup, now)
        return {
            "generated_hours": len(missing),
            "reused_hours": 168 - len(missing),
            "published": True,
        }

    def prune(self, current, previous, now):
        protected = set(current.artifacts.values()) | set(
            previous.artifacts.values() if previous else ()
        )
        cutoff = now.timestamp() - self.settings.forecast_retention_hours * 3600
        # Only delete our immutable files after success + grace, preserving both manifests.
        for path in (self.predictions / "objects").glob("*.json"):
            relative = path.relative_to(self.predictions).as_posix()
            if relative not in protected and path.stat().st_mtime < cutoff:
                path.unlink()
                index_path(path).unlink(missing_ok=True)
        protected_grids = {current.grid_artifact, current.boundary_artifact}
        if previous:
            protected_grids.update((previous.grid_artifact, previous.boundary_artifact))
        for path in (self.root / "grids").glob("*.geojson"):
            if (
                path.relative_to(self.root).as_posix() not in protected_grids
                and path.stat().st_mtime < cutoff
            ):
                path.unlink()
        # Runs hold the scheduler lock. Remove only expired, private staging
        # directories inside this store; never follow a link outside the root.
        for path in self.predictions.glob(".generation-*"):
            resolved = path.resolve()
            if (
                path.is_dir()
                and not path.is_symlink()
                and resolved.is_relative_to(self.predictions.resolve())
                and path.stat().st_mtime < cutoff
            ):
                shutil.rmtree(resolved)

    def healthy(self, manifest):
        old_grid_doc = read_json(safe_path(self.root, manifest.grid_artifact))
        boundary_path = safe_path(self.root, manifest.boundary_artifact)
        boundary = read_json(boundary_path)["geometry"] if boundary_path.exists() else None
        old_grid = Grid(old_grid_doc, boundary)
        if old_grid.version != manifest.grid_version or old_grid.mode != manifest.data_mode:
            return False
        for hour in manifest.hours:
            name = manifest.artifacts.get(iso(hour), hour.strftime("%Y%m%dT%H00Z.json"))
            path = safe_path(self.predictions, name)
            indexed = read_index(path, [])
            if indexed is not None:
                artifact, _, count = indexed
                if count != len(old_grid.cells):
                    return False
            else:
                artifact = HourArtifact.model_validate(read_json(path))
                if {p.cell_id for p in artifact.predictions} != old_grid.cells.keys():
                    return False
            revision = Revision(
                **{field: getattr(artifact, field) for field in Revision.model_fields}
            )
            for field in (
                "model_version",
                "feature_version",
                "input_revision",
                "grid_version",
                "data_mode",
            ):
                if getattr(revision, field) != getattr(manifest, field):
                    return False
            check_revision(artifact, hour, revision)
        return bool(manifest.hours)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = Roller(Settings()).run(Revision.model_validate(read_json(args.revision)))
        print(json.dumps({"job": "forecast", "outcome": "success", **result}))
    except Exception:
        print(
            json.dumps(
                {"job": "forecast", "outcome": "failed", "error": "forecast_rollover_failed"}
            )
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
