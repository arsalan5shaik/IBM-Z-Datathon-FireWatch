import asyncio

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from app.errors import APIError
from app.schemas.chat import ChatRequest, ChatResponse
from app.services.chat_access import authorize

router = APIRouter(prefix="/api/v1", tags=["FireWatch AI"])


@router.post(
    "/chat",
    response_model=ChatResponse,
    summary="Grounded California wildfire assistant; OpenAI Responses API",
)
async def chat(body: ChatRequest, request: Request):
    settings = request.app.state.settings
    authorize(request, settings)
    if (
        len(body.message) > settings.chat_max_message_length
        or len(body.history) > settings.chat_max_history_messages
    ):
        raise APIError("chat_input_limit", "Chat message/history limit exceeded", 422)
    service = request.app.state.chat
    if not service.client.key:
        # Deterministic out-of-scope refusals do not need a paid model call.
        from app.services.chat_service import scoped

        if scoped(body.message, body.history):
            raise APIError(
                "chat_not_configured",
                "Set OPENAI_API_KEY on the FastAPI server; live AI is unavailable",
                503,
            )
        return await service.answer(body)
    lease = await run_in_threadpool(request.app.state.chat_limits.acquire, request.client.host)

    async def disconnected():
        # FastAPI already consumed the request body. Waiting on the ASGI channel
        # is cancellable; Request.is_disconnected's CancelScope polling can swallow
        # cancellation while an error response is waiting to be sent.
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                return

    work = asyncio.create_task(service.answer(body))
    gone = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait(
            {work, gone}, timeout=settings.chat_timeout_seconds, return_when=asyncio.FIRST_COMPLETED
        )
        if work in done:
            return await work
        if gone in done:
            raise APIError("chat_client_disconnected", "Chat request canceled", 499)
        raise APIError(
            "chat_timeout", "Chat exceeded its time budget; retry a narrower question", 504
        )
    finally:
        work.cancel()
        gone.cancel()
        await asyncio.gather(work, gone, return_exceptions=True)
        await run_in_threadpool(request.app.state.chat_limits.release, lease)
