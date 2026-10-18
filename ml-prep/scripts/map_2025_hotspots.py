import csv
import math
import subprocess
from pathlib import Path
from collections import Counter

raw = Path.home() / "firewatch/data/raw"
out = Path.home() / "firewatch/data/processed"
out.mkdir(parents=True, exist_ok=True)

# Load the existing elevation lookup
elevation = {}
with open(raw / "california_3km_elevation_mean_FILLED.csv") as f:
    for row in csv.DictReader(f):
        elevation[row["cell_id"]] = row["elevation_mean_m"]

# Load only presumed vegetation-fire detections
with open(raw / "FireWatch_california_2025.csv") as f:
    fires = [
        row for row in csv.DictReader(f)
        if row["type"].strip() == "0"
    ]

# Convert latitude/longitude to California Albers
coordinates = "".join(
    f'{row["latitude"]} {row["longitude"]}\n'
    for row in fires
)

result = subprocess.run(
    ["cs2cs", "-f", "%.8f", "EPSG:4326", "EPSG:3310"],
    input=coordinates,
    text=True,
    capture_output=True,
    check=True
)

projected = result.stdout.splitlines()

if len(projected) != len(fires):
    raise RuntimeError("Coordinate conversion count mismatch")

counts = Counter()
output = []

for fire, point in zip(fires, projected):
    parts = point.split()

    try:
        x, y = float(parts[0]), float(parts[1])
        if not (math.isfinite(x) and math.isfinite(y)):
            raise ValueError("Nonfinite coordinate")
    except (ValueError, IndexError):
        counts["invalid_coordinate"] += 1
        continue

    col = math.floor(x / 3000)
    grid_row = math.floor(y / 3000)

    cell_id = f"CA3K_X{col:+05d}_Y{grid_row:+05d}"

    if cell_id not in elevation:
        counts["outside_grid"] += 1
        continue

    mean = elevation[cell_id]

    if not mean:
        counts["missing_elevation"] += 1
    else:
        counts["matched_with_elevation"] += 1

    output.append({
        "cell_id": cell_id,
        "observation_date": fire["acq_date"],
        "latitude": fire["latitude"],
        "longitude": fire["longitude"],
        "elevation_mean_m": mean,
        "confidence": fire["confidence"],
        "frp": fire["frp"]
    })

destination = out / "hotspots_2025_with_elevation.csv"

with open(destination, "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=[
        "cell_id", "observation_date",
        "latitude", "longitude",
        "elevation_mean_m", "confidence", "frp"
    ])
    writer.writeheader()
    writer.writerows(output)

print("Original qualifying detections:", len(fires))
print("Mapped with elevation:", counts["matched_with_elevation"])
print("Mapped but missing elevation:", counts["missing_elevation"])
print("Outside provisional grid:", counts["outside_grid"])
print("Invalid coordinates:", counts["invalid_coordinate"])
print("Output rows:", len(output))
print("Saved:", destination)
