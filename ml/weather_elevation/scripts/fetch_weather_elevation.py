#!/usr/bin/env python3
"""Pilot-download California-only Open-Meteo 2024-25 weather and static elevations.

Python standard library only (s390x/LinuxONE friendly).
Input: CSV columns cell_id, latitude, longitude. Output: per-year weather CSVs,
static elevation CSV, and cached JSON responses.
"""

import argparse
import csv
import hashlib
import json
import math
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

WEATHER_URLS = {
    "historical-forecast": "https://historical-forecast-api.open-meteo.com/v1/forecast",
    "historical-weather": "https://archive-api.open-meteo.com/v1/archive",
}
ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
DAILY_FIELDS = [
    "temperature_2m_max",
    "temperature_2m_min",
    "relative_humidity_2m_min",
    "precipitation_sum",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
    "wind_direction_10m_dominant",
]
YEARS = (2024, 2025)
UNITS = dict(zip(DAILY_FIELDS, ["°C", "°C", "%", "mm", "m/s", "m/s", "°"]))


def retry_wait(value, attempt):
    """Respect both Retry-After formats; abort rather than retry too early."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            seconds = 2 ** (attempt + 1)
    if not math.isfinite(seconds) or seconds > 300:
        raise RuntimeError("Retry-After exceeds the pilot wait budget; retry later")
    return max(1.0, seconds)


def numeric(value, label, low=None, high=None):
    if value is None:  # CSV writes explicit missing API values as empty fields.
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"Invalid numeric value for {label}: {value!r}")
    if (low is not None and value < low) or (high is not None and value > high):
        raise ValueError(f"Out-of-range value for {label}: {value}")


def validate_weather(payload, year):
    if not isinstance(payload, dict) or payload.get("error"):
        raise ValueError("Invalid weather response")
    data = payload.get("daily") or {}
    expected = []
    day = date(year, 1, 1)
    while day.year == year:
        expected.append(day.isoformat())
        day += timedelta(days=1)
    if data.get("time") != expected:
        raise ValueError(f"{year}: expected {len(expected)} unique ordered daily dates")
    if payload.get("timezone") != "America/Los_Angeles":
        raise ValueError("Unexpected weather timezone")
    if payload.get("daily_units", {}).get("time") != "iso8601":
        raise ValueError("Unexpected date units")
    for field in DAILY_FIELDS:
        values = data.get(field)
        if not isinstance(values, list) or len(values) != len(expected):
            raise ValueError(f"{field} missing or wrong length")
        if payload.get("daily_units", {}).get(field) != UNITS[field]:
            raise ValueError(f"Unexpected units for {field}")
        low = 0 if field not in ("temperature_2m_max", "temperature_2m_min") else None
        high = 100 if field == "relative_humidity_2m_min" else 360 if field == "wind_direction_10m_dominant" else None
        for value in values:
            numeric(value, field, low, high)


def validate_elevation(payload, count):
    heights = payload.get("elevation") if isinstance(payload, dict) else None
    if not isinstance(heights, list) or len(heights) != count:
        raise ValueError(f"Elevation API expected {count} heights")
    for height in heights:
        numeric(height, "elevation_m")


def cached_json(url, params, cache, validate, delay):
    key = hashlib.sha256((url + "?" + urlencode(params)).encode()).hexdigest()
    path = cache / f"{key}.json"
    if path.exists():
        envelope = json.loads(path.read_text(encoding="utf-8"))
        payload = envelope["response"]
        validate(payload)
        return payload, "cache"
    payload = get_json(url, params)
    validate(payload)
    envelope = {"url": url, "params": params, "extracted_at_utc": datetime.now(timezone.utc).isoformat(), "response": payload}
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(envelope, allow_nan=False), encoding="utf-8")
    temporary.replace(path)
    time.sleep(delay)
    return payload, "API"


def get_json(url, params, retries=3):
    request_url = url + "?" + urlencode(params)
    for attempt in range(retries + 1):
        try:
            req = Request(request_url, headers={"User-Agent": "FireWatch-hackathon-data-prep/0.1"})
            with urlopen(req, timeout=90) as response:
                payload = json.load(response)
            if isinstance(payload, dict) and payload.get("error"):
                raise ValueError(f"API error: {payload.get('reason')}")
            return payload
        except HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise RuntimeError(f"HTTP {exc.code} fetching {request_url}") from exc
            retry_after = exc.headers.get("Retry-After")
            wait = retry_wait(retry_after, attempt)
            print(f"HTTP {exc.code}; retrying in {wait:.0f} s...", file=sys.stderr)
            time.sleep(wait)
        except (URLError, TimeoutError) as exc:
            if attempt == retries:
                raise RuntimeError(f"Network failure fetching {request_url}: {exc}") from exc
            time.sleep(2 ** (attempt + 1))


def read_cells(path, limit):
    cells = []
    seen = set()
    with path.open(newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            cid = row["cell_id"].strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", cid):
                raise ValueError(f"Unsafe/invalid cell_id: {cid!r}")
            if cid in seen:
                raise ValueError(f"Duplicate cell_id: {cid}")
            seen.add(cid)
            lat, lon = float(row["latitude"]), float(row["longitude"])
            if not math.isfinite(lat) or not math.isfinite(lon):
                raise ValueError(f"Nonfinite coordinates for {cid}")
            if not (32.0 <= lat <= 42.1 and -124.6 <= lon <= -114.0):
                raise ValueError(f"Coordinate outside broad California bounding area for {cid}: {lat},{lon}")
            cells.append({"cell_id": cid, "latitude": lat, "longitude": lon})
            if limit and len(cells) >= limit:
                break
    if not cells:
        raise ValueError("No cells found")
    return cells


def fetch_weather(cells, outdir, source, delay):
    cache = outdir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    output_fieldnames = ["cell_id", "latitude", "longitude", "date", *DAILY_FIELDS]
    for year in YEARS:
        result_file = outdir / f"weather_{year}.csv"
        print(f"\nDownloading {year} ({len(cells)} locations) -> {result_file}", flush=True)
        temporary_output = result_file.with_suffix(".csv.tmp")
        with temporary_output.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=output_fieldnames)
            writer.writeheader()
            for index, cell in enumerate(cells, start=1):
                payload, origin = cached_json(WEATHER_URLS[source], {
                    "latitude": cell["latitude"], "longitude": cell["longitude"],
                    "start_date": f"{year}-01-01", "end_date": f"{year}-12-31",
                    "daily": ",".join(DAILY_FIELDS), "timezone": "America/Los_Angeles",
                    "wind_speed_unit": "ms", "temperature_unit": "celsius",
                    "precipitation_unit": "mm",
                }, cache, lambda p: validate_weather(p, year), delay)
                data = payload["daily"]
                dates = data["time"]
                for pos, day in enumerate(dates):
                    record = {**cell, "date": day}
                    record.update({key: data[key][pos] for key in DAILY_FIELDS})
                    writer.writerow(record)
                print(f"  [{index}/{len(cells)}] {cell['cell_id']}: {len(dates)} days ({origin})", flush=True)
        temporary_output.replace(result_file)
        print(f"Saved {result_file}")


def fetch_elevation(cells, outdir, delay):
    cache = outdir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    results = {}
    # Small batches are friendlier to public services and avoid giant URL strings.
    for start in range(0, len(cells), 100):
        batch = cells[start:start + 100]
        payload, origin = cached_json(ELEVATION_URL, {
            "latitude": ",".join(str(c["latitude"]) for c in batch),
            "longitude": ",".join(str(c["longitude"]) for c in batch),
        }, cache, lambda p: validate_elevation(p, len(batch)), delay)
        heights = payload["elevation"]
        for cell, h in zip(batch, heights):
            results[cell["cell_id"]] = h
        print(f"Elevation: {len(batch)} points ({origin})", flush=True)
    result_file = outdir / "elevation.csv"
    with result_file.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=["cell_id", "latitude", "longitude", "elevation_m"])
        writer.writeheader()
        for cell in cells:
            writer.writerow({**cell, "elevation_m": results[cell["cell_id"]]})
    print(f"Saved {result_file}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cells", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "sample_california_cells.csv")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "output")
    ap.add_argument("--limit", type=int, default=1, help="Pilot-test only the first N points (default: 1)")
    ap.add_argument("--source", choices=WEATHER_URLS, default="historical-forecast")
    ap.add_argument("--delay", type=float, default=1.0, help="Seconds between uncached requests")
    ap.add_argument("--dry-run", action="store_true", help="Print planned work without API calls or output files")
    ap.add_argument("--weather-only", action="store_true", help="Fetch only weather (not elevation)")
    ap.add_argument("--elevation-only", action="store_true", help="Fetch only static elevation (not weather)")
    args = ap.parse_args()
    if args.limit is not None and args.limit < 1:
        ap.error("--limit must be positive")
    if not math.isfinite(args.delay) or args.delay < 1:
        ap.error("--delay must be finite and at least 1 second")
    if args.weather_only and args.elevation_only:
        ap.error("Choose --weather-only OR --elevation-only, not both")
    cells = read_cells(args.cells, args.limit)
    planned_weather_requests = 0 if args.elevation_only else len(cells) * len(YEARS)
    planned_elevation_requests = 0 if args.weather_only else math.ceil(len(cells) / 100)
    print(f"Using {len(cells)} California locations, source={args.source}.")
    print(f"At most {planned_weather_requests} uncached weather and {planned_elevation_requests} uncached elevation requests. Cached calls may reduce these counts.")
    if args.dry_run:
        print("DRY RUN: no network access or files written.")
        return
    if len(cells) >= 20:
        ap.error("Phase 1 permits fewer than 20 points, including elevation-only runs. Obtain approval before scaling.")
    args.out.mkdir(parents=True, exist_ok=True)
    if not args.elevation_only:
        fetch_weather(cells, args.out, args.source, args.delay)
    if not args.weather_only:
        fetch_elevation(cells, args.out, args.delay)
    print("\nDONE. Files are in:", args.out.resolve())
    print("Weather is model-derived, not direct weather-station measurement.")
    print("A historical weather time-series is NOT a seven-day archived forecast run.")


if __name__ == "__main__":
    main()
