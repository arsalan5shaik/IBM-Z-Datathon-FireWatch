from fastapi import Request

from app.config import Settings
from app.schemas.status import RuntimeState


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_runtime(request: Request) -> RuntimeState:
    return request.app.state.runtime
