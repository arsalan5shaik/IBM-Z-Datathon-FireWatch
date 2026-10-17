import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.persistence.atomic import single_owner
from app.schemas.fires import Observation
from app.services.fire_cache import FireCache
from app.services.grid import CA_BBOX
from app.services.nasa_firms import FirmsClient, ProviderError

NOW = datetime(2026, 10, 17, 12, tzinfo=UTC)
S20, S21 = "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"


def observation(source=S20, index=0, acquired_at=NOW, lon=-121.5, lat=38.5):
    return Observation(
        id=f"test-{source}-{index}",
        latitude=lat,
        longitude=lon,
        acquired_at=acquired_at,
        source=source,
        satellite="NOAA-20" if source == S20 else "NOAA-21",
        confidence="n",
        frp=12.4,
    )


class Provider:
    def __init__(self, records=None, failures=()):
        self.records = records if records is not None else [observation()]
        self.failures = failures
        self.calls = []

    async def fetch(self, source, now):
        self.calls.append(source)
        if source in self.failures:
            raise ProviderError("provider_unavailable")
        return (
            [item for item in self.records if item.source == source],
            {"invalid_rows": 0, "duplicate_rows": 0, "outside_rows": 0},
            now - timedelta(hours=72),
        )


def refresh(cache, provider, now=NOW, force=False):
    return asyncio.run(cache.refresh(now=now, client=provider, force=force))


def test_refresh_atomic_reopen_dedicated_cache_no_forecast_changes(settings):
    cache = FireCache(settings)
    assert cache.read() is None and not settings.shared_data_dir.exists()
    assert refresh(cache, Provider()) == "refreshed"
    reopened = FireCache(settings)
    collection = reopened.query(CA_BBOX, NOW - timedelta(hours=24), 500, now=NOW)
    assert len(collection.features) == 1
    feature = collection.features[0]
    assert feature.geometry == {"type": "Point", "coordinates": [-121.5, 38.5]}
    assert feature.properties["source"] == "NASA_FIRMS"
    assert feature.properties["product"] == S20
    assert feature.properties["acquired_at"].endswith("Z")
    assert collection.metadata["cache_status"] == "fresh"
    assert collection.metadata["not_fire_perimeter"] is True
    assert not settings.sqlite_path.exists()
    assert not (settings.shared_data_dir / "predictions").exists()


def test_empty_success_distinct_from_failed_provider(settings):
    cache = FireCache(settings)
    refresh(cache, Provider([]))
    result = cache.query(CA_BBOX, NOW - timedelta(hours=24), 500, now=NOW)
    assert result.features == [] and result.metadata["cache_status"] == "fresh"
    other = FireCache(
        settings.model_copy(update={"shared_data_dir": settings.shared_data_dir / "other"})
    )
    refresh(other, Provider([], (S20, S21)))
    with pytest.raises(Exception, match="Satellite observations unavailable"):
        other.query(CA_BBOX, NOW - timedelta(hours=24), 500, now=NOW)
    assert other.status(NOW).status == "unavailable"


def test_partial_failure_preserves_each_last_known_good_source(settings):
    cache = FireCache(settings)
    refresh(cache, Provider([observation(), observation(S21)]))
    later = NOW + timedelta(minutes=16)
    refresh(cache, Provider([observation(S20, 2, later)], failures=(S21,)), later)
    result = cache.query(CA_BBOX, NOW - timedelta(hours=24), 500, now=later)
    assert {item.id for item in result.features} == {f"test-{S20}-2", f"test-{S21}-0"}
    metadata = result.metadata
    assert metadata["stale"] and metadata["partial_sources"]
    assert metadata["refresh_errors"] == {S21: "provider_unavailable"}
    assert metadata["last_successful_refresh"] == "2026-10-17T12:00:00Z"
    assert metadata["last_attempted_refresh"] == "2026-10-17T12:16:00Z"
    assert metadata["cache_age_seconds"] == 960
    assert cache.status(later).status == "degraded"
    refresh(cache, Provider([], failures=(S20, S21)), later + timedelta(minutes=16))
    assert (
        len(
            cache.query(
                CA_BBOX, NOW - timedelta(hours=24), 500, now=later + timedelta(minutes=16)
            ).features
        )
        == 2
    )


def test_first_refresh_partial_source_failure_explicit(settings):
    cache = FireCache(settings)
    refresh(cache, Provider(failures=(S21,)))
    result = cache.query(CA_BBOX, NOW - timedelta(hours=24), 500, now=NOW)
    assert result.metadata["partial_sources"] and result.metadata["cache_status"] == "stale"
    assert len(result.features) == 1


def test_refresh_throttle_survives_new_process_and_lock_blocks_requests(settings):
    cache = FireCache(settings)
    refresh(cache, Provider())
    provider = Provider()
    assert refresh(FireCache(settings), provider, NOW + timedelta(minutes=1)) == "not_due"
    assert provider.calls == []
    with single_owner(cache.path.with_suffix(".lock")):
        assert (
            refresh(FireCache(settings), provider, NOW + timedelta(minutes=16), force=True)
            == "locked"
        )
    assert provider.calls == []
    assert refresh(cache, provider, NOW + timedelta(minutes=16)) == "refreshed"
    assert len(provider.calls) == 2


def test_age_and_acquisition_time_are_not_fetch_time(settings):
    cache = FireCache(settings)
    old = NOW - timedelta(hours=3)
    refresh(cache, Provider([observation(acquired_at=old)]))
    result = cache.query(CA_BBOX, NOW - timedelta(hours=24), 500, now=NOW + timedelta(minutes=16))
    assert result.metadata["stale"]
    assert result.metadata["observation_end"] == "2026-10-17T09:00:00Z"
    assert result.metadata["fetched_at"] == "2026-10-17T12:00:00Z"
    assert result.metadata["cache_age_seconds"] == 960


def test_bbox_time_limit_order_and_truncation(settings):
    cache = FireCache(settings)
    records = [observation(index=i, acquired_at=NOW - timedelta(minutes=i)) for i in range(3)]
    records += [
        observation(index=10, lon=-118),
        observation(index=11, acquired_at=NOW - timedelta(hours=25)),
    ]
    refresh(cache, Provider(records))
    result = cache.query((-122, 38, -121, 39), NOW - timedelta(hours=24), 2, now=NOW)
    assert [item.id for item in result.features] == [f"test-{S20}-0", f"test-{S20}-1"]
    assert result.metadata["matched_count"] == 3 and result.metadata["truncated"]
    assert not cache.query(CA_BBOX, NOW - timedelta(hours=24), 10, now=NOW).metadata["truncated"]


def test_census_boundary_filter_and_invalid_boundary_preserve_cache(settings):
    boundary = settings.firms_boundary_path
    boundary.parent.mkdir(parents=True)
    shape = {
        "type": "Polygon",
        "coordinates": [[[-122, 38], [-121, 38], [-121, 39], [-122, 39], [-122, 38]]],
    }
    boundary.write_text(
        json.dumps({"type": "FeatureCollection", "features": [{"geometry": shape}]})
    )
    cache = FireCache(settings)
    refresh(cache, Provider([observation(), observation(index=1, lon=-118)]))
    result = cache.query(CA_BBOX, NOW - timedelta(hours=24), 10, now=NOW)
    assert len(result.features) == 1 and "sha256" in result.metadata["boundary_filter"]
    assert result.metadata["sources"][S20]["outside_rows"] == 1
    boundary.write_text("invalid")
    provider = Provider()
    refresh(cache, provider, NOW + timedelta(minutes=16))
    assert provider.calls == []
    assert len(cache.read().sources[S20].records) == 1
    assert cache.status(NOW + timedelta(minutes=16)).last_error == "boundary_invalid"


def test_corrupt_cache_is_unavailable_and_atomic_writer_failure_keeps_valid_snapshot(
    settings, monkeypatch
):
    cache = FireCache(settings)
    refresh(cache, Provider())
    original = cache.path.read_bytes()
    import app.persistence.atomic as atomic

    def fail(*args):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(atomic, "durable_replace", fail)
    with pytest.raises(OSError):
        refresh(cache, Provider([]), NOW + timedelta(minutes=16))
    assert cache.path.read_bytes() == original
    assert not list(cache.path.parent.glob(".publish-*.tmp"))
    cache.path.write_text("corrupt JSON")
    assert FireCache(settings).read() is None


def test_no_network_on_get_status_startup_and_unavailable_is_503(client, settings):
    response = client.get("/api/v1/fires/live")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "firms_unavailable"
    assert response.json()["error"]["details"]["configured"] is False
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 200
    assert client.get("/api/v1/status").json()["providers"]["firms"]["configured"] is False
    assert not settings.shared_data_dir.exists()


@pytest.mark.parametrize(
    "query",
    [
        "hours=0",
        "hours=73",
        "hours=nan",
        "hours=inf",
        "limit=0",
        "limit=2001",
        "hours=24&since=2026-10-17T00:00:00Z",
        "since=2026-10-17T00:00:00",
        "since=invalid",
        "since=2099-01-01T00:00:00Z",
        "since=2020-01-01T00:00:00Z",
        "bbox=nan,33,-115,40",
        "bbox=-122,39,-123,40",
        "bbox=170,33,-170,40",
        "bbox=-180,-90,180,90",
        "bbox=-126,32,-113,43",
        "bbox=1,2,3",
        "bbox=-122,40,-121,39",
    ],
)
def test_api_invalid_inputs(client, query):
    response = client.get("/api/v1/fires/live?" + query)
    assert response.status_code == 422
    assert set(response.json()) == {"error"}


def test_api_cached_geojson_since_compatibility_and_provider_status(settings):
    now = datetime.now(UTC).replace(microsecond=0)
    cache = FireCache(settings)
    refresh(cache, Provider([observation(acquired_at=now - timedelta(hours=1))]), now)
    with TestClient(create_app(settings)) as client:
        response = client.get(
            "/api/v1/fires/live",
            params={
                "since": (now - timedelta(hours=48)).isoformat(),
                "bbox": ",".join(map(str, CA_BBOX)),
            },
        )
        assert response.status_code == 200
        result = response.json()
        assert result["type"] == "FeatureCollection" and len(result["features"]) == 1
        assert "last_success_at" in result["metadata"] and result["metadata"]["stale"] is False
        status = client.get("/api/v1/status").json()
        assert status["providers"]["firms"]["status"] == "healthy"
        assert status["forecast"]["status"] == "unavailable"
        paths = client.get("/openapi.json").json()["paths"]
        assert "/api/v1/fires/live" in paths and "/api/v1/forecasts/risk" in paths


def test_real_client_to_cache_to_api_with_mock_http(settings):
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    settings = Settings(
        _env_file=None, repo_root=settings.repo_root, nasa_firms_map_key="mock-secret"
    )
    header = "latitude,longitude,acq_date,acq_time,satellite,instrument,confidence,frp\n"

    def handler(request):
        satellite = "N20" if S20 in request.url.path else "N21"
        return httpx.Response(
            200, text=header + f"38.5,-121.5,{now:%Y-%m-%d},{now:%H%M},{satellite},VIIRS,n,12.4\n"
        )

    async def work():
        async with FirmsClient(settings, transport=httpx.MockTransport(handler)) as provider:
            await FireCache(settings).refresh(now=now, client=provider)

    asyncio.run(work())
    with TestClient(create_app(settings)) as client:
        result = client.get("/api/v1/fires/live").json()
        assert len(result["features"]) == 2
        assert result["metadata"]["configured"] is True
        assert "mock-secret" not in json.dumps(result)


def test_changed_boundary_with_outage_retains_old_observations(settings):
    cache = FireCache(settings)
    refresh(cache, Provider())
    settings.firms_boundary_path.parent.mkdir(parents=True)
    geometry = {
        "type": "Polygon",
        "coordinates": [[[-122, 38], [-121, 38], [-121, 39], [-122, 39], [-122, 38]]],
    }
    settings.firms_boundary_path.write_text(json.dumps({"features": [{"geometry": geometry}]}))
    later = NOW + timedelta(minutes=16)
    refresh(cache, Provider([], failures=(S20, S21)), later)
    result = cache.query(CA_BBOX, NOW - timedelta(hours=24), 10, now=later)
    assert len(result.features) == 1
    assert result.metadata["partial_boundary_coverage"] and result.metadata["stale"]


def test_actual_success_timestamp_is_completion_not_acquisition(settings):
    cache = FireCache(settings)
    before = datetime.now(UTC)
    asyncio.run(cache.refresh(client=Provider([observation()])))
    after = datetime.now(UTC)
    snapshot = cache.read().sources[S20]
    assert before <= snapshot.last_attempt <= snapshot.fetched_at <= after
    assert snapshot.records[0].acquired_at == NOW
