"""Official SDK only; fixed OpenAI endpoint, no conversations stored remotely."""

import asyncio
import logging
from time import perf_counter

import openai

from app.errors import APIError

logger = logging.getLogger("firewatch.chat")


class ResponsesClient:
    def __init__(self, settings):
        self.settings = settings
        self.client = None

    @property
    def key(self):
        return self.settings.openai_api_key or self.settings.llm_api_key

    async def create(self, **kwargs):
        if not self.key or not self.key.get_secret_value().strip():
            raise APIError("chat_not_configured", "Set OPENAI_API_KEY on the FastAPI server", 503)
        if self.client is None:
            self.client = openai.AsyncOpenAI(
                api_key=self.key.get_secret_value(),
                base_url="https://api.openai.com/v1",
                timeout=self.settings.openai_timeout_seconds,
                max_retries=1,
            )
        started = perf_counter()
        try:
            # One SDK retry is allowed, with a wall-clock cap across both
            # attempts/backoff (HTTPX timeouts alone are per I/O operation).
            async with asyncio.timeout(
                min(
                    self.settings.openai_timeout_seconds * 2 + 1, self.settings.chat_timeout_seconds
                )
            ):
                response = await self.client.responses.create(
                    model=self.settings.openai_model,
                    max_output_tokens=self.settings.openai_max_output_tokens,
                    store=False,
                    reasoning={"effort": "low"},
                    **kwargs,
                )
            if response.status != "completed":
                raise APIError(
                    "chat_incomplete", "AI output was incomplete; try a shorter question", 502
                )
            return response
        except openai.AuthenticationError:
            raise APIError(
                "chat_authentication_failed", "The server's OpenAI credential was rejected", 503
            ) from None
        except openai.RateLimitError:
            raise APIError(
                "chat_provider_rate_limit", "OpenAI quota or rate limit reached; retry later", 429
            ) from None
        except (openai.APITimeoutError, TimeoutError):
            raise APIError(
                "chat_provider_timeout", "OpenAI did not respond in time; retry later", 504
            ) from None
        except (openai.BadRequestError, openai.NotFoundError):
            raise APIError(
                "chat_model_or_tool_unsupported",
                "Configured OpenAI model or tool is unavailable; no model was substituted",
                503,
            ) from None
        except openai.APIError:
            raise APIError(
                "chat_provider_unavailable", "OpenAI is temporarily unavailable", 503
            ) from None
        finally:
            logger.info(
                "chat_model_response duration_ms=%d research=%s",
                round((perf_counter() - started) * 1000),
                any(t.get("type") == "web_search" for t in kwargs.get("tools", [])),
                extra={
                    "duration_ms": round((perf_counter() - started) * 1000),
                    "research": any(t.get("type") == "web_search" for t in kwargs.get("tools", [])),
                },
            )

    async def close(self):
        if self.client is not None:
            await self.client.close()


def output_items(response):
    return [item.model_dump(mode="json", exclude_none=True) for item in response.output]
