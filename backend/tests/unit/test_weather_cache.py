import asyncio
from datetime import timedelta

import pytest

from app.config import Settings
from app.errors import APIError
from app.services.weather_cache import WeatherCache, display_points, hour_revision, sample_point
from app.services.weather_provider import normalize
from tests.unit.test_weather_provider import NOW, response


class MockProvider:
    def __init__(self):
        self.calls = 0
        self.data = response()
        self.fail = False

    async def fetch(self, points, now):
        self.calls += 1
        await asyncio.sleep(0)
        if self.fail:
            raise APIError("mock_failure", "Mock provider failure")
        return [normalize(self.data, now) for _ in points]


def test_cache_concurrency_revisions_and_stale_fallback(tmp_path):
    settings = Settings(_env_file=None, repo_root=tmp_path)
    provider = MockProvider()
    clock = [NOW]
    cache = WeatherCache(provider, settings, lambda: clock[0])
    point = sample_point(36.5, -120)

    async def run():
        first, second = await asyncio.gather(cache.get([point]), cache.get([point]))
        assert provider.calls == 1 and first == second
        before = hour_revision(point, first[0][0].forecast.hours[1])
        clock[0] += timedelta(hours=1)
        fresh = await cache.get([point])
        assert hour_revision(point, fresh[0][0].forecast.hours[1]) == before
        assert cache.changed_partitions == []
        provider.data["hourly"]["temperature_2m"][1] = 21
        clock[0] += timedelta(hours=1)
        await cache.get([point])
        assert len(cache.changed_partitions) == 1
        provider.fail = True
        clock[0] += timedelta(hours=1)
        old = await cache.get([point])
        assert old[0][1] == "stale" and cache.last_error
        clock[0] += timedelta(hours=4)
        with pytest.raises(APIError):
            await cache.get([point])

    asyncio.run(run())
    restored = WeatherCache(provider, settings, lambda: clock[0] - timedelta(hours=4))
    assert len(restored.entries) == 1


def test_partial_refresh_preserves_cache_and_initial_failure(tmp_path):
    provider = MockProvider()
    clock = [NOW]
    settings = Settings(_env_file=None, repo_root=tmp_path)
    cache = WeatherCache(provider, settings, lambda: clock[0])
    point = sample_point(36.5, -120)

    async def run():
        original = (await cache.get([point]))[0][0]
        clock[0] += timedelta(hours=1)
        provider.data["hourly"]["temperature_2m"][2] = None
        assert (await cache.get([point]))[0][0] == original
        assert cache.last_error
        provider.fail = True
        empty = WeatherCache(
            provider, settings.model_copy(update={"shared_data_dir": tmp_path / "empty"})
        )
        with pytest.raises(APIError):
            await empty.get([point])

    asyncio.run(run())


def test_sampling_bounds_and_shared_anchors():
    assert sample_point(36.51, -120.01) == sample_point(36.52, -120.02)
    points = display_points((-124.5, 32.5, -114, 42))
    assert len(points) <= 512 and len({p.anchor_id for p in points}) == len(points)
    assert all(-124.5 <= p.longitude <= -114 for p in points)
