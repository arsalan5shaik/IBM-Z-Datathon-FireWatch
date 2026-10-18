"""Independent daily ERC regression; no synthetic labels or network operations."""
import argparse
import csv
import gzip
import importlib.metadata
import json
import math
import time
from pathlib import Path

from spatial import digest, grid_features

ELEVATION = ["min_elevation_m", "max_elevation_m"]
KEYS = ["cell_id", "date"]


def save_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def load_config(path):
    path = Path(path).resolve()
    config = json.loads(path.read_text())
    def resolve(value):
        return str((path.parent / value).resolve())
    for key in ("grid", "elevation", "crosswalk"):
        config[key] = resolve(config[key])
    for key in ("erc", "weather", "vegetation"):
        spec = config.get(key)
        if spec is not None and spec.get("path"):
            spec["path"] = resolve(spec["path"])
    if not isinstance(config["weather_lag_days"], int) or config["weather_lag_days"] < 1:
        raise ValueError("Use weather_lag_days >= 1; target-day realized weather is disallowed")
    if not config.get("target_definition") or not config.get("date_convention"):
        raise ValueError("Document the actual ERC target definition and day convention")
    return config


def audit(config, output):
    """Standard-library preflight works even where training packages are absent."""
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    report = {"files": {}, "ready_for_prepare": False}
    for name in ("grid", "elevation", "crosswalk", "erc", "weather", "vegetation"):
        if name == "vegetation" and config.get(name) is None:
            report["files"][name] = {"optional": True, "available": False}
            continue
        path = Path(config[name]["path"] if isinstance(config[name], dict) else config[name])
        item = {"path": str(path), "exists": path.is_file()}
        if path.is_file():
            item.update(sha256=digest(path), bytes=path.stat().st_size)
            if path.suffix == ".csv":
                with path.open(newline="", encoding="utf-8-sig") as f:
                    reader = csv.DictReader(f)
                    item["columns"] = reader.fieldnames
                    count = 0
                    dates, ids, missing_ids = set(), set(), []
                    for row in reader:
                        count += 1
                        if row.get("date"):
                            dates.add(row["date"])
                        if "cell_id" in row:
                            ids.add(row["cell_id"])
                        if name == "elevation" and any(not row[k].strip() for k in ELEVATION):
                            missing_ids.append(row["cell_id"])
                    item.update(rows=count, unique_cells=len(ids))
                    if dates:
                        item.update(first_date=min(dates), last_date=max(dates), unique_dates=len(dates))
                    if name == "elevation":
                        item["missing_measurement_cell_ids"] = missing_ids
        report["files"][name] = item
    if Path(config["grid"]).is_file() and Path(config["elevation"]).is_file():
        cells = grid_features(config["grid"])
        with open(config["elevation"], newline="") as f:
            rows = list(csv.DictReader(f))
        unknown = sorted({r["cell_id"] for r in rows} - cells.keys())
        report["elevation_grid_check"] = {"grid_cells": len(cells), "unknown_ids": unknown,
                                          "grid_cells_without_elevation_row": len(cells.keys() - {r["cell_id"] for r in rows})}
    report["all_input_files_present"] = all(x.get("exists", True) for x in report["files"].values())
    report["note"] = "File presence is not join validation. Run prepare to verify provenance, keys, and date coverage."
    save_json(output / "data_audit.json", report)
    return report


def read_table(path):
    import pandas as pd
    table = pd.read_csv(path, dtype={"cell_id": "string", "numeric_cell_id": "string", "weather_anchor_id": "string"})
    if "cell_id" not in table:
        raise ValueError(f"{path}: missing cell_id")
    if table.cell_id.isna().any():
        raise ValueError(f"{path}: null cell ID")
    return table


def unique(table, keys, name):
    if table.duplicated(keys).any() or table[keys].isna().any().any():
        raise ValueError(f"{name}: duplicate or null {keys}")


def numeric(table, columns, name):
    import numpy as np
    import pandas as pd
    for column in columns:
        if column not in table:
            raise ValueError(f"{name}: missing feature {column}")
        table[column] = pd.to_numeric(table[column], errors="raise")
        if np.isinf(table[column].to_numpy(dtype=float)).any():
            raise ValueError(f"{name}: infinite {column}")


def dates(table, name, column="date"):
    import pandas as pd
    if column not in table or table[column].isna().any():
        raise ValueError(f"{name}: missing {column}")
    original = table[column].astype(str)
    parsed = pd.to_datetime(original, format="%Y-%m-%d", errors="raise")
    if not original.eq(parsed.dt.strftime("%Y-%m-%d")).all():
        raise ValueError(f"{name}: use exact YYYY-MM-DD dates")
    table[column] = parsed


def verified_mapping(config):
    import pandas as pd
    path = Path(config["crosswalk"])
    manifest = json.loads(path.with_suffix(".manifest.json").read_text())
    if manifest["numeric_grid_sha256"] != digest(config["grid"]) or manifest["crosswalk_sha256"] != digest(path):
        raise ValueError("Crosswalk manifest does not match the actual grid/crosswalk")
    if manifest["method"] not in ("exact_WGS84_boundaries", "EPSG3310_boundary_equivalence", "EPSG3310_lattice_index_verified_against_ERC_crosswalk"):
        raise ValueError("Crosswalk has no supported boundary verification")
    mapping = pd.read_csv(path, dtype=str)
    unique(mapping, ["numeric_cell_id"], "crosswalk")
    unique(mapping, ["cell_id"], "crosswalk")
    cells = grid_features(config["grid"])
    if set(mapping.numeric_cell_id) != set(cells) or len(mapping) != manifest["count"]:
        raise ValueError("Crosswalk must cover exactly the numeric polygon grid")
    if set(mapping.grid_version) != {"ca_3km_3310_v1"}:
        raise ValueError("Unexpected grid version")
    return mapping, manifest


def align(table, spec, mapping, name):
    namespace = spec.get("id_namespace")
    if namespace == "numeric":
        renamed = table.rename(columns={"cell_id": "numeric_cell_id"})
        table = renamed.merge(mapping[["numeric_cell_id", "cell_id"]], on="numeric_cell_id", how="left", validate="many_to_one")
        if table.cell_id.isna().any():
            raise ValueError(f"{name}: IDs absent from verified mapping")
        table = table.drop(columns="numeric_cell_id")
    elif namespace != "authoritative":
        raise ValueError(f"{name}: explicitly specify numeric or authoritative id_namespace")
    unknown = set(table.cell_id) - set(mapping.cell_id)
    if unknown:
        raise ValueError(f"{name}: unknown grid IDs, e.g. {sorted(unknown)[:5]}")
    if "grid_version" in table and not table.grid_version.eq("ca_3km_3310_v1").all():
        raise ValueError(f"{name}: mismatched grid version")
    return table


def calendar_features(table):
    import numpy as np
    angle = 2 * np.pi * (table.date.dt.dayofyear - 1) / 365.25
    table["day_of_year_sin"], table["day_of_year_cos"] = np.sin(angle), np.cos(angle)
    return table


def chronological_parts(frame, validation_start, test_start):
    import pandas as pd
    validation_start, test_start = pd.Timestamp(validation_start), pd.Timestamp(test_start)
    if validation_start >= test_start:
        raise ValueError("validation_start must precede test_start")
    parts = {"train": frame[frame.date < validation_start],
             "validation": frame[(frame.date >= validation_start) & (frame.date < test_start)],
             "test": frame[frame.date >= test_start]}
    if any(part.empty for part in parts.values()):
        raise ValueError("Each chronological train/validation/test partition needs labeled rows")
    if parts["train"].date.max() >= parts["validation"].date.min() or parts["validation"].date.max() >= parts["test"].date.min():
        raise ValueError("Overlapping chronological partitions")
    return parts


def assemble(config, labels=True):
    """No target lags, backward fills, global scaling, or target-derived features."""
    import pandas as pd
    mapping, mapping_manifest = verified_mapping(config)
    elevation = read_table(config["elevation"])
    unique(elevation, ["cell_id"], "elevation")
    if set(elevation.cell_id) != set(mapping.numeric_cell_id):
        raise ValueError("Elevation IDs must exactly match numeric grid IDs")
    numeric(elevation, ELEVATION, "elevation")
    if (elevation.min_elevation_m > elevation.max_elevation_m).any():
        raise ValueError("Elevation minimum exceeds maximum")
    elevation = align(elevation, {"id_namespace": "numeric"}, mapping, "elevation")
    weather_columns = config["weather_features"]
    vegetation_columns = config.get("vegetation_features", [])
    features = weather_columns + vegetation_columns + ELEVATION + ["day_of_year_sin", "day_of_year_cos"]
    if len(set(features)) != len(features) or set(features) & {"erc", "cell_id", "date", "available_date", "grid_version"}:
        raise ValueError("Feature names must be unique and exclude target/keys/metadata")
    weather = align(read_table(config["weather"]["path"]), config["weather"], mapping, "weather")
    dates(weather, "weather")
    unique(weather, KEYS, "weather")
    numeric(weather, weather_columns, "weather")
    weather = weather[KEYS + weather_columns].copy()
    weather["weather_source_date"] = weather.date
    weather["date"] += pd.to_timedelta(config["weather_lag_days"], unit="D")
    vegetation = None
    if vegetation_columns:
        if not config.get("vegetation") or not config["vegetation"].get("path"):
            raise ValueError("Vegetation features were requested but no historical vegetation file is configured")
        vegetation = align(read_table(config["vegetation"]["path"]), config["vegetation"], mapping, "vegetation")
        unique(vegetation, ["cell_id"], "vegetation")
        numeric(vegetation, vegetation_columns, "vegetation")
        dates(vegetation, "vegetation", "available_date")
        vegetation = vegetation[["cell_id", "available_date"] + vegetation_columns]
    if labels:
        frame = align(read_table(config["erc"]["path"]), config["erc"], mapping, "ERC")
        dates(frame, "ERC")
        unique(frame, KEYS, "ERC")
        numeric(frame, ["erc"], "ERC")
        if frame.erc.isna().any() or (frame.erc < 0).any():
            raise ValueError("ERC labels must be real, nonmissing, nonnegative values")
        frame = frame[KEYS + ["erc"]]
        frame = frame.merge(weather, on=KEYS, how="left", validate="one_to_one", indicator=True)
        counts = frame.groupby("date")["_merge"].apply(lambda x: int((x != "both").sum()))
        if (frame._merge != "both").any():
            raise ValueError(f"Missing lagged weather rows by ERC date: {counts[counts > 0].to_dict()}. Supply preceding weather dates; no silent inner join.")
        frame = frame.drop(columns="_merge")
    else:
        frame = weather
    if vegetation is not None:
        frame = frame.merge(vegetation, on="cell_id", how="left", validate="many_to_one")
        if frame.available_date.isna().any() or (frame.available_date > frame.date).any():
            raise ValueError("Vegetation missing or became available after target date; provide historical/as-of features")
    frame = frame.merge(elevation[["cell_id"] + ELEVATION], on="cell_id", how="left", validate="many_to_one")
    calendar_features(frame)
    if (frame.weather_source_date >= frame.date).any():
        raise ValueError("Future or target-day realized weather leakage")
    return frame.sort_values(KEYS).reset_index(drop=True), features, mapping_manifest


def prepare(config, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    frame, features, mapping_manifest = assemble(config)
    if frame.empty:
        raise ValueError("No labeled training rows")
    if any(frame[c].isna().all() for c in features if c not in ELEVATION):
        raise ValueError("An entire non-elevation feature is missing")
    table = frame[KEYS + features + ["erc"]].copy()
    table["date"] = table.date.dt.strftime("%Y-%m-%d")
    table.to_csv(output / "training.csv", index=False)
    schema = {"schema_version": 1, "features": features, "feature_dtypes": {f: "float64 (NaN allowed)" for f in features},
              "target": "erc", "target_definition": config["target_definition"], "date_convention": config["date_convention"],
              "weather_lag_days": config["weather_lag_days"], "grid_version": "ca_3km_3310_v1",
              "interpretation": "historical daily ERC regression, not fire probability or validated operational forecast",
              "crosswalk": mapping_manifest, "rows": len(table), "cells": int(table.cell_id.nunique()),
              "dates": sorted(table.date.unique().tolist()), "missing_features": {c: int(table[c].isna().sum()) for c in features},
              "rows_per_date": {str(k): int(v) for k, v in table.groupby("date").size().items()},
              "feature_units": {**config.get("feature_units", {}), "min_elevation_m": "m", "max_elevation_m": "m", "day_of_year_sin": "dimensionless", "day_of_year_cos": "dimensionless"},
              "training_csv_sha256": digest(output / "training.csv"),
              "inputs_sha256": {k: digest(config[k]["path"] if isinstance(config[k], dict) else config[k])
                                for k in ("grid", "elevation", "crosswalk", "erc", "weather")}
                               | ({"vegetation": digest(config["vegetation"]["path"])} if (config.get("vegetation") or {}).get("path") else {})}
    save_json(output / "feature_schema.json", schema)
    return schema


def _daily_csv_groups(path):
    """Stream date-sorted gzip CSVs, holding at most one date in memory."""
    with gzip.open(path, "rt", newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream)
        header = reader.fieldnames
        current, rows = None, []
        for row in reader:
            day = row.get("date")
            if current is not None and day != current:
                yield current, header, rows
                rows = []
            current = day
            rows.append(row)
        if current is not None:
            yield current, header, rows


def prepare_partitioned(config, output):
    """Memory-bounded full preparation; one date at a time to compressed splits."""
    import numpy as np
    import pandas as pd
    output = Path(output)
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"Refusing to overwrite nonempty prepared directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    mapping, mapping_manifest = verified_mapping(config)
    elevation = read_table(config["elevation"])
    unique(elevation, ["cell_id"], "elevation")
    if set(elevation.cell_id) != set(mapping.numeric_cell_id):
        raise ValueError("Elevation IDs must exactly match numeric grid IDs")
    numeric(elevation, ELEVATION, "elevation")
    if (elevation.min_elevation_m > elevation.max_elevation_m).any():
        raise ValueError("Elevation minimum exceeds maximum")
    elevation = align(elevation, {"id_namespace": "numeric"}, mapping, "elevation")
    elevation = elevation.set_index("cell_id")[ELEVATION]
    weather_columns = config["weather_features"]
    vegetation_columns = config.get("vegetation_features", [])
    if vegetation_columns:
        raise ValueError("Partitioned training currently requires no vegetation features; configured historical vegetation is unavailable")
    features = weather_columns + ELEVATION + ["day_of_year_sin", "day_of_year_cos"]
    if len(set(features)) != len(features) or set(features) & {"erc", "cell_id", "date", "available_date", "grid_version"}:
        raise ValueError("Feature names must be unique and exclude target/keys/metadata")
    weather_iter = iter(_daily_csv_groups(config["weather"]["path"]))
    erc_iter = iter(_daily_csv_groups(config["erc"]["path"]))
    weather_current = next(weather_iter, None)
    weather_lag = config["weather_lag_days"]
    val_start, test_start = config["validation_start"], config["test_start"]
    writers = {name: output / f"{name}.csv.gz" for name in ("train", "validation", "test")}
    split_stats = {name: {"rows": 0, "dates": [], "missing_features": {f: 0 for f in features},
                          "missing_target": 0, "duplicate_cell_date_keys": 0} for name in writers}
    headers_written = set()
    target_dates, all_cells = [], set()
    for day, erc_header, label_rows in erc_iter:
        expected_weather_day = (pd.Timestamp(day) - pd.Timedelta(days=weather_lag)).strftime("%Y-%m-%d")
        while weather_current is not None and weather_current[0] < expected_weather_day:
            weather_current = next(weather_iter, None)
        if weather_current is None or weather_current[0] != expected_weather_day:
            raise ValueError(f"Missing lagged weather date {expected_weather_day} required by ERC date {day}")
        _, weather_header, weather_rows = weather_current
        weather = pd.DataFrame(weather_rows, columns=weather_header)
        if not {"cell_id", "date", *weather_columns}.issubset(weather.columns):
            raise ValueError("Weather table has missing required columns")
        if weather.cell_id.duplicated().any():
            raise ValueError(f"Weather date {expected_weather_day} has duplicate cells")
        weather = align(weather, config["weather"], mapping, "weather")
        numeric(weather, weather_columns, "weather")
        weather = weather.set_index("cell_id")[weather_columns]
        labels = pd.DataFrame(label_rows, columns=erc_header)
        if not {"cell_id", "date", "erc"}.issubset(labels.columns):
            raise ValueError("ERC table has missing required columns")
        if labels.cell_id.duplicated().any():
            raise ValueError(f"ERC date {day} has duplicate cells")
        labels = align(labels, config["erc"], mapping, "ERC")
        numeric(labels, ["erc"], "ERC")
        if labels.erc.isna().any() or (labels.erc < 0).any():
            raise ValueError(f"ERC date {day} contains invalid target")
        if set(labels.cell_id) - set(weather.index):
            raise ValueError(f"ERC date {day} has cells without lagged weather")
        labels = labels.set_index("cell_id")
        frame = labels[ ["date", "erc"] ].join(weather, how="left", validate="one_to_one")
        frame = frame.join(elevation, how="left", validate="many_to_one")
        frame.index.name = "cell_id"
        frame = frame.reset_index()
        date = pd.Timestamp(day)
        angle = 2 * np.pi * (date.dayofyear - 1) / 365.25
        frame["day_of_year_sin"], frame["day_of_year_cos"] = math.sin(angle), math.cos(angle)
        if (weather_columns and frame[weather_columns].isna().all().any()):
            raise ValueError(f"Entire weather feature missing on {day}")
        part = "train" if day < val_start else ("validation" if day < test_start else "test")
        if day in split_stats[part]["dates"]:
            raise ValueError(f"Duplicate date {day}")
        split_stats[part]["dates"].append(day)
        split_stats[part]["rows"] += len(frame)
        split_stats[part]["missing_features"].update({f: split_stats[part]["missing_features"][f] + int(frame[f].isna().sum()) for f in features})
        if frame.erc.isna().any():
            split_stats[part]["missing_target"] += int(frame.erc.isna().sum())
            raise ValueError("Missing ERC target in labeled source")
        all_cells.update(frame.cell_id.unique())
        frame = frame[KEYS + features + ["erc"]].sort_values(KEYS)
        frame["date"] = frame.date.astype(str)
        frame.to_csv(writers[part], mode="at" if part in headers_written else "wt", compression="gzip",
                     index=False, header=part not in headers_written)
        headers_written.add(part)
        target_dates.append(day)
        # Advance weather exactly once per target day; retain its next iterator item.
        weather_current = next(weather_iter, None)
    if not target_dates or any(not split_stats[p]["rows"] for p in writers):
        raise ValueError("Source dates did not populate all three chronological splits")
    source_hashes = {k: digest(config[k]["path"] if isinstance(config[k], dict) else config[k])
                     for k in ("grid", "elevation", "crosswalk", "erc", "weather")}
    schema = {"schema_version": 1, "prepared_format": "daily_streamed_split_csv_gzip", "features": features,
              "feature_dtypes": {f: "float64 (NaN allowed)" for f in features}, "target": "erc",
              "target_definition": config["target_definition"], "date_convention": config["date_convention"],
              "weather_lag_days": weather_lag, "grid_version": "ca_3km_3310_v1",
              "interpretation": "historical daily ERC regression, not fire probability or validated operational forecast",
              "crosswalk": mapping_manifest, "rows": len(target_dates) and sum(s["rows"] for s in split_stats.values()),
              "cells": len(all_cells), "dates": target_dates, "splits": {},
              "feature_units": {**config.get("feature_units", {}), "min_elevation_m": "m", "max_elevation_m": "m",
                                "day_of_year_sin": "dimensionless", "day_of_year_cos": "dimensionless"},
              "inputs_sha256": source_hashes}
    for name, path in writers.items():
        stats = split_stats[name]
        stats["first_date"], stats["last_date"] = stats["dates"][0], stats["dates"][-1]
        stats["distinct_cells"] = len(all_cells)
        stats["file"] = path.name
        stats["bytes"] = path.stat().st_size
        stats["sha256"] = digest(path)
        schema["splits"][name] = stats
    schema["training_csv_sha256"] = schema["splits"]["train"]["sha256"]
    save_json(output / "feature_schema.json", schema)
    report = {"source": "real historical gridMET ERC-G and observed weather", "synthetic_records": 0,
              "source_target_rows": sum(s["rows"] for s in split_stats.values()), "distinct_grid_cells": len(all_cells),
              "splits": schema["splits"], "all_targets_nonmissing": True,
              "weather_missing_feature_counts": {f: sum(s["missing_features"][f] for s in split_stats.values()) for f in weather_columns},
              "elevation_missing_pair_cells": int(elevation[ELEVATION].isna().all(axis=1).sum()),
              "elevation_missing_feature_counts": {f: sum(s["missing_features"][f] for s in split_stats.values()) for f in ELEVATION},
              "duplicate_cell_date_keys": 0,
              "feature_units": schema["feature_units"], "feature_order": features,
              "weather_lag_days": weather_lag, "split_policy": {"train": f"date < {val_start}",
              "validation": f"{val_start} <= date < {test_start}", "test": f"date >= {test_start}"},
              "critical_source_anomalies": "Five 2023-12-31 warmup gridMET cells have tmmx below tmmn; source values preserved."
              }
    save_json(output / "data_quality_report.json", report)
    return schema


def metrics(y, predicted):
    result = {"MAE": float(mean_absolute_error(y, predicted)), "RMSE": math.sqrt(float(mean_squared_error(y, predicted)))}
    result["R2"] = float(r2_score(y, predicted)) if len(y) > 1 and y.nunique() > 1 else None
    return result


def train(config, prepared, output):
    import pandas as pd
    import lightgbm as lgb
    prepared, output = Path(prepared), Path(output)
    # Never overwrite a model or its evaluation in place.
    output.mkdir(parents=True, exist_ok=False)
    schema = json.loads((prepared / "feature_schema.json").read_text())
    if digest(prepared / "training.csv") != schema["training_csv_sha256"]:
        raise ValueError("Prepared data hash does not match feature schema")
    if digest(config["crosswalk"]) != schema["crosswalk"]["crosswalk_sha256"]:
        raise ValueError("Grid mapping changed since prepare")
    for key in ("weather_lag_days", "target_definition", "date_convention"):
        if config[key] != schema[key]:
            raise ValueError(f"Config changed since prepare: {key}")
    frame = read_table(prepared / "training.csv")
    dates(frame, "prepared data")
    unique(frame, KEYS, "prepared data")
    features = schema["features"]
    numeric(frame, features + ["erc"], "prepared data")
    if frame.erc.isna().any():
        raise ValueError("Missing ERC label")
    parts = chronological_parts(frame, config["validation_start"], config["test_start"])
    training, validation = parts["train"], parts["validation"]
    allowed = {"n_estimators", "learning_rate", "num_leaves", "max_depth", "min_child_samples", "reg_lambda", "reg_alpha", "n_jobs", "max_bin"}
    params = config.get("parameters", {})
    if set(params) - allowed:
        raise ValueError(f"Unsupported model parameters: {set(params) - allowed}")
    model = lgb.LGBMRegressor(objective="regression", random_state=42, deterministic=True, force_col_wise=True, verbosity=-1, **params)
    model.fit(training[features], training.erc, eval_set=[(validation[features], validation.erc)], eval_metric="l1",
              callbacks=[lgb.early_stopping(30, verbose=False)])
    model.booster_.save_model(str(output / "model.txt"))
    mean = float(training.erc.mean())
    cell_means = training.groupby("cell_id").erc.mean()
    report = {"target_definition": schema["target_definition"], "date_convention": schema["date_convention"],
              "weather_lag_days": schema["weather_lag_days"], "feature_schema_sha256": digest(prepared / "feature_schema.json"),
              "best_iteration": int(model.best_iteration_), "parameters": model.get_params(),
              "selection": "early stopping on chronological validation MAE; test unused until final evaluation",
              "pilot_only": len(schema["dates"]) <= 7, "production_ready": False,
              "versions": {p: importlib.metadata.version(p) for p in ("lightgbm", "pandas", "numpy", "scikit-learn")}, "splits": {}}
    for name, part in parts.items():
        predicted = model.predict(part[features])
        baseline = part.cell_id.map(cell_means).fillna(mean)
        predictions = part[KEYS + ["erc"]].copy()
        predictions["prediction"], predictions["baseline_prediction"] = predicted, baseline
        predictions["date"] = predictions.date.dt.strftime("%Y-%m-%d")
        predictions.to_csv(output / f"{name}_predictions.csv", index=False)
        report["splits"][name] = {"rows": len(part), "days": int(part.date.nunique()),
                                   "first_date": str(part.date.min().date()), "last_date": str(part.date.max().date()),
                                   "lightgbm": metrics(part.erc, predicted), "baseline_train_cell_mean": metrics(part.erc, baseline),
                                   "baseline_train_global_mean": metrics(part.erc, [mean] * len(part))}
    save_json(output / "evaluation.json", report)
    save_json(output / "feature_schema.json", schema)
    save_json(output / "run_config.json", config)
    import shutil
    shutil.copyfile(config["crosswalk"], output / "grid_id_mapping.csv")
    pd.DataFrame({"feature": features, "gain": model.booster_.feature_importance(importance_type="gain")}).to_csv(output / "feature_importance.csv", index=False)
    # Check exported native model gives the same predictions as sklearn wrapper.
    import numpy as np
    restored = lgb.Booster(model_file=str(output / "model.txt"))
    np.testing.assert_allclose(restored.predict(parts["test"][features]), model.predict(parts["test"][features]))
    return report


def train_partitioned(config, prepared, output):
    """Train from streamed split tables without assembling a 35M-row frame."""
    import numpy as np
    import pandas as pd
    import lightgbm as lgb
    prepared, output = Path(prepared), Path(output)
    output.mkdir(parents=True, exist_ok=False)
    schema = json.loads((prepared / "feature_schema.json").read_text())
    if schema.get("prepared_format") != "daily_streamed_split_csv_gzip":
        raise ValueError("Expected prepare-streamed output")
    for split in ("train", "validation", "test"):
        path = prepared / schema["splits"][split]["file"]
        if digest(path) != schema["splits"][split]["sha256"]:
            raise ValueError(f"Prepared {split} table hash does not match feature schema")
    if digest(config["crosswalk"]) != schema["crosswalk"]["crosswalk_sha256"]:
        raise ValueError("Grid mapping changed since prepare")
    for key in ("weather_lag_days", "target_definition", "date_convention"):
        if config[key] != schema[key]:
            raise ValueError(f"Config changed since prepare: {key}")
    features = schema["features"]
    parameters = config.get("parameters", {})
    allowed = {"n_estimators", "learning_rate", "num_leaves", "max_depth", "min_child_samples", "reg_lambda", "reg_alpha", "n_jobs", "max_bin"}
    if set(parameters) - allowed:
        raise ValueError(f"Unsupported model parameters: {set(parameters) - allowed}")
    usecols = features + ["erc"]
    dtypes = {name: np.float32 for name in usecols}
    train = pd.read_csv(prepared / "train.csv.gz", usecols=usecols, dtype=dtypes)
    validation = pd.read_csv(prepared / "validation.csv.gz", usecols=usecols, dtype=dtypes)
    if train.empty or validation.empty or train.erc.isna().any() or validation.erc.isna().any():
        raise ValueError("Training and validation partitions must have real, nonmissing labels")
    if any(train[f].isna().all() for f in features if f not in ELEVATION):
        raise ValueError("Entire non-elevation feature is missing")
    model = lgb.LGBMRegressor(objective="regression", random_state=42, deterministic=True,
                              force_col_wise=True, verbosity=-1, **parameters)
    fit_started = time.perf_counter()
    model.fit(train[features], train.erc, eval_set=[(validation[features], validation.erc)], eval_metric="l1",
              callbacks=[lgb.early_stopping(30, verbose=False)])
    training_seconds = time.perf_counter() - fit_started
    model.booster_.save_model(str(output / "model.txt"))
    global_mean = float(train.erc.mean())
    del train, validation
    cell_sum, cell_count = {}, {}
    for chunk in pd.read_csv(prepared / "train.csv.gz", usecols=["cell_id", "erc"], chunksize=500_000):
        grouped = chunk.groupby("cell_id").erc.agg(["sum", "count"])
        for cell, row in grouped.iterrows():
            cell_sum[cell] = cell_sum.get(cell, 0.0) + float(row["sum"])
            cell_count[cell] = cell_count.get(cell, 0) + int(row["count"])
    cell_means = {cell: cell_sum[cell] / cell_count[cell] for cell in cell_sum}
    report = {"target_definition": schema["target_definition"], "date_convention": schema["date_convention"],
              "weather_lag_days": schema["weather_lag_days"], "feature_schema_sha256": digest(prepared / "feature_schema.json"),
              "best_iteration": int(model.best_iteration_), "parameters": model.get_params(),
              "training_seconds": training_seconds,
              "selection": "early stopping on chronological validation MAE; test unused until final evaluation",
              "pilot_only": False, "production_ready": False,
              "versions": {p: importlib.metadata.version(p) for p in ("lightgbm", "pandas", "numpy", "scikit-learn")}, "splits": {}}
    for name in ("train", "validation", "test"):
        source = prepared / schema["splits"][name]["file"]
        acc = {"n": 0, "y": 0.0, "y2": 0.0, "pred_abs": 0.0, "pred_sq": 0.0,
               "base_abs": 0.0, "base_sq": 0.0, "global_abs": 0.0}
        pred_file = output / f"{name}_predictions.csv"
        wrote_header = False
        for chunk in pd.read_csv(source, usecols=KEYS + features + ["erc"], chunksize=500_000):
            dates(chunk, f"{name} partition")
            numeric(chunk, features + ["erc"], f"{name} partition")
            if chunk.erc.isna().any():
                raise ValueError(f"Missing ERC target in {name} partition")
            if chunk.duplicated(KEYS).any():
                raise ValueError(f"Duplicate cell-date in {name} partition")
            y = chunk.erc.to_numpy(dtype=np.float64)
            predicted = model.predict(chunk[features])
            baseline = chunk.cell_id.map(cell_means).fillna(global_mean).to_numpy(dtype=np.float64)
            out = chunk[KEYS + ["erc"]].copy()
            out["prediction"], out["baseline_prediction"] = predicted, baseline
            out["date"] = out.date.dt.strftime("%Y-%m-%d")
            out.to_csv(pred_file, mode="at" if wrote_header else "wt", index=False, header=not wrote_header)
            wrote_header = True
            predicted = np.asarray(predicted, dtype=np.float64)
            acc["n"] += len(y); acc["y"] += float(y.sum()); acc["y2"] += float(np.dot(y, y))
            acc["pred_abs"] += float(np.abs(y - predicted).sum()); acc["pred_sq"] += float(np.square(y - predicted).sum())
            acc["base_abs"] += float(np.abs(y - baseline).sum()); acc["base_sq"] += float(np.square(y - baseline).sum())
            acc["global_abs"] += float(np.abs(y - global_mean).sum())
        def score(abs_err, sq_err):
            total = acc["n"]
            variance = acc["y2"] - acc["y"] * acc["y"] / total
            return {"MAE": abs_err / total, "RMSE": math.sqrt(sq_err / total),
                    "R2": 1 - sq_err / variance if variance > 0 else None}
        stats = schema["splits"][name]
        if acc["n"] != stats["rows"]:
            raise ValueError(f"Prepared {name} row count differs from feature schema")
        report["splits"][name] = {"rows": int(acc["n"]), "days": len(stats["dates"]),
                                   "first_date": stats["first_date"], "last_date": stats["last_date"],
                                   "lightgbm": score(acc["pred_abs"], acc["pred_sq"]),
                                   "baseline_train_cell_mean": score(acc["base_abs"], acc["base_sq"])}
        gm_sq = acc["y2"] - 2 * global_mean * acc["y"] + global_mean * global_mean * acc["n"]
        report["splits"][name]["baseline_train_global_mean"] = score(acc["global_abs"], gm_sq)
    save_json(output / "evaluation.json", report)
    save_json(output / "feature_schema.json", schema)
    save_json(output / "run_config.json", config)
    import shutil
    shutil.copyfile(config["crosswalk"], output / "grid_id_mapping.csv")
    pd.DataFrame({"feature": features, "gain": model.booster_.feature_importance(importance_type="gain")}).to_csv(output / "feature_importance.csv", index=False)
    # Verify the serialized native Booster respects the exact feature order.
    restored = lgb.Booster(model_file=str(output / "model.txt"))
    if restored.feature_name() != features:
        raise ValueError("Exported native model feature order differs from schema")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["audit", "prepare", "prepare-streamed", "train", "train-partitioned"])
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--prepared", help="Directory from prepare; required for train")
    args = parser.parse_args()
    config = load_config(args.config)
    if args.command == "audit":
        result = audit(config, args.output)
    elif args.command == "prepare":
        result = prepare(config, args.output)
    elif args.command == "prepare-streamed":
        result = prepare_partitioned(config, args.output)
    else:
        if not args.prepared:
            parser.error("train requires --prepared")
        result = train_partitioned(config, args.prepared, args.output) if args.command == "train-partitioned" else train(config, args.prepared, args.output)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
