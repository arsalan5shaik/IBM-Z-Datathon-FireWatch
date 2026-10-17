#!/usr/bin/env python3
"""Offline analytical *lower-bound* California grid-size estimate. No dependencies."""
CALIFORNIA_LAND_KM2 = 155858.33 * 2.589988110336
DAYS = 366 + 365


def counts(km: int) -> tuple[int, int]:
    area_estimated = round(CALIFORNIA_LAND_KM2 / (km * km))
    return area_estimated, area_estimated * DAYS


def main():
    print(f"CA land ~{CALIFORNIA_LAND_KM2:,.0f} km2; {DAYS} days (2024–2025)")
    print("Estimates only; clipped partial cells can increase actual counts.")
    print("grid_km | approximate_cells | daily_rows_2024_2025")
    for k in (3, 5, 10, 20):
        c, r = counts(k)
        print(f"{k:>7} | {c:>17,} | {r:>21,}")
    print("3 km/5 km ratio ~", round(counts(3)[0] / counts(5)[0], 2))


if __name__ == "__main__":
    main()
