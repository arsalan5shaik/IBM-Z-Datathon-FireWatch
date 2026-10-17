from pydantic import BaseModel, Field


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict[str, object] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    error: ErrorDetail


ERROR_RESPONSES = {
    code: {"model": ErrorResponse, "description": description}
    for code, description in {
        404: "Resource not found",
        405: "Method not allowed",
        422: "Request validation failed",
        500: "Unexpected internal error; use X-Request-ID for support",
        503: "Service not ready",
    }.items()
}
