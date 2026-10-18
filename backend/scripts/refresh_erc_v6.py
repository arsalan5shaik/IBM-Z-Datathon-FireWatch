"""Refresh the experimental Stockton V6 snapshot safely."""

import argparse
import fcntl
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "shared/data/erc-v6"
MODEL = ROOT / "ml-prep/models/releases/firewatch_erc_v6_2023_2025/model.json"
FEATURES_JSON = ROOT / "ml-prep/models/releases/firewatch_erc_v6_2023_2025/features.json"
EXPECTED_SHA = "cb124badd47c898448c30500fe13f4827481e1986bd2a776605a0b99308b2e33"
CELL_ID = "CA3K_X-0038_Y-0002"

REQUIRED_FEATURES = (
    "temp_max_c",
    "rh_min_pct",
    "wind_mean_ms",
    "precip_mm",
    "elevation_mean_m",
    "lat",
    "lon",
    "day_sin",
    "day_cos",
    "precip_7d_mm",
    "precip_30d_mm",
    "temp_mean_7d_c",
    "rh_mean_7d_pct",
    "dry_days_14d",
    "wind_mean_7d_ms",
)


def validate(data):
    if data.get("kind") != "experimental_stockton_weather_driven_erc_g_probe":
        raise ValueError("Unexpected snapshot type")

    if data.get("model_sha256") != EXPECTED_SHA:
        raise ValueError("Model checksum mismatch in snapshot")

    if data.get("model_version") != "firewatch_erc_v6_2023_2025":
        raise ValueError("Unexpected model version")

    if not data.get("snapshot_id"):
        raise ValueError("Missing snapshot identifier")

    retrieved = datetime.fromisoformat(data["retrieved_at_utc"].replace("Z", "+00:00"))
    if retrieved.tzinfo is None:
        raise ValueError("Retrieval timestamp has no timezone")

    age = abs((datetime.now(UTC) - retrieved).total_seconds())
    if age > 1800:
        raise ValueError("Weather retrieval timestamp is stale")

    rows = data.get("predictions")
    if not isinstance(rows, list) or len(rows) != 7:
        raise ValueError("Expected exactly seven predictions")

    today = datetime.now(UTC).date()
    dates = set()

    for row in rows:
        if row.get("cell_id") != CELL_ID or row.get("data_status") != "ok":
            raise ValueError("Invalid cell or prediction status")

        valid_date = date.fromisoformat(row["valid_date"])
        if valid_date in dates:
            raise ValueError("Duplicate forecast date")
        dates.add(valid_date)

        lead = row.get("lead_day")
        if type(lead) is not int or lead not in range(1, 8):
            raise ValueError("Invalid lead day")

        if valid_date != today + timedelta(days=lead):
            raise ValueError("Date does not match forecast lead")

        features = row.get("features")
        if not isinstance(features, dict) or tuple(features) != REQUIRED_FEATURES:
            raise ValueError("Unexpected feature vector")

        for value in features.values():
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError("Missing or nonfinite feature")

        raw = row.get("erc_g_raw")
        display = row.get("erc_g_display")
        if (
            type(raw) not in (int, float)
            or type(display) not in (int, float)
            or not math.isfinite(raw)
            or not math.isfinite(display)
            or abs(display - max(0.0, raw)) > 1e-5
        ):
            raise ValueError("Invalid ERC-G result")

    if dates != {today + timedelta(days=i) for i in range(1, 8)}:
        raise ValueError("Incomplete daily forecast dates")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--probe-script",
        type=Path,
        default=Path.home() / "firewatch_v6_live_starter/stockton_live_v6.py",
    )
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = OUTPUT_DIR / ".refresh.lock"

    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Refresh already running; no changes made.")
            return 0

        if hashlib.sha256(MODEL.read_bytes()).hexdigest() != EXPECTED_SHA:
            raise ValueError("Frozen model SHA-256 verification failed")

        with tempfile.TemporaryDirectory(prefix="erc-v6-") as temp_dir:
            result_path = Path(temp_dir) / "probe.json"

            cmd = [
                sys.executable,
                str(args.probe_script),
                "--model",
                str(MODEL),
                "--features-json",
                str(FEATURES_JSON),
                "--cell-id",
                CELL_ID,
                "--latitude",
                "37.969042",
                "--longitude",
                "-121.282320",
                "--elevation-m",
                "4.76",
                "--output",
                str(result_path),
            ]

            subprocess.run(cmd, check=True, timeout=240)
            data = json.loads(result_path.read_text())
            validate(data)

            current = OUTPUT_DIR / "current.json"

            # Publish a versioned immutable copy first.
            content = json.dumps(data, indent=2, allow_nan=False).encode()
            content_hash = hashlib.sha256(content).hexdigest()[:16]
            version_path = OUTPUT_DIR / f"snapshot-{content_hash}.json"

            if not version_path.exists():
                fd = os.open(
                    version_path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                with os.fdopen(fd, "wb") as file:
                    file.write(content)
                    file.flush()
                    os.fsync(file.fileno())

            # Replace the current pointer atomically on the same filesystem.
            fd, pending = tempfile.mkstemp(prefix=".pending-", suffix=".json", dir=OUTPUT_DIR)
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(content)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(pending, current)
            finally:
                if os.path.exists(pending):
                    os.unlink(pending)

            # Persist the directory rename where supported.
            dir_fd = os.open(OUTPUT_DIR, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)

            print("SUCCESS: Atomic snapshot published")
            print("Snapshot:", data["snapshot_id"])
            print("Forecasts:", len(data["predictions"]))
            print("Current:", current)
            print("Archived:", version_path)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"REFRESH FAILED: {exc}", file=sys.stderr)
        print("Previous published snapshot retained.", file=sys.stderr)
        sys.exit(1)
