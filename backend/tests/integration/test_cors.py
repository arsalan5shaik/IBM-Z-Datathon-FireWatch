from fastapi.testclient import TestClient


def test_allowed_and_denied_origins(client):
    allowed = client.get("/api/v1/status", headers={"Origin": "http://localhost:5173"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-credentials" not in allowed.headers
    assert "X-Request-ID" in allowed.headers["access-control-expose-headers"]
    denied = client.get("/api/v1/status", headers={"Origin": "https://untrusted.example"})
    assert "access-control-allow-origin" not in denied.headers


def test_preflight(client):
    headers = {"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"}
    response = client.options("/api/v1/status", headers=headers)
    assert response.status_code == 200
    assert "x-request-id" in response.headers
    headers["Origin"] = "https://untrusted.example"
    denied = client.options("/api/v1/status", headers=headers)
    assert denied.status_code == 400
    assert denied.json()["error"]["code"] == "cors_denied"


def test_errors_keep_cors_headers(app):
    @app.get("/failure")
    def failure():
        raise ValueError("sensitive")

    with TestClient(app) as client:
        for path in ("/missing", "/failure"):
            result = client.get(path, headers={"Origin": "http://localhost:5173"})
            assert result.headers["access-control-allow-origin"] == "http://localhost:5173"
