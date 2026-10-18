"""Official SDK only; fixed OpenAI endpoint, no conversations stored remotely."""

import asyncio
import logging
from contextvars import ContextVar
from dataclasses import dataclass, field
from time import perf_counter

import openai

from app.errors import APIError

logger = logging.getLogger("firewatch.chat")

# Transient statuses only. Authentication, permission, validation and unknown
# model/tool errors are final: retrying them costs time and cannot succeed.
TRANSIENT_STATUS = {408, 409, 429, 500, 502, 503, 504}
MIN_ATTEMPT_SECONDS = 5
MAX_RETRY_DELAY_SECONDS = 2


@dataclass
class ChatTrace:
    """Per-request timings and outcome categories; never content or secrets."""

    deadline: float
    attempts: list = field(default_factory=list)
    tools: list = field(default_factory=list)


TRACE: ContextVar[ChatTrace | None] = ContextVar("firewatch_chat_trace", default=None)


def outcome(error):
    """Classify a provider failure without retaining its message or body."""
    if isinstance(error, openai.APITimeoutError):
        return "timeout"
    if isinstance(error, openai.APIConnectionError):
        return "connection"
    if isinstance(error, openai.APIStatusError):
        if error.status_code == 429 and error.code == "insufficient_quota":
            return "quota"
        return f"http_{error.status_code}"
    return "error"


def retry_delay(error):
    headers = getattr(getattr(error, "response", None), "headers", None) or {}
    try:
        if "retry-after-ms" in headers:
            return float(headers["retry-after-ms"]) / 1000
        if "retry-after" in headers:
            return float(headers["retry-after"])
    except ValueError:
        pass
    return 0.5


class ResponsesClient:
    def __init__(self, settings, http_client=None):
        self.settings = settings
        self.http_client = http_client
        self.client = None

    @property
    def key(self):
        return self.settings.openai_api_key or self.settings.llm_api_key

    def sdk(self):
        if self.client is None:
            # SDK retries are disabled: create() owns the single bounded retry so
            # every attempt is timed, classified and kept inside the deadline.
            self.client = openai.AsyncOpenAI(
                api_key=self.key.get_secret_value(),
                base_url="https://api.openai.com/v1",
                timeout=self.settings.openai_timeout_seconds,
                max_retries=0,
                http_client=self.http_client,
            )
        return self.client

    def retryable(self, category, research, attempt, deadline, delay):
        if attempt > self.settings.openai_max_retries or delay > MAX_RETRY_DELAY_SECONDS:
            return False
        if category == "timeout":
            # Hosted research already ran for its whole attempt budget. Repeating
            # it doubled observed latency (25 s + 25 s) and its search cost.
            return not research
        if category != "connection" and not (
            category.startswith("http_") and int(category[5:]) in TRANSIENT_STATUS
        ):
            return False
        return deadline - perf_counter() - delay >= MIN_ATTEMPT_SECONDS

    def record(self, stage, attempt, category, started):
        duration = round((perf_counter() - started) * 1000)
        trace = TRACE.get()
        if trace is not None:
            trace.attempts.append({"stage": stage, "outcome": category, "duration_ms": duration})
        # Stage, attempt number, outcome class and duration only: no prompt,
        # conversation, tool arguments, provider message, URL or key.
        logger.info(
            "chat_model_attempt stage=%s attempt=%d outcome=%s duration_ms=%d",
            stage,
            attempt,
            category,
            duration,
            extra={"stage": stage, "attempt": attempt, "outcome": category},
        )

    async def create(self, **kwargs):
        if not self.key or not self.key.get_secret_value().strip():
            raise APIError("chat_not_configured", "Set OPENAI_API_KEY on the FastAPI server", 503)
        research = any(t.get("type") == "web_search" for t in kwargs.get("tools", []))
        stage = "research" if research else "synthesis"
        per_attempt = (
            self.settings.openai_research_timeout_seconds
            if research
            else self.settings.openai_timeout_seconds
        )
        started = perf_counter()
        trace = TRACE.get()
        # Inside a chat request, every attempt shares the request deadline. Direct
        # callers keep a wall-clock cap across all attempts and backoff.
        deadline = (
            trace.deadline
            if trace is not None
            else started
            + min(
                per_attempt * (self.settings.openai_max_retries + 1) + 1,
                self.settings.chat_timeout_seconds,
            )
        )
        sdk = self.sdk()
        attempt = 0
        try:
            # HTTPX timeouts are per I/O operation; this caps total wall-clock time.
            async with asyncio.timeout(max(deadline - perf_counter(), 0)):
                while True:
                    attempt += 1
                    remaining = deadline - perf_counter()
                    if remaining < MIN_ATTEMPT_SECONDS:
                        self.record(stage, attempt, "deadline", perf_counter())
                        raise TimeoutError
                    attempt_started = perf_counter()
                    try:
                        response = await sdk.responses.create(
                            model=self.settings.openai_model,
                            max_output_tokens=self.settings.openai_max_output_tokens,
                            store=False,
                            reasoning={"effort": "low"},
                            timeout=min(per_attempt, remaining),
                            **kwargs,
                        )
                    except openai.APIError as error:
                        category = outcome(error)
                        self.record(stage, attempt, category, attempt_started)
                        delay = retry_delay(error)
                        if not self.retryable(category, research, attempt, deadline, delay):
                            raise
                        await asyncio.sleep(delay)
                        continue
                    if response.status != "completed":
                        self.record(stage, attempt, "incomplete", attempt_started)
                        raise APIError(
                            "chat_incomplete",
                            "AI output was incomplete; try a shorter question",
                            502,
                        )
                    self.record(stage, attempt, "completed", attempt_started)
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
                "chat_model_response stage=%s attempts=%d duration_ms=%d research=%s",
                stage,
                attempt,
                round((perf_counter() - started) * 1000),
                research,
                extra={
                    "duration_ms": round((perf_counter() - started) * 1000),
                    "research": research,
                },
            )

    async def close(self):
        if self.client is not None:
            await self.client.close()


def output_items(response):
    return [item.model_dump(mode="json", exclude_none=True) for item in response.output]
