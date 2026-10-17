import platform
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request

from app.dependencies import get_runtime
from app.errors import APIError
from app.persistence.sqlite import read_job
from app.schemas.status import (
    ForecastStatus,
    HealthResponse,
    RuntimeState,
    SchedulerStatus,
    ServiceStatus,
    SubsystemStatus,
)

router = APIRouter(prefix="/api/v1", tags=["status"])
health_router = APIRouter(prefix="/health", tags=["health"])
Runtime = Annotated[RuntimeState, Depends(get_runtime)]


@router.get(
    "/status",
    response_model=ServiceStatus,
    summary="Service availability and validated data freshness",
    description=(
        "Reports validated forecast completeness, publication timestamps, freshness and job state. "
        "Fixtures remain labeled. No inference or ingestion runs on GET."
    ),
)
def status(request: Request, runtime: Runtime) -> ServiceStatus:
    settings = request.app.state.settings
    store = request.app.state.forecasts
    job = read_job(settings.sqlite_path)
    forecast = ForecastStatus(last_error=job.get("last_error"))
    data_mode = "unavailable"
    try:
        manifest, grid = store.snapshot()
        valid = 0
        error = None
        for hour in manifest.hours:
            try:
                artifact, _ = store.hour(manifest, grid, hour, [])
                valid += artifact._cell_count == len(grid.cells)
            except APIError:
                error = "forecast_artifact_invalid"
        stale = store.metadata(manifest)["stale"] or valid != 168
        data_mode = manifest.data_mode if valid else "unavailable"
        forecast = ForecastStatus(
            status="healthy"
            if valid == 168 and not stale
            else "degraded"
            if valid
            else "unavailable",
            stale=stale,
            last_success_at=manifest.published_at if valid else None,
            last_error=error or job.get("last_error"),
            next_run_at=job.get("next_run_at"),
            valid_hour_count=valid,
            missing_hour_count=168 - valid,
            **{
                field: getattr(manifest, field)
                for field in (
                    "active_window_start",
                    "active_window_end_exclusive",
                    "model_version",
                    "feature_version",
                    "grid_version",
                    "input_revision",
                )
            },
        )
    except APIError:
        pass
    return ServiceStatus(
        status="degraded" if runtime.ready else "unavailable",
        checked_at=datetime.now(UTC),
        started_at=runtime.started_at,
        runtime_arch=platform.machine(),
        api=SubsystemStatus(status="healthy" if runtime.ready else "unavailable", stale=False),
        data_mode=data_mode,
        forecast=forecast,
        scheduler=SchedulerStatus(
            enabled=settings.job_enabled,
            owner=settings.scheduler_owner,
            **{field: job.get(field) for field in ("last_success_at", "next_run_at", "last_error")},
        ),
        providers={
            name: SubsystemStatus() for name in ("firms", "weather", "incidents", "chatbot")
        } | {"weather": request.app.state.weather.status()},
    )


@health_router.get("/live", response_model=HealthResponse, summary="Process liveness")
def live() -> HealthResponse:
    return HealthResponse(status="alive")


@health_router.get(
    "/ready",
    response_model=HealthResponse,
    summary="API lifecycle readiness (forecast availability is separate)",
)
def ready(runtime: Runtime) -> HealthResponse:
    if not runtime.ready:
        raise HTTPException(status_code=503)
    return HealthResponse(status="ready")
