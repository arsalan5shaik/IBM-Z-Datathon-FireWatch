"""Local verification instrumentation: real application and real SDK, no mocks.

Caps are explicit and mandatory (FIREWATCH_VERIFY_MAX_CHAT/_ATTEMPTS/_SEARCHES);
counters persist in a private temporary ledger and are never reset by this script.
"""

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
from app.services.openai_client import ResponsesClient

# A single hosted research response has produced two native search actions
# despite max_tool_calls=1; an attempt without returned output is charged this too.
SEARCH_RESERVE = 2


def cap(name):
    value = os.environ.get(name, "")
    if not value.isdigit():
        raise SystemExit(f"Explicit numeric {name} required (approved paid-test cap)")
    return int(value)


def main():
    if os.environ.get("FIREWATCH_RUN_PAID_VERIFICATION") != "1":
        raise SystemExit("Explicit FIREWATCH_RUN_PAID_VERIFICATION=1 required")
    session = os.environ.get("FIREWATCH_VERIFY_SESSION", "")
    if Path(session).name != session or not session.startswith("firewatch-"):
        raise SystemExit("Use a firewatch- prefixed temporary session directory name")
    max_chat = cap("FIREWATCH_VERIFY_MAX_CHAT")
    max_attempts = cap("FIREWATCH_VERIFY_MAX_ATTEMPTS")
    max_searches = cap("FIREWATCH_VERIFY_MAX_SEARCHES")
    output = Path(tempfile.gettempdir()) / session
    output.mkdir(exist_ok=True)
    path = output / "budget.json"
    budget = (
        json.loads(path.read_text())
        if path.exists()
        else {"http_chat_requests": 0, "http_attempts": 0, "calls": [], "tools": []}
    )
    budget["caps"] = {"chat": max_chat, "attempts": max_attempts, "searches": max_searches}
    lock = asyncio.Lock()

    def save():
        path.write_text(json.dumps(budget, indent=2))

    def searches():
        # Observed search actions plus a reserve for research attempts whose
        # actions were not returned (timeouts/errors): conservative, never reset.
        return sum(
            row.get("search_actions", SEARCH_RESERVE if row.get("error") else 0)
            for row in budget["calls"]
            if row["research"]
        )

    settings = Settings()
    assert settings.openai_model == "gpt-5-mini"
    assert settings.chat_access_mode == "local"
    assert not settings.job_enabled and not settings.allow_fixture_data
    app = create_app(settings)

    async def count_attempt(request):
        # Every HTTP attempt, before network I/O; never persist headers/URLs.
        async with lock:
            if budget["http_attempts"] >= max_attempts:
                raise APIError("verification_budget_exhausted", "Paid attempt cap reached", 503)
            budget["http_attempts"] += 1
            save()

    # The production client construction (SDK retries off; create() owns the
    # bounded retry), only with a counting HTTP hook.
    client = ResponsesClient(
        settings, http_client=httpx.AsyncClient(event_hooks={"request": [count_attempt]})
    )
    assert client.key and client.key.get_secret_value().strip()
    app.state.chat.client = client
    sdk = client.sdk()
    original = sdk.responses.create

    async def observed(**kwargs):
        research = any(t.get("type") == "web_search" for t in kwargs.get("tools", []))
        async with lock:
            if research and searches() + SEARCH_RESERVE > max_searches:
                raise APIError(
                    "verification_budget_exhausted", "Hosted search allowance reached", 503
                )
            record = {"number": len(budget["calls"]) + 1, "research": research}
            record["chat_request"] = budget["http_chat_requests"]
            budget["calls"].append(record)
            save()
        started = perf_counter()
        try:
            response = await original(**kwargs)
            actions = [i for i in response.output if i.type == "web_search_call"]
            record.update(
                status=response.status,
                model=response.model,
                usage=response.usage.model_dump() if response.usage else None,
                tool_types=[i.type for i in response.output],
                function_names=[i.name for i in response.output if i.type == "function_call"],
                web_actions=[i.action.type for i in actions],
                web_statuses=[i.status for i in actions],
                search_actions=sum(i.action.type == "search" for i in actions),
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
        except BaseException as error:
            # Wall-clock cancellation: usage and native actions are unknown.
            record.update(error=type(error).__name__)
            raise
        finally:
            record["seconds"] = round(perf_counter() - started, 3)
            save()

    sdk.responses.create = observed
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
                if budget["http_chat_requests"] >= max_chat:
                    return JSONResponse(
                        {"error": {"code": "verification_budget_exhausted"}}, status_code=429
                    )
                budget["http_chat_requests"] += 1
                save()
        return await call_next(request)

    uvicorn.run(app, host="127.0.0.1", port=8007, access_log=False, log_level="info")


if __name__ == "__main__":
    main()
