"""Proposed normalized weather transport. This is NOT a model feature adapter."""

from datetime import datetime, timedelta
from typing import Literal

from pydantic import Field, field_validator, model_validator

from app.errors import APIError
from app.schemas.forecast import Contract, Version
from app.schemas.weather import WeatherHour, WeatherPoint
from app.services.time import iso, utc_hour
from app.services.weather_cache import revision, selected_hour


class WeatherSampling(Contract):
    schema_version: Literal["proposed-weather-1"]
    data_mode: Literal["fixture", "live"]
    grid_version: Version
    points: list[WeatherPoint] = Field(min_length=1, max_length=2000)
    cell_to_anchor: dict[str, str] = Field(min_length=1, max_length=100000)

    @model_validator(mode="after")
    def references(self):
        ids = {p.anchor_id for p in self.points}
        if len(ids) != len(self.points) or set(self.cell_to_anchor.values()) != ids:
            raise ValueError("Anchor IDs must be unique and exactly referenced by cells")
        return self


class WeatherPartition(Contract):
    revision: Version
    inputs: dict[str, WeatherHour]


class ProposedWeatherInputs(Contract):
    schema_version: Literal["proposed-weather-1"] = "proposed-weather-1"
    model_contract_status: Literal["unconfirmed"] = "unconfirmed"
    source: Literal["Open-Meteo"] = "Open-Meteo"
    data_mode: Literal["fixture", "live"]
    grid_version: Version
    mapping_revision: Version
    window_start: datetime
    forecast_hours: Literal[168] = 168
    fetched_at: datetime
    cell_to_anchor: dict[str, str]
    points: list[WeatherPoint]
    partitions: dict[str, WeatherPartition] = Field(min_length=168, max_length=168)

    @field_validator("window_start")
    @classmethod
    def aligned(cls, value):
        return utc_hour(value)

    @model_validator(mode="after")
    def complete_window(self):
        expected = {iso(self.window_start + timedelta(hours=i)) for i in range(168)}
        if set(self.partitions) != expected:
            raise ValueError("Exactly 168 absolute UTC hours required")
        for key, partition in self.partitions.items():
            if set(partition.inputs) != {p.anchor_id for p in self.points}:
                raise ValueError("Incomplete anchor inputs")
            if any(
                not h.complete or iso(h.forecast_hour) != key for h in partition.inputs.values()
            ):
                raise ValueError("Missing or mismatched weather hour")
        return self


async def prepare_inputs(cache, mapping: WeatherSampling, grid, start):
    start = utc_hour(start)
    if (
        mapping.grid_version != grid.version
        or mapping.data_mode != grid.mode
        or mapping.cell_to_anchor.keys() != grid.cells.keys()
    ):
        raise APIError(
            "weather_grid_mismatch", "Sampling map must cover the authoritative grid", 422
        )
    entries = await cache.get(mapping.points)
    if any(state != "fresh" for _, state in entries):
        raise APIError("weather_inputs_stale", "Fresh weather inputs required for inference", 503)
    mapping_revision = revision(mapping.model_dump(mode="json"))
    partitions = {}
    for i in range(168):
        hour = start + timedelta(hours=i)
        inputs = {entry.point.anchor_id: selected_hour(entry, hour) for entry, _ in entries}
        fingerprint = revision(
            {
                "mapping": mapping_revision,
                "inputs": {key: row.model_dump(mode="json") for key, row in inputs.items()},
            }
        )
        partitions[iso(hour)] = WeatherPartition(revision=fingerprint, inputs=inputs)
    return ProposedWeatherInputs(
        data_mode=mapping.data_mode,
        grid_version=grid.version,
        mapping_revision=mapping_revision,
        window_start=start,
        fetched_at=min(e.forecast.fetched_at for e, _ in entries),
        cell_to_anchor=mapping.cell_to_anchor,
        points=mapping.points,
        partitions=partitions,
    )
