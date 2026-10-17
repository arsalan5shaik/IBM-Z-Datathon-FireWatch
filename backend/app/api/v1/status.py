import platform
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_runtime
from app.schemas.status import HealthResponse, RuntimeState, ServiceStatus, SubsystemStatus

router = APIRouter(prefix="/api/v1", tags=["status"])
health_router = APIRouter(prefix="/health", tags=["health"])
Runtime = Annotated[RuntimeState, Depends(get_runtime)]


@router.get(
    "/status",
    response_model=ServiceStatus,
    summary="Service availability and validated data freshness",
    description=(
        "Foundation reports unavailable data, null source timestamps and 168 missing hours. "
        "Provider keys do not imply ingestion success. No inference or ingestion runs on GET."
    ),
)
def status(runtime: Runtime) -> ServiceStatus:
    return ServiceStatus(
        status="degraded" if runtime.ready else "unavailable",
        checked_at=datetime.now(UTC),
        started_at=runtime.started_at,
        runtime_arch=platform.machine(),
        api=SubsystemStatus(status="healthy" if runtime.ready else "unavailable", stale=False),
        providers={
            name: SubsystemStatus() for name in ("firms", "weather", "incidents", "chatbot")
        },
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
