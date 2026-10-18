"""Local reference routing keeps the normal API safeguards; no paid calls."""

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app
from app.services.chat_reference import SOURCES
from app.services.chat_service import ChatService
from tests.unit.test_chat import DATA, NOW, MockResponses, request, run


@pytest.fixture
def local_chat(tmp_path):
    settings = Settings(
        _env_file=None,
        repo_root=tmp_path,
        locations_data_dir=DATA,
        openai_api_key=None,
        llm_api_key=None,
    )
    app = create_app(settings)
    model = MockResponses()
    model.key = None
    app.state.chat = ChatService(app.state, model, lambda: NOW)
    return app, model


@pytest.mark.parametrize("configured_key", [False, True])
@pytest.mark.parametrize(
    "question,expected",
    [
        ("What is fire radiative power (FRP)?", "megawatts (MW)"),
        ("What does nominal VIIRS confidence mean?", "does not mean low"),
        (
            "What's the difference between a satellite hotspot and a confirmed wildfire?",
            "not a confirmed wildfire",
        ),
    ],
)
def test_reference_http_without_or_with_key(local_chat, configured_key, question, expected):
    app, model = local_chat
    if configured_key:
        model.key = SecretStr("fixture-only-key")
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000)) as client:
        response = client.post("/api/v1/chat", json={"message": question})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "reference" and body["model"] is None
    assert expected in body["answer"]
    assert body["tools_used"] == ["firewatch_reference"]
    assert body["sources"]
    for source in body["sources"]:
        assert source["kind"] == "reference"
        assert source["url"] == SOURCES[source["id"]]["url"]
        assert source["url"] in body["answer"]
        assert "not fetched live" in source["freshness"]
    assert model.calls == []


def test_reference_service_without_key_with_selected_location(local_chat):
    app, model = local_chat
    result = run(app.state.chat.answer(request("Explain FRP and nominal VIIRS confidence.")))
    assert result.mode == "reference" and result.model is None
    assert "megawatts (MW)" in result.answer and "does not mean low" in result.answer
    assert model.calls == []


@pytest.mark.parametrize(
    "question",
    [
        "What is the weather in Stockton?",
        "What caused the Camp Fire?",
        "What is FRP and what is the wind today?",
        "What is the FRP near Sacramento?",
        "What is a hotspot and are there evacuation orders now?",
    ],
)
def test_synthesis_research_and_mixed_definitions_still_require_key(local_chat, question):
    app, model = local_chat
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000)) as client:
        response = client.post("/api/v1/chat", json={"message": question})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "chat_not_configured"
    assert model.calls == []


def test_keyless_reference_preserves_access_and_input_validation(local_chat):
    app, model = local_chat
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000)) as client:
        body = {"message": "What is FRP?"}
        assert (
            client.post(
                "/api/v1/chat", json=body, headers={"Origin": "https://public.example"}
            ).status_code
            == 403
        )
        assert (
            client.post("/api/v1/chat", json={"message": "What is FRP? " + "x" * 2000}).status_code
            == 422
        )
        assert (
            client.post(
                "/api/v1/chat", json=body | {"location_id": "invented-location"}
            ).status_code
            == 404
        )
    assert model.calls == []


def test_keyless_reference_preserves_rate_limit_and_releases_lease(local_chat):
    app, model = local_chat
    app.state.chat_limits.settings = app.state.settings.model_copy(
        update={"chat_rate_limit_per_minute": 1, "chat_max_concurrent_requests": 1}
    )
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000)) as client:
        body = {"message": "What is FRP?"}
        assert client.post("/api/v1/chat", json=body).status_code == 200
        limited = client.post("/api/v1/chat", json=body)
        assert limited.status_code == 429
        assert limited.json()["error"]["code"] == "chat_rate_limit"
        # Another identity can acquire the sole lease after the response finishes.
        lease = app.state.chat_limits.acquire("another-local-user")
        app.state.chat_limits.release(lease)
    assert model.calls == []
