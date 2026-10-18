import asyncio
from types import SimpleNamespace

import pytest

from app.jobs import refresh_fires


def test_loop_interval_and_force_only_first_cycle(settings, monkeypatch):
    calls, sleeps = [], []

    class Cache:
        def __init__(self, config):
            assert config is settings

        async def refresh(self, *, force):
            calls.append(force)
            return "not_due"

        def status(self):
            return SimpleNamespace(model_dump=lambda **kwargs: {"status": "healthy"})

    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(refresh_fires, "FireCache", Cache)
    monkeypatch.setattr(refresh_fires.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(refresh_fires.run(settings, loop=True, force=True))
    assert calls == [True, False] and sleeps == [900, 900]
