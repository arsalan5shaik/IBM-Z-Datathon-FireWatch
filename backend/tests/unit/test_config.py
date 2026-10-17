from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_secure_defaults(tmp_path):
    settings = Settings(_env_file=None, repo_root=tmp_path)
    assert settings.cors_origins == []
    assert settings.firms_map_key is None
    assert settings.llm_api_key is None
    assert settings.forecast_hours == 168
    assert settings.grid_resolution_m == 3000
    assert settings.job_enabled is False


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "https://*.example.com",
        "null",
        "file://host",
        "https://example.com/",
        "https://example.com/path",
        "https://user:password@example.com",
        "https://example.com?q=1",
        "https://example.com#fragment",
        "https://example.com?",
        "https://example.com#",
        "https://example.com:",
        "https://example.com:bad",
        "https://example.com:99999",
        "https://bad host",
        "https://",
    ],
)
def test_invalid_origins(origin):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, cors_origins=[origin])


@pytest.mark.parametrize(
    "values",
    [
        {"forecast_hours": 7},
        {"grid_resolution_m": 1000},
        {"job_enabled": True},
        {"request_timeout_seconds": 0},
        {"request_timeout_seconds": float("inf")},
        {"request_timeout_seconds": float("nan")},
        {"cache_max_entries": 0},
        {"provider_max_retries": 6},
        {"repo_root": Path("relative")},
        {"log_level": "invalid"},
        {"firms_refresh_minutes": 1},
    ],
)
def test_invalid_settings(values):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **values)


def test_paths_do_not_depend_on_cwd(tmp_path, monkeypatch):
    repo = tmp_path / "repository"
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    settings = Settings(_env_file=None, repo_root=repo)
    assert settings.shared_data_dir == repo / "shared/data"
    assert settings.sqlite_path == repo / "shared/data/firewatch.sqlite3"


def test_env_and_secrets(monkeypatch, tmp_path):
    monkeypatch.setenv("CORS_ORIGINS", '["https://firewatch.example"]')
    monkeypatch.setenv("FIRMS_MAP_KEY", "test-secret-not-a-real-key")
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))
    settings = Settings(_env_file=None)
    assert settings.cors_origins == ["https://firewatch.example"]
    assert "test-secret" not in repr(settings)
    assert "test-secret" not in settings.model_dump_json()


def test_dotenv_explicit_path(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text('CORS_ORIGINS=["http://localhost:5173"]\n', encoding="utf-8")
    assert Settings(_env_file=env_file).cors_origins == ["http://localhost:5173"]


def test_numeric_literals_from_documented_dotenv_and_environment(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("FORECAST_HOURS=168\nGRID_RESOLUTION_M=3000\n", encoding="utf-8")
    settings = Settings(_env_file=env_file)
    assert settings.forecast_hours == 168 and settings.grid_resolution_m == 3000
    monkeypatch.setenv("FORECAST_HOURS", "7")
    with pytest.raises(ValidationError):
        Settings(_env_file=env_file)
