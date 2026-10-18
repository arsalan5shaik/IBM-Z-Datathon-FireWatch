"""Explicit, bounded PAID smoke; never run in CI. Missing key prints BLOCKED."""

import asyncio
import json

from app.config import Settings
from app.errors import APIError
from app.main import create_app
from app.schemas.chat import ChatRequest


async def main():
    settings = Settings(chat_max_tool_calls=4, chat_max_research_calls=1)
    if not (settings.openai_api_key or settings.llm_api_key):
        print(
            json.dumps(
                {
                    "status": "BLOCKED",
                    "reason": "OPENAI_API_KEY is not configured",
                    "model": settings.openai_model,
                }
            )
        )
        return
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        location = app.state.locations.search("Stockton", 1).results[0]
        for question in (
            "What is the weather in Stockton tomorrow?",
            "What caused the 2018 Camp Fire?",
        ):
            result = await app.state.chat.answer(
                ChatRequest(message=question, location_id=location.id)
            )
            assert result.model == settings.openai_model
            assert result.sources
            if "Camp Fire" in question:
                assert any(source.kind == "research" and source.url for source in result.sources)
            else:
                assert any(source.provider == "Open-Meteo" for source in result.sources)
            print(
                json.dumps(
                    {
                        "status": "PASS",
                        "model": result.model,
                        "question": question,
                        "tools": result.tools_used,
                        "sources": [source.model_dump() for source in result.sources],
                    }
                )
            )
        refusal = await app.state.chat.answer(ChatRequest(message="Who won the Super Bowl?"))
        assert refusal.mode == "scope_refusal"
        print(json.dumps({"status": "PASS", "check": "scope refusal"}))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except APIError as error:
        print(json.dumps({"status": "FAIL", "code": error.code}))
        raise SystemExit(1) from None
