#!/usr/bin/env python3
"""Resumable stdlib extraction from the EXISTING grid. Default: offline plan.

--live authorizes only the 10-anchor/20-cell pilot unless --scope statewide AND
--approve-statewide are supplied after separate approval. Never regenerates grids.
"""
import argparse
import csv
import gzip
import hashlib
from http.client import IncompleteRead
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fetch_weather_elevation import (DAILY_FIELDS, YEARS, UNITS, WEATHER_URLS,
                                     ELEVATION_URL, validate_weather,
                                     validate_elevation, numeric, retry_wait)

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "historical-weather-reconstructed"
WEATHER_BATCH = 10
ELEVATION_BATCH = 100


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_table(path, key):
    with path.open(newline="", encoding="utf-8-sig") as stream:
        rows = list(csv.DictReader(stream))
    if not rows or any(key not in r for r in rows):
        raise ValueError(f"Missing {key} or empty input: {path}")
    if len({r[key] for r in rows}) != len(rows):
        raise ValueError(f"Duplicate {key} in {path}")
    return rows


def coordinate(row):
    for field, low, high in (("latitude", -90, 90), ("longitude", -180, 180)):
        value = float(row[field])
        numeric(value, field, low, high)
        row[field] = value
    for field in ("cell_id", "weather_anchor_id"):
        if field in row and not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", row[field]):
            raise ValueError(f"Invalid {field}")
    return row


def inputs(directory, scope):
    anchors = [coordinate(r) for r in read_table(directory / "california_grid_3km_weather_anchors.csv", "weather_anchor_id")]
    cells = [coordinate(r) for r in read_table(directory / "california_grid_3km.csv", "cell_id")]
    mapping = read_table(directory / "california_grid_3km_cell_weather_mapping.csv", "cell_id")
    anchor_ids = {a["weather_anchor_id"] for a in anchors}
    by_cell = {c["cell_id"]: c for c in cells}
    grouped = {aid: [] for aid in anchor_ids}
    if {r["cell_id"] for r in mapping} != set(by_cell):
        raise ValueError("Mapping does not cover the grid exactly")
    for r in mapping:
        cell = by_cell[r["cell_id"]]
        if r["weather_anchor_id"] not in anchor_ids or cell["weather_anchor_id"] != r["weather_anchor_id"] or r["grid_version"] != cell["grid_version"]:
            raise ValueError("Inconsistent grid-to-anchor mapping")
        grouped[r["weather_anchor_id"]].append(cell)
    if scope == "pilot":
        eligible = [a for a in anchors if len(grouped[a["weather_anchor_id"]]) >= 2]
        if len(eligible) < 10:
            raise ValueError("Need ten anchors with at least two mapped cells each")
        anchors = [eligible[i * (len(eligible) - 1) // 9] for i in range(10)]
        cells = [c for a in anchors for c in grouped[a["weather_anchor_id"]][:2]]
        chosen = {c["cell_id"] for c in cells}
        mapping = [r for r in mapping if r["cell_id"] in chosen]
    return anchors, cells, mapping


def batches(rows, size):
    for start in range(0, len(rows), size):
        yield rows[start:start + size]


def weather_params(batch, year):
    return {
        "latitude": ",".join(str(r["latitude"]) for r in batch),
        "longitude": ",".join(str(r["longitude"]) for r in batch),
        "start_date": f"{year}-01-01", "end_date": f"{year}-12-31",
        "daily": ",".join(DAILY_FIELDS), "timezone": "America/Los_Angeles",
        "wind_speed_unit": "ms", "temperature_unit": "celsius",
        "precipitation_unit": "mm", "models": "best_match", "cell_selection": "land",
    }


def response_locations(payload, batch, year):
    locations = payload if isinstance(payload, list) else [payload]
    if len(locations) != len(batch):
        raise ValueError("Weather response location count mismatch")
    for index, (location, anchor) in enumerate(zip(locations, batch)):
        validate_weather(location, year)
        if location.get("location_id", index) != index:
            raise ValueError("Unexpected provider location ordering")
        for field, low, high in (("latitude", -90, 90), ("longitude", -180, 180)):
            value = location.get(field)
            if value is None:
                raise ValueError("Missing provider model coordinates")
            numeric(value, field, low, high)
        # Provider coordinates refer to its selected model point, not the request.
        lat1, lat2 = math.radians(anchor["latitude"]), math.radians(location["latitude"])
        dlat = lat2 - lat1
        dlon = math.radians(location["longitude"] - anchor["longitude"])
        a = math.sin(dlat / 2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon / 2)**2
        distance = 6371000 * 2 * math.asin(min(1, math.sqrt(a)))
        if distance > 100000:
            raise ValueError("Provider model coordinate more than 100 km from requested anchor")
    return locations


class Client:
    """One writer, serial requests. Shared persisted rolling usage ledger."""
    def __init__(self, out, ledger):
        self.cache = out / "cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.ledger = ledger
        self.stats = {"http_attempts": 0, "successful_http_responses": 0, "cache_hits": 0,
                      "downloaded_body_bytes": 0, "rate_limit_sleep_seconds": 0,
                      "retry_sleep_seconds": 0, "estimated_attempt_call_units": 0}

    def reserve(self, units):
        events = json.loads(self.ledger.read_text()) if self.ledger.exists() else []
        now = time.time()
        events = [e for e in events if e["at"] > now - 30 * 86400]
        # Conservative safety margins below published shared-IP free limits.
        for window, cap in ((60, 500), (3600, 4000), (86400, 8000), (30*86400, 240000)):
            active = [e for e in events if e["at"] > now - window]
            if sum(e["units"] for e in active) + units > cap:
                if window > 60:
                    raise RuntimeError("Hourly/daily/monthly local usage budget reached; resume later")
                wait = max(1, min(e["at"] + window for e in active) - now + 1)
                self.stats["rate_limit_sleep_seconds"] += wait
                print(f"Local quota pacing: waiting {wait:.1f} seconds", flush=True)
                time.sleep(wait)
                return self.reserve(units)
        events.append({"at": now, "units": units})
        atomic_json(self.ledger, events)  # Reserve BEFORE attempting the request.
        self.stats["estimated_attempt_call_units"] += units

    def request(self, url, params, units):
        for attempt in range(4):
            self.reserve(units)
            self.stats["http_attempts"] += 1
            try:
                req = Request(url + "?" + urlencode(params), headers={
                    "User-Agent": "FireWatch-datathon-pilot/1", "Accept-Encoding": "gzip"})
                with urlopen(req, timeout=90) as response:
                    body = response.read(20_000_001)
                    self.stats["downloaded_body_bytes"] += len(body)
                    if len(body) > 20_000_000:
                        raise ValueError("Response exceeds 20 MB batch limit")
                    if response.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                    payload = json.loads(body)
                if isinstance(payload, dict) and payload.get("error"):
                    raise ValueError(f"API rejected request: {payload.get('reason')}")
                self.stats["successful_http_responses"] += 1
                time.sleep(1)
                return payload
            except HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise RuntimeError(f"HTTP {exc.code} from {url}") from exc
                wait = retry_wait(exc.headers.get("Retry-After"), attempt)
            except (URLError, TimeoutError, ConnectionError, IncompleteRead) as exc:
                if attempt == 3:
                    raise RuntimeError(f"Network failure from {url}") from exc
                wait = 2 ** (attempt + 1)
            self.stats["retry_sleep_seconds"] += wait
            print(f"Temporary error; retrying after {wait:.1f} seconds", flush=True)
            time.sleep(wait)

    def get(self, url, params, ids, validate, units):
        identity = {"url": url, "params": params, "ids": ids}
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        path = self.cache / f"{key}.json"
        if path.exists():
            envelope = json.loads(path.read_text(encoding="utf-8"))
            if any(envelope[k] != v for k, v in identity.items()):
                raise ValueError("Cache identity mismatch")
            validate(envelope["response"])
            self.stats["cache_hits"] += 1
        else:
            payload = self.request(url, params, units)
            validate(payload)
            envelope = {**identity, "response": payload,
                        "extracted_at_utc": datetime.now(timezone.utc).isoformat()}
            atomic_json(path, envelope)
        return envelope, key


def write_csv(path, fields, rows):
    temp = path.with_suffix(".csv.tmp")
    count = 0
    with temp.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
            count += 1
    temp.replace(path)
    return count


def plan(anchors, cells):
    return {"anchors": len(anchors), "elevation_points": len(cells),
            "weather_batch_size": WEATHER_BATCH, "elevation_batch_size": ELEVATION_BATCH,
            "weather_http_requests_before_retries": 2 * math.ceil(len(anchors) / WEATHER_BATCH),
            "elevation_http_requests_before_retries": math.ceil(len(cells) / ELEVATION_BATCH),
            "weather_rows": len(anchors) * 731,
            "estimated_weather_call_units": len(anchors) * 731 / 14,
            "conservative_elevation_call_units": len(cells)}


def run(directory, out, ledger, scope="pilot", live=False):
    started = time.monotonic()
    anchors, cells, mapping = inputs(directory, scope)
    work = plan(anchors, cells)
    print(json.dumps(work, indent=2), flush=True)
    if not live:
        print("PLAN ONLY: no requests or files written")
        return work
    out.mkdir(parents=True, exist_ok=True)
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (
        directory / "california_grid_3km.csv", directory / "california_grid_3km_weather_anchors.csv",
        directory / "california_grid_3km_cell_weather_mapping.csv")}
    config = {"scope": scope, "input_sha256": hashes, "source": SOURCE, "model_selection": "best_match",
              "years": list(YEARS), "weather_anchor_ids": [a["weather_anchor_id"] for a in anchors],
              "elevation_cell_ids": [c["cell_id"] for c in cells], "daily_variables": DAILY_FIELDS,
              "weather_batch_size": WEATHER_BATCH, "elevation_batch_size": ELEVATION_BATCH}
    config_path = out / "run_config.json"
    if config_path.exists() and json.loads(config_path.read_text()) != config:
        raise ValueError("Output directory belongs to a different selection or source; use another directory")
    atomic_json(config_path, config)
    client = Client(out, ledger)
    checkpoint = {"completed_validated_cache_keys": [], "status": "in_progress"}
    report = {"plan": work, "data_quality": {}, "source": SOURCE,
              "timezone": "America/Los_Angeles", "units": UNITS,
              "missing_policy": "null becomes empty CSV field; no imputation",
              "attribution": "Weather: Open-Meteo and its source datasets (CC BY 4.0). Elevation: Open-Meteo / Copernicus DEM GLO-90, DOI 10.5270/ESA-c5d3d65.",
              "usage_note": "Estimated weighted units, not measured billing; ledger covers only this runner, not other users on the same IP."}
    try:
        write_csv(out / "selected_weather_anchors.csv", ["weather_anchor_id", "latitude", "longitude"],
                  ({k: a[k] for k in ("weather_anchor_id", "latitude", "longitude")} for a in anchors))
        write_csv(out / "cell_weather_mapping.csv", list(mapping[0]), mapping)
        for year in YEARS:
            missing = {field: 0 for field in DAILY_FIELDS}
            def weather_rows():
                for batch in batches(anchors, WEATHER_BATCH):
                    params = weather_params(batch, year)
                    units = len(batch) * (366 if year == 2024 else 365) / 14
                    envelope, key = client.get(WEATHER_URLS["historical-weather"], params,
                        [a["weather_anchor_id"] for a in batch],
                        lambda p: response_locations(p, batch, year), units)
                    checkpoint["completed_validated_cache_keys"].append(key)
                    atomic_json(out / "checkpoint.json", checkpoint)
                    for anchor, location in zip(batch, response_locations(envelope["response"], batch, year)):
                        for i, day in enumerate(location["daily"]["time"]):
                            values = {field: location["daily"][field][i] for field in DAILY_FIELDS}
                            for field, value in values.items():
                                missing[field] += value is None
                            yield {"weather_anchor_id": anchor["weather_anchor_id"],
                                "latitude": anchor["latitude"], "longitude": anchor["longitude"], "date": day,
                                "model_latitude": location["latitude"], "model_longitude": location["longitude"],
                                "weather_source": SOURCE, "model_selection": "best_match",
                                "extracted_at_utc": envelope["extracted_at_utc"], **values}
            fields = ["weather_anchor_id", "latitude", "longitude", "date", "model_latitude", "model_longitude",
                      "weather_source", "model_selection", "extracted_at_utc", *DAILY_FIELDS]
            count = write_csv(out / f"weather_{year}.csv", fields, weather_rows())
            expected = len(anchors) * (366 if year == 2024 else 365)
            if count != expected:
                raise ValueError("Weather row count mismatch")
            report["data_quality"][str(year)] = {"rows": count, "missing_by_variable": missing,
                "duplicate_anchor_dates": 0, "date_validation": "exact complete ordered calendar for every unique anchor"}
        elevation_missing = 0
        def elevation_rows():
            nonlocal elevation_missing
            for batch in batches(cells, ELEVATION_BATCH):
                params = {field: ",".join(str(c[field]) for c in batch) for field in ("latitude", "longitude")}
                envelope, key = client.get(ELEVATION_URL, params, [c["cell_id"] for c in batch],
                    lambda p: validate_elevation(p, len(batch)), len(batch))
                checkpoint["completed_validated_cache_keys"].append(key)
                atomic_json(out / "checkpoint.json", checkpoint)
                for cell, height in zip(batch, envelope["response"]["elevation"]):
                    elevation_missing += height is None
                    yield {"grid_version": cell["grid_version"], "cell_id": cell["cell_id"],
                           "latitude": cell["latitude"], "longitude": cell["longitude"],
                           "elevation_m": height, "extracted_at_utc": envelope["extracted_at_utc"]}
        count = write_csv(out / "elevation.csv", ["grid_version", "cell_id", "latitude", "longitude", "elevation_m", "extracted_at_utc"], elevation_rows())
        report["data_quality"]["elevation"] = {"rows": count, "missing": elevation_missing, "duplicate_cell_ids": 0}
        checkpoint["status"] = "complete"
        report["status"] = "complete"
    except BaseException as exc:
        report["status"] = "interrupted_or_failed"
        report["error_type"] = type(exc).__name__
        raise
    finally:
        atomic_json(out / "checkpoint.json", checkpoint)
        report["runtime_seconds"] = time.monotonic() - started
        report["api_usage_this_run"] = client.stats
        report["csv_bytes"] = {p.name: p.stat().st_size for p in out.glob("*.csv")}
        report["cache_bytes"] = sum(p.stat().st_size for p in (out / "cache").glob("*.json"))
        report["reported_at_utc"] = datetime.now(timezone.utc).isoformat()
        atomic_json(out / "run_history" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json"), report)
        atomic_json(out / "run_report.json", report)
    print(json.dumps(report, indent=2), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, default=ROOT / "data/processed")
    parser.add_argument("--out", type=Path, default=ROOT / "output/extraction_pilot")
    parser.add_argument("--usage-ledger", type=Path, default=ROOT / "output/open_meteo_usage.json")
    parser.add_argument("--scope", choices=("pilot", "statewide"), default="pilot")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--approve-statewide", action="store_true", help="Use only after explicit approval for the statewide estimate")
    args = parser.parse_args()
    if args.scope == "statewide" and args.live and not args.approve_statewide:
        parser.error("Statewide live extraction requires separate approval and --approve-statewide")
    run(args.inputs, args.out, args.usage_ledger, args.scope, args.live)


if __name__ == "__main__":
    main()
