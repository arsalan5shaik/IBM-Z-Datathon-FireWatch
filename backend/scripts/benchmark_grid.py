"""Index scale smoke, synthetic geometry only; never publishes forecasts."""

import json
import statistics
import time
import tracemalloc

from app.services.grid import Grid, rectangle


def main():
    tracemalloc.start()
    started = time.perf_counter()
    document = {
        "type": "FeatureCollection",
        "metadata": {
            "grid_resolution_m": 3000,
            "source_epsg": 3310,
            "data_mode": "fixture",
            "grid_version": "synthetic-index-benchmark",
        },
        "features": [],
    }
    # Synthetic bbox-scale polygons, NOT a generated 3 km grid or CA land boundary.
    # Only intended to exercise validation, index size and representative query cost.
    for i in range(47000):
        x, y = i % 235, i // 235
        w, s = -124.5 + x * 0.04, 33 + y * 0.04
        document["features"].append(
            {
                "type": "Feature",
                "properties": {"cell_id": f"MOCK_{i}", "grid_version": "synthetic-index-benchmark"},
                "geometry": rectangle((w, s, w + 0.03, s + 0.03)),
            }
        )
    grid = Grid(document)
    elapsed = time.perf_counter() - started
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    samples = []
    for _ in range(50):
        start = time.perf_counter()
        cells = grid.query((-120, 36, -119.9, 36.1), 2000)
        samples.append((time.perf_counter() - start) * 1000)
    print(
        json.dumps(
            {
                "data_mode": "fixture",
                "cells": len(grid.cells),
                "returned": len(cells),
                "build_seconds": round(elapsed, 3),
                "peak_python_mb": round(peak / 1e6, 2),
                "query_p50_ms": round(statistics.median(samples), 3),
                "query_p95_ms": round(sorted(samples)[47], 3),
            }
        )
    )


if __name__ == "__main__":
    main()
