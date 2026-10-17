import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for field in Settings.model_fields:
        monkeypatch.delenv(field.upper(), raising=False)

    def no_network(*args, **kwargs):
        raise AssertionError("Tests must use mocked HTTP providers")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", no_network)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", no_network)


@pytest.fixture
def settings(tmp_path):
    return Settings(_env_file=None, repo_root=tmp_path, cors_origins=["http://localhost:5173"])


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client
