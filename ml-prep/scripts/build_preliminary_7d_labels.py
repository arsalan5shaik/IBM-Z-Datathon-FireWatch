import csv
import random
from pathlib import Path
from datetime import date, timedelta
from collections import defaultdict, Counter

raw = Path("data/raw")
out = Path("data/processed")
out.mkdir(exist_ok=True)

HORIZON = 7
NEGATIVES_PER_DAY = 200
rng = random.Random(42)

# 1. Identify dates with at least one raw satellite record.
recorded_days = set()

for year in (2024, 2025):
    with open(raw / f"FireWatch_california_{year}.csv",
              newline="") as f:
        for row in csv.DictReader(f):
            recorded_days.add(date.fromisoformat(row["acq_date"]))

last_recorded = max(recorded_days)

# 2. Load the existing grid and valid elevation data.
with open(raw / "california_3km_grid_lookup.csv",
          newline="") as f:
    grid_ids = {r["cell_id"] for r in csv.DictReader(f)}

elevations = {}

with open(raw / "california_3km_elevation_mean_FILLED.csv",
          newline="") as f:
    for row in csv.DictReader(f):
        cell = row["cell_id"]
        value = row["elevation_mean_m"].strip()

        if cell in grid_ids and value:
            elevations[cell] = value

eligible_cells = sorted(elevations)
eligible_set = set(eligible_cells)

# 3. Load positive hotspot cell/day observations.
hotspots_by_day = defaultdict(set)

with open(out / "hotspot_cell_days_2024_2025.csv",
          newline="") as f:
    for row in csv.DictReader(f):
        cell = row["cell_id"]

        if cell in eligible_set:
            day = date.fromisoformat(row["observation_date"])
            hotspots_by_day[day].add(cell)

# 4. Export a source-record calendar.
calendar_path = out / "coverage_calendar_2024_2025.csv"

with open(calendar_path, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["date", "source_record_status"])

    day = date(2024, 1, 1)

    while day <= date(2025, 12, 31):
        if day > last_recorded:
            status = "beyond_last_record"
        elif day in recorded_days:
            status = "has_records"
        else:
            status = "no_records_unverified"

        writer.writerow([day.isoformat(), status])
        day += timedelta(days=1)

# 5. Generate gap-aware seven-day labels.
label_path = out / "hotspot_labels_7d_PRELIMINARY.csv"
stats = Counter()

with open(label_path, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow([
        "cell_id",
        "prediction_date",
        "future_7d_hotspot",
        "elevation_mean_m",
        "split",
        "sampled_negative"
    ])

    for year in (2024, 2025):
        # Keep target windows inside their own year.
        end = min(date(year, 12, 31), last_recorded)
        last_anchor = end - timedelta(days=HORIZON)
        anchor = date(year, 1, 1)

        while anchor <= last_anchor:
            window = [
                anchor + timedelta(days=i)
                for i in range(1, HORIZON + 1)
            ]

            # Exclude uncertain dates, including anchor day.
            if anchor not in recorded_days or any(
                d not in recorded_days for d in window
            ):
                stats[f"{year}_excluded_anchor_dates"] += 1
                anchor += timedelta(days=1)
                continue

            stats[f"{year}_valid_anchor_dates"] += 1
            split = "train_2024" if year == 2024 else "holdout_2025"

            # A positive means at least one future detection.
            future_cells = set()

            for d in window:
                future_cells.update(hotspots_by_day.get(d, set()))

            positive_cells = sorted(future_cells & eligible_set)

            for cell in positive_cells:
                writer.writerow([
                    cell, anchor.isoformat(), 1,
                    elevations[cell], split, 0
                ])
                stats[f"{year}_positive_rows"] += 1

            # Sample negatives from the same grid domain.
            negative_pool = [
                cell for cell in eligible_cells
                if cell not in future_cells
            ]

            selected = rng.sample(
                negative_pool,
                min(NEGATIVES_PER_DAY, len(negative_pool))
            )

            for cell in selected:
                writer.writerow([
                    cell, anchor.isoformat(), 0,
                    elevations[cell], split, 1
                ])
                stats[f"{year}_negative_rows"] += 1

            anchor += timedelta(days=1)

print("Last date with raw records:", last_recorded)
print("Eligible grid cells with elevation:", len(eligible_cells))

print("\n=== PRELIMINARY LABEL RESULTS ===")
for key, value in sorted(stats.items()):
    print(f"{key}: {value}")

print("\nSaved:", calendar_path)
print("Saved:", label_path)
