import logging
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import httpx
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException

from app.api.v1.chat import router as chat_router
from app.api.v1.fires import router as fires_router
from app.api.v1.forecasts import router as forecast_router
from app.api.v1.locations import router as locations_router
from app.api.v1.status import health_router, router
from app.api.v1.weather import router as weather_router
from app.config import Settings
from app.errors import (
    APIError,
    RequestContextMiddleware,
    RestrictedCORSMiddleware,
    SafeErrorsMiddleware,
    api_error,
    http_error,
    validation_error,
)
from app.schemas.errors import ERROR_RESPONSES
from app.schemas.status import RuntimeState
from app.services.chat_access import ChatLimits
from app.services.chat_service import ChatService
from app.services.fire_cache import FireCache
from app.services.forecast_store import ForecastStore
from app.services.locations import LocationStore
from app.services.weather_cache import WeatherCache
from app.services.weather_provider import OpenMeteoProvider


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = httpx.AsyncClient(follow_redirects=False)
        if app.state.weather is None:
            app.state.weather = WeatherCache(OpenMeteoProvider(client, settings), settings)
        logger = logging.getLogger("firewatch")
        if not logger.handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
        logger.setLevel(settings.log_level)
        app.state.runtime.started_at = datetime.now(UTC)
        app.state.runtime.ready = True
        try:
            yield
        finally:
            app.state.runtime.ready = False
            await client.aclose()
            await app.state.chat.close()

    app = FastAPI(
        title="FireWatch API",
        version="0.1.0",
        description=(
            "California wildfire intelligence. Experimental risk is distinct from satellite "
            "observations and official incidents. Serves validated hourly forecast artifacts; "
            "fixture data is explicitly labeled. GET requests never trigger inference."
        ),
        lifespan=lifespan,
        responses=ERROR_RESPONSES,
    )
    app.state.settings = settings
    app.state.runtime = RuntimeState()
    app.state.forecasts = ForecastStore(settings)
    app.state.locations = LocationStore(settings.locations_data_dir)
    app.state.fires = FireCache(settings)
    app.state.weather = None
    app.state.chat = ChatService(app.state)
    app.state.chat_limits = ChatLimits(settings)
    app.add_exception_handler(APIError, api_error)
    app.add_exception_handler(HTTPException, http_error)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_middleware(SafeErrorsMiddleware)
    app.add_middleware(
        RestrictedCORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        expose_headers=["X-Request-ID"],
    )
    app.add_middleware(RequestContextMiddleware)
    app.include_router(router)
    app.include_router(health_router)
    app.include_router(forecast_router)
    app.include_router(fires_router)
    app.include_router(weather_router)
    app.include_router(locations_router)
    app.include_router(chat_router)
    return app
