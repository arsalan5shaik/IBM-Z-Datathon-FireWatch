"""Validated configuration, independent of the launch directory."""

from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / "backend" / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
        frozen=True,
    )

    repo_root: Path = REPO_ROOT
    shared_data_dir: Path = Path("shared/data")
    sqlite_path: Path = Path("shared/data/firewatch.sqlite3")
    cors_origins: list[str] = Field(default_factory=list)
    firms_map_key: SecretStr | None = Field(default=None, repr=False)
    llm_api_key: SecretStr | None = Field(default=None, repr=False)
    weather_provider: Literal["open-meteo"] = "open-meteo"
    forecast_hours: Literal[168] = 168
    grid_resolution_m: Literal[3000] = 3000
    job_enabled: bool = False
    scheduler_owner: Literal["unassigned", "backend", "ml"] = "unassigned"
    generator_timeout_seconds: int = Field(default=300, ge=1, le=3600)
    generator_max_retries: int = Field(default=2, ge=0, le=5)
    generator_retry_seconds: float = Field(default=1, ge=0, le=30)
    forecast_retention_hours: int = Field(default=24, ge=1, le=168)
    min_free_disk_mb: int = Field(default=512, ge=1, le=100000)
    forecast_generator_cmd: SecretStr | None = Field(default=None, repr=False)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    request_timeout_seconds: float = Field(default=10, ge=0.1, le=60)
    cache_max_entries: int = Field(default=128, ge=1, le=10000)
    allow_fixture_data: bool = False
    forecast_cache_hours: int = Field(default=4, ge=1, le=24)
    max_response_cells: int = Field(default=2000, ge=1, le=10000)
    provider_max_retries: int = Field(default=2, ge=0, le=5)
    firms_refresh_minutes: int = Field(default=15, ge=10, le=1440)
    weather_refresh_minutes: int = Field(default=60, ge=15, le=1440)
    weather_batch_size: int = Field(default=50, ge=1, le=100)
    weather_max_anchors: int = Field(default=512, ge=1, le=2000)
    weather_stale_hours: int = Field(default=3, ge=1, le=24)
    weather_refresh_timeout_seconds: float = Field(default=25, ge=1, le=60)

    @field_validator("repo_root")
    @classmethod
    def absolute_root(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("REPO_ROOT must be absolute")
        return value.resolve()

    @field_validator("cors_origins")
    @classmethod
    def explicit_origins(cls, values: list[str]) -> list[str]:
        for value in values:
            parsed = urlsplit(value)
            try:
                _ = parsed.port  # Access validates the optional port.
            except ValueError as exc:
                raise ValueError("CORS origins require a valid port") from exc
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path
                or parsed.query
                or parsed.fragment
                or value != f"{parsed.scheme}://{parsed.netloc}"
                or parsed.netloc.endswith(":")
                or "*" in value
                or any(char.isspace() for char in value)
            ):
                raise ValueError("CORS origins must be explicit HTTP(S) origins without a path")
        return list(dict.fromkeys(values))

    @model_validator(mode="after")
    def resolve_paths(self) -> "Settings":
        if self.job_enabled and self.scheduler_owner != "backend":
            raise ValueError("Backend jobs require explicit scheduler_owner=backend")
        for name in ("shared_data_dir", "sqlite_path"):
            value = getattr(self, name)
            if not value.is_absolute():
                value = self.repo_root / value
            object.__setattr__(self, name, value.resolve())
        return self
