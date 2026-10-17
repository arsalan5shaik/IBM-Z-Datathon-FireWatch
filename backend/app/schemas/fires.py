"""NASA observation records; confidence is a category, never a probability."""

from datetime import UTC, datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

FirmsSource = Literal["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
SOURCES = ("VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT")


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)

    id: str = Field(min_length=1, max_length=80)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    acquired_at: AwareDatetime
    source: FirmsSource
    satellite: Literal["NOAA-20", "NOAA-21"]
    instrument: Literal["VIIRS"] = "VIIRS"
    confidence: Literal["l", "n", "h"] | None = None
    frp: float | None = Field(default=None, ge=0)
    daynight: Literal["D", "N"] | None = None
    brightness: float | None = Field(default=None, ge=0)
    bright_ti5: float | None = Field(default=None, ge=0)
    scan: float | None = Field(default=None, gt=0)
    track: float | None = Field(default=None, gt=0)
    version: str | None = Field(default=None, max_length=40)

    @field_validator("acquired_at")
    @classmethod
    def to_utc(cls, value: datetime) -> datetime:
        return value.astimezone(UTC)


class SourceSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    boundary_filter: str = "unavailable"
    last_attempt: AwareDatetime
    fetched_at: AwareDatetime | None = None
    coverage_start: AwareDatetime | None = None
    last_error: str | None = None
    invalid_rows: int = Field(default=0, ge=0)
    duplicate_rows: int = Field(default=0, ge=0)
    outside_rows: int = Field(default=0, ge=0)
    records: list[Observation] = Field(default_factory=list)


class FireCacheDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    boundary_filter: str
    sources: dict[FirmsSource, SourceSnapshot]
