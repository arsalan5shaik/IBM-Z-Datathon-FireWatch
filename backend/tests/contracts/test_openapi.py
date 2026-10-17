from app.schemas.status import ServiceStatus


def test_status_matches_declared_model(client):
    data = client.get("/api/v1/status").json()
    ServiceStatus.model_validate(data)


def test_documented_routes_and_error_contract(client):
    schema = client.get("/openapi.json").json()
    assert {"/api/v1/status", "/health/live", "/health/ready"} <= set(schema["paths"])
    responses = schema["paths"]["/api/v1/status"]["get"]["responses"]
    assert responses["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/ServiceStatus"
    )
    for code in ("404", "422", "500", "503"):
        assert responses[code]["content"]["application/json"]["schema"]["$ref"].endswith(
            "/ErrorResponse"
        )


def test_documented_example_is_valid_and_not_a_forecast(client):
    schema = client.get("/openapi.json").json()
    example = schema["components"]["schemas"]["ServiceStatus"]["examples"][0]
    model = ServiceStatus.model_validate(example)
    assert model.data_mode == "unavailable"
    assert model.forecast.model_version is None
    assert model.forecast.valid_hour_count == 0
