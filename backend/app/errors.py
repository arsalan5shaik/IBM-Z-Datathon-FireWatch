"""Safe errors and request logs: never log raw paths, queries, bodies or exceptions."""

import json
import logging
from http import HTTPStatus
from time import perf_counter
from uuid import uuid4

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("firewatch.requests")


class APIError(Exception):
    def __init__(self, code: str, message: str, status: int = 503, details: dict | None = None):
        self.code, self.message, self.status, self.details = code, message, status, details


async def api_error(request: Request, exc: APIError):
    return error_response(exc.code, exc.message, exc.status, exc.details)


class RestrictedCORSMiddleware(CORSMiddleware):
    def preflight_response(self, request_headers: Headers):
        response = super().preflight_response(request_headers)
        if response.status_code < 400:
            return response
        error = error_response("cors_denied", "Cross-origin request not allowed", 400)
        for name, value in response.headers.items():
            if name.startswith("access-control-") or name == "vary":
                error.headers[name] = value
        return error


def error_response(code: str, message: str, status: int, details: dict | None = None):
    return JSONResponse(
        {"error": {"code": code, "message": message, "details": details or {}}},
        status_code=status,
    )


async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
    codes = {404: "not_found", 405: "method_not_allowed", 503: "service_not_ready"}
    response = error_response(
        codes.get(exc.status_code, "http_error"),
        HTTPStatus(exc.status_code).phrase,
        exc.status_code,
    )
    # Preserve routing protocol headers without echoing arbitrary exception headers.
    if exc.headers and "Allow" in exc.headers:
        response.headers["Allow"] = exc.headers["Allow"]
    return response


async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Pydantic errors can contain raw input, secret values, dynamic keys and exception context.
    return error_response(
        "validation_error", "Request validation failed", 422, {"error_count": len(exc.errors())}
    )


class SafeErrorsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def track_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, track_send)
        except Exception:
            if started:
                # Do not expose the original error through server exception logging.
                raise RuntimeError("Response failed after headers were sent") from None
            await error_response("internal_error", "Internal server error", 500)(
                scope, receive, send
            )


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid4().hex  # Do not trust or log client-supplied request IDs.
        scope.setdefault("state", {})["request_id"] = request_id
        started = perf_counter()
        status = 500

        async def response_send(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", request_id.encode("ascii")))
                headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, response_send)
        finally:
            route = scope.get("route")
            logger.info(
                json.dumps(
                    {
                        "event": "http_request",
                        "request_id": request_id,
                        "route": getattr(route, "path", "unmatched"),
                        "status": status,
                        "elapsed_ms": round((perf_counter() - started) * 1000, 2),
                    }
                )
            )
