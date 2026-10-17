from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field

Availability = Literal["healthy", "degraded", "unavailable"]


class SubsystemStatus(BaseModel):
    status: Availability = "unavailable"
    stale: bool = True
    last_success_at: AwareDatetime | None = None
    source_observed_at: AwareDatetime | None = None
    last_error: str | None = None


class ForecastStatus(SubsystemStatus):
    active_window_start: AwareDatetime | None = None
    active_window_end_exclusive: AwareDatetime | None = None
    valid_hour_count: int = Field(default=0, ge=0, le=168)
    missing_hour_count: int = Field(default=168, ge=0, le=168)
    model_version: str | None = None
    feature_version: str | None = None
    grid_version: str | None = None
    input_revision: str | None = None
    next_run_at: AwareDatetime | None = None


class SchedulerStatus(BaseModel):
    enabled: Literal[False] = False
    owner: Literal["unassigned"] = "unassigned"
    last_success_at: AwareDatetime | None = None
    next_run_at: AwareDatetime | None = None
    last_error: str | None = None


class ServiceStatus(BaseModel):
    status: Availability
    api_version: Literal["v1"] = "v1"
    service_version: Literal["0.1.0"] = "0.1.0"
    checked_at: AwareDatetime
    started_at: AwareDatetime | None
    runtime_arch: str
    data_mode: Literal["unavailable"] = "unavailable"
    api: SubsystemStatus
    forecast: ForecastStatus = Field(default_factory=ForecastStatus)
    providers: dict[str, SubsystemStatus]
    scheduler: SchedulerStatus = Field(default_factory=SchedulerStatus)


class HealthResponse(BaseModel):
    status: Literal["alive", "ready"]


class RuntimeState:
    """Process lifecycle only; data readiness is reported independently."""

    def __init__(self) -> None:
        self.ready = False
        self.started_at: datetime | None = None
