from datetime import datetime
from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator, model_validator

from app.services.time import utc_hour

Version = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")]
CellId = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Prediction(Contract):
    cell_id: CellId
    risk_score: float = Field(ge=0, le=1, strict=True)


class HourArtifact(Contract):
    _cell_count: int = PrivateAttr(default=0)
    schema_version: Literal["1.0"]
    data_mode: Literal["fixture", "live"]
    forecast_hour: datetime
    generated_at: datetime
    model_version: Version
    feature_version: Version
    input_revision: Version
    grid_version: Version
    grid_resolution_m: Literal[3000]
    score_type: Literal["relative_risk", "calibrated_probability"]
    target_type: Version
    predictions: list[Prediction] = Field(max_length=100000)

    @field_validator("forecast_hour", "generated_at", mode="before")
    @classmethod
    def timestamp_type(cls, value):
        if not isinstance(value, (str, datetime)):
            raise ValueError("ISO 8601 timestamp required")
        return value

    @field_validator("forecast_hour")
    @classmethod
    def aligned(cls, value):
        return utc_hour(value)

    @field_validator("generated_at")
    @classmethod
    def aware(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Timezone required")
        return value

    @model_validator(mode="after")
    def unique_cells(self):
        if len({p.cell_id for p in self.predictions}) != len(self.predictions):
            raise ValueError("Duplicate cell_id")
        return self


class Manifest(Contract):
    _recovered: bool = PrivateAttr(default=False)
    schema_version: Literal["1.0"]
    data_mode: Literal["fixture", "live"]
    active_window_start: datetime
    active_window_end_exclusive: datetime
    grid_version: Version
    model_version: Version
    feature_version: Version
    input_revision: Version
    hours: list[datetime] = Field(max_length=168)
    published_at: datetime
    # Optional immutable artifact references are introduced for safe revision publication.
    artifacts: dict[str, str] = Field(default_factory=dict)
    grid_artifact: str = "grid.geojson"
    boundary_artifact: str = "california.geojson"
    validated_cell_count: int | None = Field(default=None, ge=1, le=100000)

    @field_validator("grid_artifact", "boundary_artifact")
    @classmethod
    def safe_reference(cls, value):
        path = PurePosixPath(value)
        if not value or path.is_absolute() or ".." in path.parts or "\\" in value or ":" in value:
            raise ValueError("Artifact reference must stay inside its store")
        return value

    @field_validator(
        "active_window_start", "active_window_end_exclusive", "published_at", mode="before"
    )
    @classmethod
    def timestamp_type(cls, value):
        return HourArtifact.timestamp_type(value)

    @field_validator("active_window_start", "active_window_end_exclusive")
    @classmethod
    def aligned(cls, value):
        return utc_hour(value)

    @field_validator("published_at")
    @classmethod
    def aware(cls, value):
        return HourArtifact.aware(value)

    @model_validator(mode="after")
    def window(self):
        if (
            self.active_window_end_exclusive - self.active_window_start
        ).total_seconds() != 168 * 3600:
            raise ValueError("Window must contain exactly 168 hourly slots")
        hours = [utc_hour(hour) for hour in self.hours]
        if hours != sorted(set(hours)):
            raise ValueError("Hours must be sorted and unique")
        if any(not self.active_window_start <= h < self.active_window_end_exclusive for h in hours):
            raise ValueError("Hour outside manifest window")
        self.hours = hours
        canonical = {h.isoformat().replace("+00:00", "Z") for h in hours}
        if self.artifacts.keys() - canonical:
            raise ValueError("Artifact references must match listed canonical UTC hours")
        for value in self.artifacts.values():
            self.safe_reference(value)
        return self
