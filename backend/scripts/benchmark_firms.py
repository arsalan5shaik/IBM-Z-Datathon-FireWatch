"""Synthetic statewide cache benchmark in a temporary directory; never publishes live data."""

import argparse
import asyncio
import json
import math
import statistics
import tempfile
import time
import tracemalloc
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import REPO_ROOT, Settings
from app.main import create_app
from app.schemas.fires import Observation
from app.services.fire_cache import FireCache


async def seed(settings, now, count):
    sources = settings.firms_sources
    records = [
        Observation(
            id=f"synthetic-benchmark-{i}",
            longitude=-124.5 + (i % 100) * 0.105,
            latitude=32.5 + ((i // 100) % 100) * 0.095,
            acquired_at=now - timedelta(minutes=i % 1440),
            source=sources[i % 2],
            satellite="NOAA-20" if i % 2 == 0 else "NOAA-21",
            frp=1.0,
        )
        for i in range(count)
    ]

    class SyntheticProvider:
        async def fetch(self, source, timestamp):
            return (
                [record for record in records if record.source == source],
                {"invalid_rows": 0, "duplicate_rows": 0, "outside_rows": 0},
                timestamp - timedelta(hours=72),
            )

    cache = FireCache(settings)
    await cache.refresh(now=now, client=SyntheticProvider())
    return cache.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--records", type=int, default=10000, choices=range(100, 50001), metavar="100..50000"
    )
    parser.add_argument("--requests", type=int, default=20, choices=range(5, 101), metavar="5..100")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="firewatch-firms-benchmark-") as directory:
        settings = Settings(
            _env_file=None,
            repo_root=Path(directory),
            firms_boundary_path=REPO_ROOT / "frontend/public/data/ca-boundary.geojson",
            log_level="WARNING",
        )
        started = time.perf_counter()
        document = asyncio.run(seed(settings, datetime.now(UTC), args.records))
        ingestion_ms = (time.perf_counter() - started) * 1000
        retained = sum(len(state.records) for state in document.sources.values())
        timings, sizes = [], []
        # Measure Python allocations for serving, separately from imports and ingestion.
        tracemalloc.start()
        with TestClient(create_app(settings)) as client:
            for _ in range(args.requests):
                started = time.perf_counter()
                response = client.get("/api/v1/fires/live?hours=24&limit=500")
                assert response.status_code == 200
                assert len(response.json()["features"]) <= 500
                timings.append((time.perf_counter() - started) * 1000)
                sizes.append(len(response.content))
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        print(
            json.dumps(
                {
                    "synthetic_only": True,
                    "input_records": args.records,
                    "california_records": retained,
                    "requests": args.requests,
                    "ingestion_ms": round(ingestion_ms, 2),
                    "response_p50_ms": round(statistics.median(timings), 2),
                    "response_p95_ms": round(
                        sorted(timings)[math.ceil(len(timings) * 0.95) - 1], 2
                    ),
                    "max_response_bytes": max(sizes),
                    "serving_peak_python_allocated_mib": round(peak / 1024**2, 2),
                    "memory_scope": "serving only; excludes interpreter, imports and ingestion",
                }
            )
        )


if __name__ == "__main__":
    main()
