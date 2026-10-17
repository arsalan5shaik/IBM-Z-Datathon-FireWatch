from pydantic import BaseModel, ConfigDict, Field


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict[str, object] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "examples": [{"error": {"code": "not_found", "message": "Not Found", "details": {}}}]
        }
    )
    error: ErrorDetail


ERROR_RESPONSES = {
    code: {"model": ErrorResponse, "description": description}
    for code, description in {
        400: "Invalid request or disallowed CORS preflight",
        404: "Resource not found",
        405: "Method not allowed",
        422: "Request validation failed",
        500: "Unexpected internal error; use X-Request-ID for support",
        503: "Service not ready",
    }.items()
}
