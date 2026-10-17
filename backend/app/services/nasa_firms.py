"""Bounded official Area API client. Never expose the key-bearing request URL."""

import asyncio
import csv
import hashlib
import io
import logging
import random
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from app.config import Settings
from app.schemas.fires import Observation
from app.services.grid import CA_BBOX

BASE_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
REQUIRED = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument"}


class ProviderError(Exception):
    """Safe, categorical error; never carries a response body or request URL."""

    def __init__(self, category: str):
        self.category = category
        super().__init__(category)


class HideFirmsURLs(logging.Filter):
    def filter(self, record):
        # HTTPX logs successful requests at INFO; NASA puts the credential in the path.
        message = record.getMessage()
        return "/api/area/csv/" not in message and "firms.modaps.eosdis.nasa.gov" not in message


def protect_provider_logs():
    for name in ("httpx", "httpcore.connection", "httpcore.http11", "httpcore.http2"):
        logger = logging.getLogger(name)
        if not any(isinstance(item, HideFirmsURLs) for item in logger.filters):
            logger.addFilter(HideFirmsURLs())


def parse_csv(text: str, source: str, start: datetime, end: datetime, max_rows: int):
    """Validate each row and return deterministic observations plus aggregate counts."""
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")), strict=True)
    if not reader.fieldnames or not REQUIRED.issubset(reader.fieldnames):
        raise ProviderError("malformed_csv")
    if len(reader.fieldnames) != len(set(reader.fieldnames)):
        raise ProviderError("malformed_csv")
    expected_satellite = "NOAA-20" if source == "VIIRS_NOAA20_NRT" else "NOAA-21"
    satellite_codes = {"NOAA-20": {"N20", "NOAA-20", "1"}, "NOAA-21": {"N21", "NOAA-21", "2"}}
    records = {}
    invalid = duplicates = outside = total = 0
    try:
        for total, row in enumerate(reader, 1):
            if total > max_rows:
                raise ProviderError("response_too_large")
            try:
                if None in row or any(value is None for value in row.values()):
                    raise ValueError("Invalid CSV row width")
                clock = row["acq_time"].strip()
                if not clock.isascii() or not clock.isdigit() or not 1 <= len(clock) <= 4:
                    raise ValueError("Invalid UTC acquisition time")
                clock = clock.zfill(4)
                day = datetime.strptime(row["acq_date"].strip(), "%Y-%m-%d").date()
                acquired = datetime(
                    day.year, day.month, day.day, int(clock[:2]), int(clock[2:]), tzinfo=UTC
                )
                if row["satellite"].strip() not in satellite_codes[expected_satellite]:
                    raise ValueError("Unexpected satellite")
                if row["instrument"].strip().upper() != "VIIRS":
                    raise ValueError("Unexpected instrument")
                latitude, longitude = float(row["latitude"]), float(row["longitude"])
                identity = f"{source}|{acquired.isoformat()}|{latitude:.8f}|{longitude:.8f}"

                def number(name, row=row):
                    value = row.get(name, "").strip()
                    return float(value) if value else None

                record = Observation(
                    id="firms-" + hashlib.sha256(identity.encode()).hexdigest()[:32],
                    latitude=latitude,
                    longitude=longitude,
                    acquired_at=acquired,
                    source=source,
                    satellite=expected_satellite,
                    confidence=row.get("confidence", "").strip().lower() or None,
                    frp=number("frp"),
                    daynight=row.get("daynight", "").strip().upper() or None,
                    brightness=number("bright_ti4"),
                    bright_ti5=number("bright_ti5"),
                    scan=number("scan"),
                    track=number("track"),
                    version=row.get("version", "").strip() or None,
                )
                west, south, east, north = CA_BBOX
                if acquired > end:
                    raise ValueError("Acquisition timestamp is in the future")
                if acquired < start or not (
                    west <= longitude <= east and south <= latitude <= north
                ):
                    outside += 1
                    continue
                if record.id in records:
                    duplicates += 1
                    # Stable choice even if conflicting duplicate rows change provider order.
                    if record.model_dump_json() >= records[record.id].model_dump_json():
                        continue
                records[record.id] = record
            except (ValueError, TypeError, OverflowError, ValidationError):
                invalid += 1
    except csv.Error:
        raise ProviderError("malformed_csv") from None
    if total and invalid == total:
        raise ProviderError("invalid_observations")
    logging.getLogger("firewatch").info(
        "firms_parse source=%s invalid_rows=%d duplicate_rows=%d outside_rows=%d",
        source,
        invalid,
        duplicates,
        outside,
    )
    return sorted(records.values(), key=lambda item: (-item.acquired_at.timestamp(), item.id)), {
        "invalid_rows": invalid,
        "duplicate_rows": duplicates,
        "outside_rows": outside,
    }


class FirmsClient:
    def __init__(self, settings: Settings, *, transport=None, sleep=asyncio.sleep):
        self.settings = settings
        self.sleep = sleep
        protect_provider_logs()
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.request_timeout_seconds),
            limits=httpx.Limits(max_connections=2, max_keepalive_connections=2),
            follow_redirects=False,
            transport=transport,
            trust_env=False,
        )

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.http.aclose()

    async def fetch(self, source: str, now: datetime):
        secret = self.settings.nasa_firms_map_key or self.settings.firms_map_key
        if secret is None or not secret.get_secret_value().strip():
            raise ProviderError("credentials_missing")
        if source not in self.settings.firms_sources:
            raise ProviderError("unsupported_source")
        start = now - timedelta(hours=self.settings.firms_max_hours)
        days = (now.date() - start.date()).days + 1
        bounds = ",".join(str(value) for value in CA_BBOX)
        url = (
            f"{self.settings.firms_base_url}/{quote(secret.get_secret_value(), safe='')}/"
            f"{source}/{bounds}/{days}/{start.date().isoformat()}"
        )
        for attempt in range(self.settings.provider_max_retries + 1):
            delay = min(8.0, 0.5 * 2**attempt + random.uniform(0, 0.25))
            try:
                # Bound the whole attempt, including a server that dribbles response bytes.
                async with asyncio.timeout(self.settings.request_timeout_seconds):
                    async with self.http.stream("GET", url) as response:
                        if response.status_code in {401, 403}:
                            raise ProviderError("credentials_rejected")
                        if response.status_code == 429 or 500 <= response.status_code <= 599:
                            category = (
                                "rate_limited"
                                if response.status_code == 429
                                else "provider_unavailable"
                            )
                            retry_after = response.headers.get("Retry-After")
                            if retry_after:
                                try:
                                    delay = max(0, float(retry_after))
                                except ValueError:
                                    try:
                                        delay = max(
                                            0,
                                            (
                                                parsedate_to_datetime(retry_after) - now
                                            ).total_seconds(),
                                        )
                                    except (ValueError, TypeError, OverflowError):
                                        pass
                            if delay > 30 or attempt == self.settings.provider_max_retries:
                                raise ProviderError(category)
                        elif response.status_code != 200:
                            raise ProviderError("unexpected_response")
                        else:
                            payload = bytearray()
                            async for chunk in response.aiter_bytes():
                                payload.extend(chunk)
                                if len(payload) > self.settings.firms_max_response_bytes:
                                    raise ProviderError("response_too_large")
                            try:
                                text = payload.decode("utf-8-sig")
                            except UnicodeError:
                                raise ProviderError("malformed_csv") from None
                            if (
                                "invalid map_key" in text[:300].lower()
                                or "invalid map key" in text[:300].lower()
                            ):
                                raise ProviderError("credentials_rejected")
                            records, counts = parse_csv(
                                text, source, start, now, self.settings.firms_max_rows
                            )
                            return records, counts, start
            except (httpx.TimeoutException, TimeoutError):
                category = "timeout"
            except httpx.RequestError:
                category = "connection_failed"
            if attempt == self.settings.provider_max_retries:
                raise ProviderError(category) from None
            await self.sleep(delay)
        raise ProviderError("provider_unavailable")
