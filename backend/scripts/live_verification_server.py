"""Local verification instrumentation: real application and real SDK, no mocks."""

import asyncio
import json
import os
import tempfile
from pathlib import Path

import openai
import uvicorn
from fastapi.responses import JSONResponse

from app.config import Settings
from app.errors import APIError
from app.main import create_app


def main():
    if os.environ.get("FIREWATCH_RUN_PAID_VERIFICATION") != "1":
        raise SystemExit("Explicit FIREWATCH_RUN_PAID_VERIFICATION=1 required")
    OUTPUT = Path(tempfile.gettempdir()) / "firewatch-live-api-results"
    OUTPUT.mkdir(exist_ok=True)
    PATH = OUTPUT / "budget.json"
    budget = (
        json.loads(PATH.read_text())
        if PATH.exists()
        else {"http_chat_requests": 0, "responses_requests": 0, "research_requests": 0, "calls": []}
    )
    lock = asyncio.Lock()

    def save():
        PATH.write_text(json.dumps(budget, indent=2))

    settings = Settings()
    assert settings.openai_model == "gpt-5-mini"
    assert settings.chat_access_mode == "local"
    assert not settings.job_enabled and not settings.allow_fixture_data
    app = create_app(settings)
    key = app.state.chat.client.key
    assert key and key.get_secret_value().strip()
    sdk = openai.AsyncOpenAI(
        api_key=key.get_secret_value(),
        base_url="https://api.openai.com/v1",
        timeout=settings.openai_timeout_seconds,
        max_retries=0,
    )
    original = sdk.responses.create

    async def observed(**kwargs):
        research = any(t.get("type") == "web_search" for t in kwargs.get("tools", []))
        async with lock:
            executed = sum(
                row.get("tool_types", []).count("web_search_call") for row in budget["calls"]
            )
            if budget["responses_requests"] >= 32 or (research and executed >= 3):
                raise APIError(
                    "verification_budget_exhausted", "Live verification call cap reached", 503
                )
            budget["responses_requests"] += 1
            if research:
                budget["research_requests"] += 1
            record = {"number": budget["responses_requests"], "research": research}
            budget["calls"].append(record)
            save()
        try:
            response = await original(**kwargs)
            record.update(
                status=response.status,
                model=response.model,
                usage=response.usage.model_dump() if response.usage else None,
                tool_types=[i.type for i in response.output],
                function_names=[i.name for i in response.output if i.type == "function_call"],
            )
            if os.environ.get("FIREWATCH_VERIFY_CAPTURE_OUTPUT") == "1":
                # Optional local diagnosis only; never CI/artifacts/Git. Drop the
                # entire output if it contains any configured provider credential.
                secrets = (
                    settings.openai_api_key,
                    settings.llm_api_key,
                    settings.nasa_firms_map_key,
                    settings.firms_map_key,
                )
                text = response.output_text
                if not any(secret and secret.get_secret_value() in text for secret in secrets):
                    record["verification_output"] = text
            return response
        except openai.APIError as error:
            body = error.body if isinstance(error.body, dict) else {}
            body = body.get("error", body)
            record.update(
                error=type(error).__name__,
                http_status=getattr(error, "status_code", None),
                provider_code=body.get("code"),
                param=body.get("param"),
            )
            raise
        finally:
            save()

    sdk.responses.create = observed
    app.state.chat.client.client = sdk

    @app.middleware("http")
    async def request_budget(request, call_next):
        if request.method == "POST" and request.url.path == "/api/v1/chat":
            async with lock:
                if budget["http_chat_requests"] >= 15:
                    return JSONResponse(
                        {"error": {"code": "verification_budget_exhausted"}}, status_code=429
                    )
                budget["http_chat_requests"] += 1
                save()
        return await call_next(request)

    uvicorn.run(app, host="127.0.0.1", port=8007, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
