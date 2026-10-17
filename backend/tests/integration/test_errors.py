import json
import logging
from uuid import UUID

import pytest
from fastapi import Query
from fastapi.testclient import TestClient
from pydantic import BaseModel


class PrivatePayload(BaseModel):
    count: int


@pytest.mark.parametrize(
    ("method", "path", "status", "code"),
    [("get", "/absent", 404, "not_found"), ("post", "/api/v1/status", 405, "method_not_allowed")],
)
def test_routing_errors(client, method, path, status, code):
    response = getattr(client, method)(path)
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert response.json()["error"]["details"] == {}
    UUID(response.headers["x-request-id"])


def test_validation_and_unexpected_errors_are_redacted(app, caplog):
    @app.post("/test-validation")
    def validation(payload: PrivatePayload):
        return payload

    @app.get("/test-error")
    def failing():
        raise RuntimeError("secret-value-from-provider-url")

    @app.get("/test-query")
    def query(count: int = Query(ge=1)):
        return count

    with caplog.at_level(logging.INFO, logger="firewatch"), TestClient(app) as client:
        invalid = client.post("/test-validation", json={"count": "secret-user-input"})
        malformed = client.post(
            "/test-validation",
            content='{"count":secret-malformed',
            headers={"Content-Type": "application/json"},
        )
        invalid_query = client.get("/test-query?count=secret-query")
        failed = client.get("/test-error?key=secret-query")
        unknown = client.get("/secret-path?key=secret-query")
        for response in (invalid, malformed, invalid_query):
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "validation_error"
        assert failed.status_code == 500
        assert failed.json() == {
            "error": {
                "code": "internal_error",
                "message": "Internal server error",
                "details": {},
            }
        }
        for response in (invalid, malformed, invalid_query, failed, unknown):
            assert "secret-" not in response.text
        request_logs = [r for r in caplog.records if r.name == "firewatch.requests"]
        assert len(request_logs) == 5
        assert all("secret-" not in r.getMessage() for r in request_logs)
        assert json.loads(request_logs[-2].message)["status"] == 500


def test_request_ids_are_server_generated(client):
    first = client.get("/health/live", headers={"X-Request-ID": "untrusted-secret"})
    second = client.get("/health/live")
    assert first.headers["x-request-id"] != second.headers["x-request-id"]
    assert first.headers["x-request-id"] != "untrusted-secret"
