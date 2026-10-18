"""Local verification instrumentation: real application and real SDK, no mocks."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from time import perf_counter

import httpx
import openai
import uvicorn
from fastapi.responses import JSONResponse

from app.config import Settings
from app.errors import APIError
from app.main import create_app
from app.services.chat_tools import ChatTools


def main():
    if os.environ.get("FIREWATCH_RUN_PAID_VERIFICATION") != "1":
        raise SystemExit("Explicit FIREWATCH_RUN_PAID_VERIFICATION=1 required")
    session = os.environ.get("FIREWATCH_VERIFY_SESSION", "firewatch-live-api-results")
    if Path(session).name != session or not session.startswith("firewatch-"):
        raise SystemExit("Use a firewatch- prefixed temporary session directory name")
    OUTPUT = Path(tempfile.gettempdir()) / session
    OUTPUT.mkdir(exist_ok=True)
    PATH = OUTPUT / "budget.json"
    budget = (
        json.loads(PATH.read_text())
        if PATH.exists()
        else {"http_chat_requests": 0, "responses_requests": 0, "research_requests": 0, "calls": []}
    )
    lock = asyncio.Lock()
    budget.setdefault("http_attempts", budget["responses_requests"])
    budget.setdefault("tools", [])

    def save():
        PATH.write_text(json.dumps(budget, indent=2))

    settings = Settings()
    assert settings.openai_model == "gpt-5-mini"
    assert settings.chat_access_mode == "local"
    assert not settings.job_enabled and not settings.allow_fixture_data
    app = create_app(settings)
    key = app.state.chat.client.key
    assert key and key.get_secret_value().strip()

    async def count_attempt(request):
        # Includes SDK retries, before any network I/O; never persist headers/URLs.
        async with lock:
            if budget["http_attempts"] >= 20:
                raise APIError("verification_budget_exhausted", "20 paid attempts reached", 503)
            budget["http_attempts"] += 1
            save()

    sdk = openai.AsyncOpenAI(
        api_key=key.get_secret_value(),
        base_url="https://api.openai.com/v1",
        timeout=settings.openai_timeout_seconds,
        max_retries=1,
        http_client=httpx.AsyncClient(event_hooks={"request": [count_attempt]}),
    )
    original = sdk.responses.create

    async def observed(**kwargs):
        research = any(t.get("type") == "web_search" for t in kwargs.get("tools", []))
        async with lock:
            searches = sum(row.get("search_actions", 0) for row in budget["calls"])
            if budget["http_attempts"] >= 20 or (
                research
                and (
                    budget.get("research_allowance_closed", False)
                    or budget["research_requests"] >= 4
                    or searches + budget.get("unmetered_research_attempts", 0) >= 4
                )
            ):
                raise APIError(
                    "verification_budget_exhausted", "Live verification call cap reached", 503
                )
            budget["responses_requests"] += 1
            if research:
                budget["research_requests"] += 1
            record = {"number": budget["responses_requests"], "research": research}
            budget["calls"].append(record)
            save()
        started = perf_counter()
        try:
            response = await original(**kwargs)
            record.update(
                status=response.status,
                model=response.model,
                usage=response.usage.model_dump() if response.usage else None,
                tool_types=[i.type for i in response.output],
                function_names=[i.name for i in response.output if i.type == "function_call"],
                web_actions=[i.action.type for i in response.output if i.type == "web_search_call"],
                web_statuses=[i.status for i in response.output if i.type == "web_search_call"],
                search_actions=sum(
                    i.type == "web_search_call" and i.action.type == "search"
                    for i in response.output
                ),
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
            record["seconds"] = round(perf_counter() - started, 3)
            save()

    sdk.responses.create = observed
    app.state.chat.client.client = sdk
    original_tool = ChatTools.execute

    async def measured_tool(self, name, arguments):
        started = perf_counter()
        record = {"request": budget["http_chat_requests"], "name": name}
        try:
            result = await original_tool(self, name, arguments)
            record["status"] = result.get("status")
            return result
        finally:
            record["seconds"] = round(perf_counter() - started, 3)
            budget["tools"].append(record)
            save()

    ChatTools.execute = measured_tool

    @app.middleware("http")
    async def request_budget(request, call_next):
        if request.method == "POST" and request.url.path == "/api/v1/chat":
            async with lock:
                if budget["http_chat_requests"] >= 20:
                    return JSONResponse(
                        {"error": {"code": "verification_budget_exhausted"}}, status_code=429
                    )
                budget["http_chat_requests"] += 1
                save()
        return await call_next(request)

    uvicorn.run(app, host="127.0.0.1", port=8007, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
