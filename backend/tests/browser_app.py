"""Explicit test-only browser app. Real FireWatch/Open-Meteo, MOCK OpenAI only.

Run uvicorn tests.browser_app:create_browser_app --factory locally. Never use
this entry point for deployment. It never sends an OpenAI network request.
"""

import json
from datetime import datetime

from pydantic import SecretStr

from app.config import Settings
from app.errors import APIError
from app.main import create_app
from tests.unit.test_chat import final


class BrowserModelStub:
    key = SecretStr("MOCK_OPENAI_FOR_LOCAL_BROWSER_TEST_ONLY")

    async def create(self, **kwargs):
        if any(tool.get("type") == "web_search" for tool in kwargs.get("tools", [])):
            raise APIError("mock_research_not_live", "No real OpenAI research in this harness", 503)
        data = json.loads(kwargs["input"][0]["content"])
        question = data["question"]
        if "simulate timeout" in question:
            raise APIError("chat_provider_timeout", "MOCK OpenAI timeout for browser testing", 504)
        if "simulate rate limit" in question:
            raise APIError(
                "chat_provider_rate_limit", "MOCK OpenAI rate limit for browser testing", 429
            )
        rows = data["server_context"]["actual_firewatch_results"]
        row = next((row for row in rows if row.get("source") == "Open-Meteo"), None)
        if row:
            hour = datetime.fromisoformat(row["forecast_hour"].replace("Z", "+00:00"))
            # Numbers come exclusively from the real validated weather cache.
            text = (
                f"MOCK model synthesis of real FireWatch data: at {hour:%Y-%m-%d %H:00} UTC, "
                f"temperature {row['temperature_c']} C, wind {row['wind_speed_kmh']} km/h "
                f"FROM {row['wind_direction_deg']} degrees. [{row['source_id']}]"
            )
            return final(text, [row["source_id"]])
        ids = [row["source_id"] for row in rows if row.get("source_id")]
        return final("FireWatch data is unavailable for this request; no values are invented.", ids)

    async def close(self):
        pass


def create_browser_app():
    settings = Settings(chat_rate_limit_per_minute=30)
    app = create_app(settings)
    app.state.chat.client = BrowserModelStub()
    answer = app.state.chat.answer

    async def labeled_answer(request):
        response = await answer(request)
        response.model = "MOCK OpenAI — real FireWatch provider data"
        return response

    app.state.chat.answer = labeled_answer
    return app
