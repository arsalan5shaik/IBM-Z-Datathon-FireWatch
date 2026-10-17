"""Normalized forecast weather; independent of any model feature contract."""

from datetime import datetime

from pydantic import Field, field_validator, model_validator

from app.schemas.forecast import Contract
from app.services.time import utc_hour


class WeatherHour(Contract):
    forecast_hour: datetime
    temperature_c: float | None = Field(ge=-100, le=70)
    relative_humidity_pct: float | None = Field(ge=0, le=100)
    precipitation_mm: float | None = Field(ge=0, le=2000)
    wind_speed_kmh: float | None = Field(ge=0, le=600)
    wind_direction_deg: float | None = Field(ge=0, le=360)
    wind_gust_kmh: float | None = Field(ge=0, le=600)

    @field_validator("forecast_hour")
    @classmethod
    def aligned(cls, value):
        return utc_hour(value)

    @property
    def complete(self):
        return all(getattr(self, field) is not None for field in type(self).model_fields)


class WeatherForecast(Contract):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    fetched_at: datetime
    hours: list[WeatherHour] = Field(min_length=1, max_length=384)

    @field_validator("fetched_at")
    @classmethod
    def aware(cls, value):
        if value.utcoffset() is None:
            raise ValueError("Timezone required")
        return value

    @model_validator(mode="after")
    def ordered(self):
        timestamps = [h.forecast_hour for h in self.hours]
        if timestamps != sorted(set(timestamps)):
            raise ValueError("Forecast timestamps must be sorted and unique")
        return self


class WeatherPoint(Contract):
    anchor_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    latitude: float = Field(ge=32, le=42.1)
    longitude: float = Field(ge=-125, le=-114)
