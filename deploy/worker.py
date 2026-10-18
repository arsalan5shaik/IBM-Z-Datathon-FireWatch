"""One FIRMS owner with cooperative shutdown and a provider-independent heartbeat."""

import asyncio
import json
import signal
from pathlib import Path

from app.config import Settings
from app.services.fire_cache import FireCache


async def main():
    settings = Settings()
    cache = FireCache(settings)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    current = asyncio.current_task()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, current.cancel)
    try:
        while not stop.is_set():
            outcome = await cache.refresh()
            print(
                json.dumps(
                    {
                        "job": "firms",
                        "outcome": outcome,
                        **cache.status().model_dump(mode="json"),
                    }
                )
            )
            Path("/tmp/firms-heartbeat").touch()
            try:
                await asyncio.wait_for(stop.wait(), settings.firms_refresh_minutes * 60)
            except TimeoutError:
                pass
    except asyncio.CancelledError:
        print(json.dumps({"job": "firms", "outcome": "stopped"}))


if __name__ == "__main__":
    asyncio.run(main())
