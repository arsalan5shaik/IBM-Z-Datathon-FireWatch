"""One atomic shared snapshot, one refresh owner; map GETs never contact NASA."""

import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta

from pydantic import ValidationError

from app.config import Settings
from app.errors import APIError
from app.persistence.atomic import JobLocked, atomic_json, single_owner
from app.schemas.fires import FireCacheDocument, SourceSnapshot
from app.schemas.geojson import Feature, FeatureCollection
from app.schemas.status import FirmsStatus
from app.services.grid import CA_BBOX, contains, geometry_bounds, polygons
from app.services.nasa_firms import FirmsClient, ProviderError


def utc(value):
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


class FireCache:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.path = settings.shared_data_dir / "provider-cache" / "firms.json"
        self._signature = None
        self._document = None

    @property
    def configured(self):
        key = self.settings.nasa_firms_map_key or self.settings.firms_map_key
        return bool(key and key.get_secret_value().strip())

    def read(self):
        try:
            stat = self.path.stat()
            signature = (stat.st_mtime_ns, stat.st_size)
            if signature == self._signature:
                return self._document
            if stat.st_size > 2 * self.settings.firms_max_rows * 1500 + 10000:
                return None
            document = FireCacheDocument.model_validate_json(self.path.read_bytes())
            if any(
                len(item.records) > self.settings.firms_max_rows
                for item in document.sources.values()
            ):
                return None
            for source, item in document.sources.items():
                if any(record.source != source for record in item.records):
                    return None
            self._signature, self._document = signature, document
            return document
        except (OSError, ValueError, ValidationError):
            return None

    def boundary(self):
        path = self.settings.firms_boundary_path
        if not path.exists():
            return [], "coverage_rectangle_only; California boundary unavailable"
        try:
            if path.stat().st_size > 2_000_000:
                raise ValueError("Boundary too large")
            payload = path.read_bytes()
            data = json.loads(payload)
            # Existing frontend file is the Census-derived California FeatureCollection.
            geometries = [feature["geometry"] for feature in data["features"]]
            parts = []
            for geometry in geometries:
                for polygon in polygons(geometry):
                    shape = {"type": "Polygon", "coordinates": polygon}
                    bounds = geometry_bounds(shape, validate=False)
                    parts.append((bounds, shape))
            if not parts:
                raise ValueError("Empty boundary")
            return parts, "california_boundary_sha256:" + hashlib.sha256(payload).hexdigest()
        except (OSError, ValueError, KeyError, TypeError):
            raise ProviderError("boundary_invalid") from None

    async def refresh(self, *, now=None, client=None, force=False):
        """Independently callable job; does not start a second forecast scheduler."""
        now = now or datetime.now(UTC)
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("Refresh time must be UTC-aware")
        now = now.astimezone(UTC)
        try:
            with single_owner(self.path.with_suffix(".lock")):
                document = self.read()
                document = (
                    document.model_copy(deep=True)
                    if document
                    else FireCacheDocument(boundary_filter="unavailable", sources={})
                )
                # Persisted throttle applies across CLI invocations and API worker processes.
                attempts = [item.last_attempt for item in document.sources.values()]
                if (
                    not force
                    and attempts
                    and now - max(attempts) < timedelta(minutes=self.settings.firms_refresh_minutes)
                ):
                    return "not_due"
                boundary_error = None
                try:
                    parts, label = self.boundary()
                except ProviderError as exc:
                    parts, label, boundary_error = [], document.boundary_filter, exc.category
                document.boundary_filter = label
                document.sources = {
                    key: value
                    for key, value in document.sources.items()
                    if key in self.settings.firms_sources
                }
                for source in self.settings.firms_sources:
                    previous = document.sources.get(source)
                    if previous:
                        previous.last_attempt = now
                    else:
                        document.sources[source] = SourceSnapshot(last_attempt=now)
                atomic_json(self.path, document.model_dump(mode="json"))
                self._signature = None

                async def update(provider, source):
                    previous = document.sources[source]
                    try:
                        if boundary_error:
                            raise ProviderError(boundary_error)
                        records, counts, start = await provider.fetch(source, now)
                        if parts:
                            filtered = []
                            for record in records:
                                point = (record.longitude, record.latitude)
                                if any(
                                    bounds[0] <= point[0] <= bounds[2]
                                    and bounds[1] <= point[1] <= bounds[3]
                                    and contains(shape, point)
                                    for bounds, shape in parts
                                ):
                                    filtered.append(record)
                            counts["outside_rows"] += len(records) - len(filtered)
                            records = filtered
                        return source, SourceSnapshot(
                            boundary_filter=label,
                            last_attempt=now,
                            fetched_at=now,
                            coverage_start=start,
                            records=records,
                            **counts,
                        )
                    except ProviderError as exc:
                        previous.last_error = exc.category
                        return source, previous

                async def collect(provider):
                    results = await asyncio.gather(
                        *(update(provider, source) for source in self.settings.firms_sources)
                    )
                    document.sources.update(results)

                if client is None:
                    async with FirmsClient(self.settings) as provider:
                        await collect(provider)
                else:
                    await collect(client)
                atomic_json(self.path, document.model_dump(mode="json"))
                self._signature = None
                return "refreshed"
        except JobLocked:
            return "locked"

    def metadata(self, document, now):
        states = {source: document.sources.get(source) for source in self.settings.firms_sources}
        usable = [state for state in states.values() if state and state.fetched_at]
        errors = {
            source: state.last_error if state else "source_not_cached"
            for source, state in states.items()
            if state is None or state.last_error or state.fetched_at is None
        }
        # The oldest product fetch determines full-product freshness, including partial failure.
        success = min((state.fetched_at for state in usable), default=None)
        age = max(0, (now - success).total_seconds()) if success else None
        stale = (
            bool(errors)
            or len(usable) != len(states)
            or age is None
            or age > self.settings.firms_refresh_minutes * 60
            or success > now
        )
        boundary_mismatch = any(
            state.boundary_filter != document.boundary_filter for state in usable
        )
        stale = stale or boundary_mismatch
        observed = [record.acquired_at for state in usable for record in state.records]
        return {
            "provider": "NASA_FIRMS",
            "source": "NASA FIRMS",
            "data_mode": "live" if usable else "unavailable",
            "observation_type": (
                "Satellite-detected hotspots (thermal anomalies); not confirmed wildfires"
            ),
            "not_fire_perimeter": True,
            "configured": self.configured,
            "cache_status": "stale" if stale and usable else "fresh" if usable else "unavailable",
            "stale": stale,
            "partial_boundary_coverage": boundary_mismatch,
            "partial_observations": any(state.invalid_rows for state in usable),
            "partial_sources": len(usable) != len(states) or bool(errors),
            "last_attempted_refresh": utc(
                max((state.last_attempt for state in states.values() if state), default=None)
            ),
            "last_successful_refresh": utc(success),
            "last_success_at": utc(success),
            "fetched_at": utc(success),
            "cache_age_seconds": age,
            "observation_start": utc(min(observed, default=None)),
            "observation_end": utc(max(observed, default=None)),
            "record_count": sum(len(state.records) for state in usable),
            "refresh_errors": errors,
            "refresh_minutes": self.settings.firms_refresh_minutes,
            "coverage_bbox": list(CA_BBOX),
            "boundary_filter": document.boundary_filter,
            "units": {
                "frp": "MW",
                "brightness": "K",
                "bright_ti5": "K",
                "scan": "km",
                "track": "km",
            },
            "confidence_categories": {"l": "low", "n": "nominal", "h": "high"},
            "sources": {
                source: state.model_dump(mode="json", exclude={"records"}) if state else None
                for source, state in states.items()
            },
        }

    def status(self, now=None):
        now = now or datetime.now(UTC)
        document = self.read()
        if document is None:
            return FirmsStatus(
                configured=self.configured,
                last_error="cache_unavailable" if self.configured else "credentials_missing",
            )
        metadata = self.metadata(document, now)
        return FirmsStatus(
            configured=self.configured,
            cache_status=metadata["cache_status"],
            last_attempted_refresh=metadata["last_attempted_refresh"],
            status="unavailable"
            if metadata["cache_status"] == "unavailable"
            else "degraded"
            if metadata["stale"]
            else "healthy",
            stale=metadata["stale"],
            last_success_at=metadata["last_success_at"],
            source_observed_at=metadata["observation_end"],
            last_error=next(
                (error for error in metadata["refresh_errors"].values() if error), None
            ),
        )

    def query(self, bounds, start, limit, *, now=None):
        now = now or datetime.now(UTC)
        document = self.read()
        metadata = self.metadata(document, now) if document else None
        if not metadata or metadata["cache_status"] == "unavailable":
            raise APIError(
                "firms_unavailable",
                "Satellite observations unavailable; this does not mean no fires",
                503,
                details={
                    "configured": self.configured,
                    "refresh_errors": metadata["refresh_errors"] if metadata else {},
                },
            )
        records = [
            record
            for source in self.settings.firms_sources
            for record in (document.sources[source].records if source in document.sources else [])
            if start <= record.acquired_at <= now
            and bounds[0] <= record.longitude <= bounds[2]
            and bounds[1] <= record.latitude <= bounds[3]
        ]
        records.sort(key=lambda item: (-item.acquired_at.timestamp(), item.id))
        coverage = [
            state.coverage_start
            for source, state in document.sources.items()
            if source in self.settings.firms_sources and state.fetched_at
        ]
        metadata.update(
            {
                "requested_hours": (now - start).total_seconds() / 3600,
                "requested_since": utc(start),
                "requested_bbox": list(bounds),
                "returned_count": min(len(records), limit),
                "matched_count": len(records),
                "limit": limit,
                "truncated": len(records) > limit,
                "partial_time_coverage": any(value is None or start < value for value in coverage),
                "coverage_end": metadata["last_successful_refresh"],
            }
        )
        features = []
        for record in records[:limit]:
            properties = record.model_dump(mode="json", exclude={"latitude", "longitude", "source"})
            properties.update(
                {"source": "NASA_FIRMS", "product": record.source, "frp_mw": record.frp}
            )
            features.append(
                Feature(
                    id=record.id,
                    geometry={"type": "Point", "coordinates": [record.longitude, record.latitude]},
                    properties=properties,
                )
            )
        return FeatureCollection(metadata=metadata, features=features)
