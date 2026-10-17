"""Cache-first batched forecast retrieval and stable input partition revisions."""

import asyncio
import hashlib
import json
import math
from collections import OrderedDict
from datetime import UTC, datetime, timedelta

from app.errors import APIError
from app.persistence.atomic import JobLocked, atomic_json, single_owner
from app.schemas.forecast import Contract
from app.schemas.weather import WeatherForecast, WeatherPoint
from app.services.jsonio import read_json
from app.services.time import iso


def revision(value):
    return (
        "weather-"
        + hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        ).hexdigest()
    )


def hour_revision(point, hour):
    return revision({"point": point.model_dump(), "hour": hour.model_dump(mode="json")})


def sample_point(latitude, longitude):
    lat, lon = math.floor(latitude * 2 + 0.5) / 2, math.floor(longitude * 2 + 0.5) / 2
    return WeatherPoint(
        anchor_id=f"display_{int(lat * 2)}_{int(-lon * 2)}", latitude=lat, longitude=lon
    )


def display_points(bounds):
    west, south, east, north = bounds
    return [
        sample_point(y / 2, x / 2)
        for y in range(math.ceil(south * 2), math.floor(north * 2) + 1)
        for x in range(math.ceil(west * 2), math.floor(east * 2) + 1)
    ]


class Entry(Contract):
    point: WeatherPoint
    forecast: WeatherForecast


class WeatherCache:
    def __init__(self, provider, settings, clock=None):
        self.provider, self.settings = provider, settings
        self.clock = clock or (lambda: datetime.now(UTC))
        self.path = settings.shared_data_dir / "provider-cache/weather-v1.json"
        self.entries = OrderedDict()
        self.lock = asyncio.Lock()
        self.last_error = None
        self.retry_at = None
        self.changed_partitions = []
        self.file_stamp = None
        self.reload()

    def reload(self):
        if self.path.exists():
            try:
                stamp = (self.path.stat().st_mtime_ns, self.path.stat().st_size)
                if stamp == self.file_stamp:
                    return
                document = read_json(self.path)
                if (
                    document["schema_version"] != "1.0"
                    or len(document["entries"]) > self.settings.weather_max_anchors
                ):
                    raise ValueError("Invalid weather cache")
                loaded = OrderedDict()
                for value in document["entries"]:
                    entry = Entry.model_validate(value)
                    loaded[entry.point.anchor_id] = entry
                if len(loaded) != len(document["entries"]):
                    raise ValueError("Duplicate cache anchors")
                self.entries, self.file_stamp = loaded, stamp
                self.last_error = self.retry_at = None
            except (OSError, ValueError, KeyError, TypeError):
                self.last_error = "weather_cache_invalid"

    def state(self, entry, now=None):
        now = now or self.clock()
        age = (now - entry.forecast.fetched_at).total_seconds()
        if age < -60 or age > self.settings.weather_stale_hours * 3600:
            return "unavailable"
        same_hour = now.replace(minute=0, second=0, microsecond=0) == (
            entry.forecast.fetched_at.replace(minute=0, second=0, microsecond=0)
        )
        return (
            "fresh" if same_hour and age < self.settings.weather_refresh_minutes * 60 else "stale"
        )

    async def get(self, points):
        if not points or len(points) > self.settings.weather_max_anchors:
            raise APIError("weather_region_too_large", "No sampling points or too many points", 422)
        if len({p.anchor_id for p in points}) != len(points):
            raise ValueError("Duplicate sampling points")
        async with self.lock:
            self.reload()
            now = self.clock()
            needed = []
            for point in points:
                entry = self.entries.get(point.anchor_id)
                if entry and entry.point != point:
                    raise APIError(
                        "weather_mapping_conflict", "Anchor ID has changed coordinates", 422
                    )
                if not entry or self.state(entry, now) != "fresh":
                    needed.append(point)
            if needed and (self.retry_at is None or now >= self.retry_at):
                owner = single_owner(self.path.with_suffix(".lock"))
                acquired = False
                try:
                    owner.__enter__()
                    acquired = True
                    self.reload()
                    needed = [
                        p
                        for p in points
                        if p.anchor_id not in self.entries
                        or self.state(self.entries[p.anchor_id], now) != "fresh"
                    ]
                    candidates = []
                    # Bounded batches and two in-flight HTTP requests at most.
                    size = self.settings.weather_batch_size
                    batches = [needed[i : i + size] for i in range(0, len(needed), size)]
                    async with asyncio.timeout(self.settings.weather_refresh_timeout_seconds):
                        for i in range(0, len(batches), 2):
                            groups = await asyncio.gather(
                                *(self.provider.fetch(batch, now) for batch in batches[i : i + 2])
                            )
                            for batch, forecasts in zip(batches[i : i + 2], groups, strict=True):
                                if len(batch) != len(forecasts):
                                    raise ValueError("Incomplete provider batch")
                                candidates.extend(
                                    Entry(point=p, forecast=f)
                                    for p, f in zip(batch, forecasts, strict=True)
                                )
                    changed = []
                    for candidate in candidates:
                        old = self.entries.get(candidate.point.anchor_id)
                        old_hours = {h.forecast_hour: h for h in old.forecast.hours} if old else {}
                        new_hours = {h.forecast_hour: h for h in candidate.forecast.hours}
                        # A partial refresh may not replace still-valid cached hours.
                        for hour, value in old_hours.items():
                            if (
                                hour >= now.replace(minute=0, second=0, microsecond=0)
                                and value.complete
                                and (hour not in new_hours or not new_hours[hour].complete)
                            ):
                                raise ValueError("Refresh loses valid cached data")
                        for hour, value in new_hours.items():
                            if hour not in old_hours or old_hours[hour] != value:
                                changed.append(f"{candidate.point.anchor_id}/{iso(hour)}")
                    updated = self.entries.copy()
                    for candidate in candidates:
                        updated[candidate.point.anchor_id] = candidate
                        updated.move_to_end(candidate.point.anchor_id)
                    for point in points:
                        if point.anchor_id in updated:
                            updated.move_to_end(point.anchor_id)
                    while len(updated) > self.settings.weather_max_anchors:
                        updated.popitem(last=False)
                    document = {
                        "schema_version": "1.0",
                        "entries": [e.model_dump(mode="json") for e in updated.values()],
                    }
                    if len(json.dumps(document).encode()) > 32_000_000:
                        raise ValueError("Weather cache exceeds storage budget")
                    publication = asyncio.create_task(
                        asyncio.to_thread(atomic_json, self.path, document)
                    )
                    try:
                        await asyncio.shield(publication)
                    except asyncio.CancelledError:
                        await publication  # Keep the process lock until publication finishes.
                        raise
                    self.entries = updated
                    self.file_stamp = (self.path.stat().st_mtime_ns, self.path.stat().st_size)
                    self.changed_partitions = changed
                    self.last_error = self.retry_at = None
                except (APIError, OSError, ValueError, TimeoutError, JobLocked):
                    self.last_error = "weather_refresh_failed"
                    self.retry_at = now + timedelta(minutes=1)
                finally:
                    if acquired:
                        owner.__exit__(None, None, None)
            result = []
            for point in points:
                entry = self.entries.get(point.anchor_id)
                if not entry or self.state(entry, now) == "unavailable":
                    raise APIError("weather_unavailable", "No usable weather forecast cache", 503)
                self.entries.move_to_end(point.anchor_id)
                result.append((entry, "stale" if self.last_error else self.state(entry, now)))
            return result

    def status(self):
        from app.schemas.status import SubsystemStatus

        usable = [e for e in list(self.entries.values()) if self.state(e) != "unavailable"]
        if not usable:
            return SubsystemStatus(last_error=self.last_error)
        stale = bool(self.last_error) or any(self.state(e) != "fresh" for e in usable)
        return SubsystemStatus(
            status="degraded" if stale else "healthy",
            stale=stale,
            last_success_at=max(e.forecast.fetched_at for e in usable),
            last_error=self.last_error,
        )


def selected_hour(entry, hour):
    row = next((h for h in entry.forecast.hours if h.forecast_hour == hour), None)
    if row is None or not row.complete:
        raise APIError(
            "weather_hour_unavailable", "Requested forecast hour has missing weather inputs", 404
        )
    return row
