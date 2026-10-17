import asyncio
import logging
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from app.config import Settings
from app.services.nasa_firms import FirmsClient, ProviderError, parse_csv

NOW = datetime(2026, 10, 17, 12, tzinfo=UTC)
SOURCE = "VIIRS_NOAA20_NRT"
HEADER = (
    "latitude,longitude,acq_date,acq_time,satellite,instrument,confidence,frp,"
    "daynight,bright_ti4,scan,track\n"
)
ROW = "38.5,-121.5,2026-10-17,5,N20,VIIRS,n,12.4,D,310.5,0.4,0.5\n"


def parse(text, source=SOURCE, max_rows=100):
    return parse_csv(text, source, NOW - timedelta(hours=72), NOW, max_rows)


def test_normalizes_utc_units_ids_and_duplicate_order():
    records, counts = parse(HEADER + ROW + ROW)
    assert len(records) == 1 and counts["duplicate_rows"] == 1
    item = records[0]
    assert item.acquired_at == datetime(2026, 10, 17, 0, 5, tzinfo=UTC)
    assert item.frp == 12.4 and item.confidence == "n" and item.brightness == 310.5
    assert item.id == parse(HEADER + ROW)[0][0].id
    other = parse(HEADER + ROW.replace("N20", "N21"), "VIIRS_NOAA21_NRT")[0][0]
    assert other.id != item.id
    assert item.satellite == "NOAA-20" and other.satellite == "NOAA-21"


@pytest.mark.parametrize(
    "bad",
    [
        ROW.replace("38.5", "91"),
        ROW.replace("-121.5", "nan"),
        ROW.replace(",12.4,", ",inf,"),
        ROW.replace(",5,", ",2460,"),
        ROW.replace(",5,", ",,"),
        ROW.replace("2026-10-17", "2026-02-30"),
        ROW.replace("N20", "N21"),
        ROW.replace("VIIRS", "MODIS"),
        ROW.replace(",n,", ",98,"),
        ROW.replace(",5,", ",1259,"),
    ],
)
def test_invalid_rows_rejected_without_discarding_good_rows(bad):
    records, counts = parse(HEADER + ROW + bad)
    assert len(records) == 1 and counts["invalid_rows"] == 1
    with pytest.raises(ProviderError, match="invalid_observations"):
        parse(HEADER + bad)


def test_empty_unknown_fields_bounds_and_row_cap():
    assert parse(HEADER)[0] == []
    records, counts = parse(HEADER + ROW.replace("38.5", "30"))
    assert not records and counts["outside_rows"] == 1
    assert parse(HEADER.rstrip() + ",new_field\n" + ROW.rstrip() + ",value\n")[0]
    with pytest.raises(ProviderError, match="response_too_large"):
        parse(HEADER + ROW * 2, max_rows=1)
    with pytest.raises(ProviderError, match="malformed_csv"):
        parse("an HTML error instead of CSV")
    with pytest.raises(ProviderError, match="malformed_csv"):
        parse(HEADER + '"unterminated')


def run_fetch(settings, handler, *, sleep=None):
    async def work():
        async with FirmsClient(
            settings, transport=httpx.MockTransport(handler), **({"sleep": sleep} if sleep else {})
        ) as client:
            result = await client.fetch(SOURCE, NOW)
        assert client.http.is_closed
        return result

    return asyncio.run(work())


def test_official_area_request_covers_midnight_and_redacts_logs(settings, caplog):
    settings = settings.model_copy(update={"nasa_firms_map_key": SecretStr("unit-test-key")})

    def handler(request):
        assert request.url.host == "firms.modaps.eosdis.nasa.gov"
        assert request.url.path.endswith("/4/2026-10-14")
        return httpx.Response(200, text=HEADER + ROW)

    with caplog.at_level(logging.DEBUG):
        assert run_fetch(settings, handler)[0]
    assert "unit-test-key" not in caplog.text


@pytest.mark.parametrize(
    "status,category",
    [
        (401, "credentials_rejected"),
        (403, "credentials_rejected"),
        (302, "unexpected_response"),
        (404, "unexpected_response"),
    ],
)
def test_nonretryable_http_errors(settings, status, category):
    settings = Settings(_env_file=None, repo_root=settings.repo_root, nasa_firms_map_key="test")
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status)

    with pytest.raises(ProviderError, match=category):
        run_fetch(settings, handler)
    assert len(calls) == 1


@pytest.mark.parametrize("failure", [429, 500, 502, 503, "timeout", "connection"])
def test_bounded_retries_recover(settings, failure):
    settings = Settings(_env_file=None, repo_root=settings.repo_root, nasa_firms_map_key="test")
    calls, delays = [], []

    def handler(request):
        calls.append(1)
        if len(calls) > 1:
            return httpx.Response(200, text=HEADER + ROW)
        if failure == "timeout":
            raise httpx.ReadTimeout("safe mock")
        if failure == "connection":
            raise httpx.ConnectError("safe mock")
        return httpx.Response(failure, headers={"Retry-After": "2"})

    async def sleep(delay):
        delays.append(delay)

    assert run_fetch(settings, handler, sleep=sleep)[0]
    assert len(calls) == 2 and len(delays) == 1
    assert 0 < delays[0] <= 30


def test_missing_key_no_http_and_retry_after_does_not_bypass_quota(settings):
    def unexpected(request):
        raise AssertionError("No HTTP expected")

    with pytest.raises(ProviderError, match="credentials_missing"):
        run_fetch(settings, unexpected)
    settings = Settings(_env_file=None, repo_root=settings.repo_root, nasa_firms_map_key="test")
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(429, headers={"Retry-After": "120"})

    with pytest.raises(ProviderError, match="rate_limited"):
        run_fetch(settings, handler)
    assert len(calls) == 1


def test_response_size_invalid_key_and_retry_exhaustion(settings):
    settings = Settings(
        _env_file=None,
        repo_root=settings.repo_root,
        nasa_firms_map_key="test",
        firms_max_response_bytes=1024,
        provider_max_retries=0,
    )
    for response, error in [
        (httpx.Response(200, text="x" * 1025), "response_too_large"),
        (httpx.Response(200, text="Invalid MAP_KEY"), "credentials_rejected"),
        (httpx.Response(503), "provider_unavailable"),
    ]:
        with pytest.raises(ProviderError, match=error):
            run_fetch(settings, lambda request, response=response: response)


@pytest.mark.parametrize(
    "values",
    [
        {"firms_sources": []},
        {"firms_sources": [SOURCE, SOURCE]},
        {"firms_sources": ["MODIS_NRT"]},
        {"firms_max_hours": 73},
        {"firms_base_url": "http://example.com/api/area/csv"},
        {"firms_default_limit": 100, "firms_max_limit": 10},
    ],
)
def test_firms_configuration_bounds(values):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **values)


def test_new_key_environment_and_legacy_compatibility(monkeypatch):
    monkeypatch.setenv("NASA_FIRMS_MAP_KEY", "new-test-key")
    settings = Settings(_env_file=None, firms_map_key="legacy-test-key")
    assert settings.nasa_firms_map_key.get_secret_value() == "new-test-key"
    assert "new-test-key" not in repr(settings)
    assert "legacy-test-key" not in settings.model_dump_json()
