"""Summarize held-out ERC errors by geography, month and elevation; not a spatial holdout."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


def _points(nested):
    if isinstance(nested, (list, tuple)) and len(nested) >= 2 and isinstance(nested[0], (int, float)):
        yield nested
    elif isinstance(nested, (list, tuple)):
        for item in nested:
            yield from _points(item)


def _metrics(item):
    n = item["rows"]
    variance = item["y2"] - item["y"] * item["y"] / n
    return {"rows": n, "MAE": item["abs"] / n, "RMSE": math.sqrt(item["sq"] / n),
            "R2": 1 - item["sq"] / variance if variance > 0 else None,
            "dates": sorted(item["dates"])}


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(predictions, numeric_grid, mapping_path, mapping_manifest_path, elevation_path, output):
    import numpy as np
    import pandas as pd

    output = Path(output)
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite existing subgroup report: {output}")
    mapping, canonical_ids = {}, set()
    with open(mapping_path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            numeric_id, canonical = row["numeric_cell_id"], row["cell_id"]
            if numeric_id in mapping or canonical in canonical_ids:
                raise ValueError("Grid ID mapping is not one-to-one")
            mapping[numeric_id] = canonical
            canonical_ids.add(canonical)

    manifest = json.loads(Path(mapping_manifest_path).read_text(encoding="utf-8"))
    if (manifest["crosswalk_sha256"] != _sha256(mapping_path)
            or manifest["numeric_grid_sha256"] != _sha256(numeric_grid)
            or manifest["count"] != len(mapping)):
        raise ValueError("Numeric grid, mapping and verified mapping manifest do not match")

    document = json.loads(Path(numeric_grid).read_text(encoding="utf-8"))
    latitude = {}
    numeric_ids_seen = set()
    for feature in document["features"]:
        numeric_id = str(feature["properties"].get("cell_id", feature.get("id", "")))
        if numeric_id not in mapping:
            continue
        if numeric_id in numeric_ids_seen:
            raise ValueError(f"Duplicate numeric grid ID {numeric_id}")
        numeric_ids_seen.add(numeric_id)
        pts = list(_points(feature["geometry"]["coordinates"]))
        if not pts:
            raise ValueError(f"Grid cell {numeric_id} has no polygon coordinates")
        lat = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2.0
        latitude[mapping[numeric_id]] = lat
    if len(latitude) != len(mapping) or numeric_ids_seen != set(mapping):
        raise ValueError("Numeric grid boundaries do not cover the verified mapping")

    elev = {}
    elev_values = []
    elevation_ids = set()
    with open(elevation_path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            numeric_id = row["cell_id"]
            if numeric_id not in mapping:
                raise ValueError(f"Elevation numeric ID {numeric_id} is absent from mapping")
            if numeric_id in elevation_ids:
                raise ValueError(f"Duplicate elevation ID {numeric_id}")
            elevation_ids.add(numeric_id)
            lo, hi = row["min_elevation_m"].strip(), row["max_elevation_m"].strip()
            value = None if not lo or not hi else (float(lo) + float(hi)) / 2.0
            elev[mapping[numeric_id]] = value
            if value is not None:
                elev_values.append(value)
    if elevation_ids != set(mapping):
        raise ValueError("Elevation and verified numeric grid IDs do not match")
    cuts = np.quantile(np.asarray(elev_values, dtype=float), [1/3, 2/3]).tolist()

    buckets = {dimension: {} for dimension in ("region", "month", "elevation_tertile")}
    seen_date, seen_cells = None, set()
    first_date = last_date = None
    total_rows = 0
    date_set = set()
    required = {"cell_id", "date", "erc", "prediction"}
    for chunk in pd.read_csv(predictions, usecols=list(required), dtype={"cell_id": "string"}, chunksize=250_000):
        if set(chunk.columns) != required:
            raise ValueError("Held-out predictions require cell_id,date,erc,prediction")
        chunk["date"] = pd.to_datetime(chunk.date, format="%Y-%m-%d", errors="raise")
        if chunk[["cell_id", "erc", "prediction"]].isna().any().any():
            raise ValueError("Predictions contain missing keys, labels or model outputs")
        chunk["erc"] = pd.to_numeric(chunk.erc, errors="raise")
        chunk["prediction"] = pd.to_numeric(chunk.prediction, errors="raise")
        if not np.isfinite(chunk[["erc", "prediction"]].to_numpy(dtype=float)).all():
            raise ValueError("Nonfinite target or prediction")
        chunk = chunk.sort_values("date", kind="stable")
        for day, day_rows in chunk.groupby("date", sort=False):
            key_date = day.strftime("%Y-%m-%d")
            if seen_date != key_date:
                if seen_date is not None and key_date <= seen_date:
                    raise ValueError("Prediction rows are not monotonically date-ordered")
                if seen_date is not None and len(seen_cells) != 47_283:
                    raise ValueError(f"Held-out date {seen_date} does not cover 47,283 labeled cells")
                seen_date, seen_cells = key_date, set()
            overlap = seen_cells.intersection(day_rows.cell_id.astype(str))
            if overlap:
                raise ValueError(f"Duplicate cell-date prediction, e.g. {next(iter(overlap))}/{key_date}")
            seen_cells.update(day_rows.cell_id.astype(str))
            date_set.add(key_date)
        ids = chunk.cell_id.astype(str)
        if set(ids) - latitude.keys():
            raise ValueError("Prediction includes cells absent from geographic grid")
        chunk["latitude_band_midpoint"] = ids.map(latitude).to_numpy()
        chunk["elevation_mid_m"] = ids.map(elev).to_numpy()
        chunk["region"] = np.where(chunk.latitude_band_midpoint >= 40.0, "north_lat_ge_40",
                            np.where(chunk.latitude_band_midpoint >= 36.5, "central_36_5_to_40", "south_lat_lt_36_5"))
        chunk["month"] = chunk.date.dt.strftime("%Y-%m")
        def elevation_group(value):
            if pd.isna(value): return "missing_elevation"
            if value <= cuts[0]: return "lower_tertile"
            if value <= cuts[1]: return "middle_tertile"
            return "upper_tertile"
        chunk["elevation_tertile"] = chunk.elevation_mid_m.map(elevation_group)
        err = chunk.erc.to_numpy(dtype=float) - chunk.prediction.to_numpy(dtype=float)
        chunk["_abs"] = np.abs(err); chunk["_sq"] = np.square(err)
        chunk["_y"] = chunk.erc.to_numpy(dtype=float); chunk["_y2"] = np.square(chunk.erc.to_numpy(dtype=float))
        chunk["_date_text"] = chunk.date.dt.strftime("%Y-%m-%d")
        for dimension, groups in buckets.items():
            for label, part in chunk.groupby(dimension, sort=True):
                item = groups.setdefault(str(label), {"rows": 0, "abs": 0.0, "sq": 0.0, "y": 0.0, "y2": 0.0, "dates": set()})
                item["rows"] += len(part); item["abs"] += float(part._abs.sum()); item["sq"] += float(part._sq.sum())
                item["y"] += float(part._y.sum()); item["y2"] += float(part._y2.sum()); item["dates"].update(part._date_text.unique())
        total_rows += len(chunk)
        if first_date is None: first_date = chunk.date.min().strftime("%Y-%m-%d")
        last_date = chunk.date.max().strftime("%Y-%m-%d")

    if total_rows == 0:
        raise ValueError("No held-out prediction rows found")
    expected_dates = set(pd.date_range("2025-07-01", "2025-12-31").strftime("%Y-%m-%d"))
    if (first_date != "2025-07-01" or last_date != "2025-12-31" or date_set != expected_dates
            or len(seen_cells) != 47_283 or total_rows != 8_700_072):
        raise ValueError("Expected complete held-out test coverage: 8,700,072 labeled rows, July-December 2025")
    report = {"evaluation": "retrospective held-out subgroup analysis",
              "target": "historical gridMET ERC-G, not wildfire ignition probability",
              "period": {"start": first_date, "end": last_date}, "rows": total_rows,
              "geographic_grouping": "Verified numeric-grid polygon bounding-box midpoint latitude; north >= 40.0, central >= 36.5 and < 40.0, south < 36.5 degrees. Descriptive latitude bands, not official administrative regions.",
              "elevation_grouping": {"method": "tertiles of per-cell (minimum+maximum)/2 elevation over available mapped cells",
                                    "cutpoints_m": cuts, "missing_elevation_bucket": "missing_elevation"},
              "retrospective_subgroups_are_spatial_holdout": False,
              "spatial_block_holdout_performed": False,
              "groups": {dim: {name: _metrics(values) for name, values in items.items()} for dim, items in buckets.items()}}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--predictions", required=True, help="Original test_predictions.csv from the trained model")
    parser.add_argument("--numeric-grid", required=True)
    parser.add_argument("--mapping", required=True)
    parser.add_argument("--mapping-manifest", required=True)
    parser.add_argument("--elevation", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = run(args.predictions, args.numeric_grid, args.mapping, args.mapping_manifest, args.elevation, args.output)
    print(json.dumps({"period": result["period"], "rows": result["rows"], "output": args.output}, indent=2))


if __name__ == "__main__":
    main()
