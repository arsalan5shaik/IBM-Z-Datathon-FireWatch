"""One validation-only regularization experiment; never reads the held-out test table."""
import argparse
import importlib.metadata
import json
import math
import time
from pathlib import Path

from pipeline import digest, load_config, save_json


def _score(acc):
    n = acc["n"]
    variance = acc["y2"] - acc["y"] * acc["y"] / n
    return {"rows": n, "MAE": acc["abs"] / n,
            "RMSE": math.sqrt(acc["sq"] / n),
            "R2": 1.0 - acc["sq"] / variance if variance > 0 else None}


def run(config_path, prepared_path, original_path, output_path):
    import numpy as np
    import pandas as pd
    import lightgbm as lgb

    config = load_config(config_path)
    prepared, original_path, output = Path(prepared_path), Path(original_path), Path(output_path)
    if output.exists():
        raise FileExistsError(f"Refusing to modify an existing experiment directory: {output}")
    schema = json.loads((prepared / "feature_schema.json").read_text(encoding="utf-8"))
    if schema.get("prepared_format") != "daily_streamed_split_csv_gzip":
        raise ValueError("Expected the verified partitioned historical dataset")
    if config.get("random_seed") != 42:
        raise ValueError("This experiment is fixed to random_seed=42")
    if digest(config["crosswalk"]) != schema["crosswalk"]["crosswalk_sha256"]:
        raise ValueError("Prepared table mapping differs from experiment config")
    for name in ("train", "validation"):
        path = prepared / schema["splits"][name]["file"]
        if digest(path) != schema["splits"][name]["sha256"]:
            raise ValueError(f"Prepared {name} data hash differs from its feature schema")
    original_schema = json.loads((original_path / "feature_schema.json").read_text(encoding="utf-8"))
    if schema["features"] != original_schema["features"]:
        raise ValueError("Original model and prepared feature orders differ")
    if schema["crosswalk"]["crosswalk_sha256"] != original_schema["crosswalk"]["crosswalk_sha256"]:
        raise ValueError("Original model and prepared grids differ")
    for key in ("target_definition", "date_convention", "weather_lag_days", "grid_version"):
        if original_schema.get(key) != schema.get(key):
            raise ValueError(f"Original model and prepared data differ for {key}")
    for key in ("target_definition", "date_convention", "weather_lag_days"):
        if config.get(key) != schema.get(key):
            raise ValueError(f"Prepared data and experiment config differ for {key}")
    if (config["validation_start"] != schema["splits"]["validation"]["first_date"]
            or config["test_start"] != schema["splits"]["test"]["first_date"]):
        raise ValueError("Experiment config split dates differ from prepared partitions")
    if int(config["early_stopping_rounds"]) < 1 or float(config["max_training_minutes"]) <= 0:
        raise ValueError("Early-stopping patience and fit-time limit must be positive")

    original = lgb.Booster(model_file=str(original_path / "model.txt"))
    features = schema["features"]
    if original.feature_name() != features:
        raise ValueError("Original model feature order differs from prepared schema")

    out_train = pd.read_csv(prepared / schema["splits"]["train"]["file"],
                             usecols=features + ["erc"], dtype={f: np.float32 for f in features + ["erc"]})
    out_val = pd.read_csv(prepared / schema["splits"]["validation"]["file"],
                          usecols=features + ["erc"], dtype={f: np.float32 for f in features + ["erc"]})
    if out_train.erc.isna().any() or out_val.erc.isna().any():
        raise ValueError("Training and validation labels must be present historical ERC values")
    parameters = config["parameters"]
    allowed = {"n_estimators", "learning_rate", "num_leaves", "max_depth", "min_child_samples",
               "reg_lambda", "reg_alpha", "n_jobs", "max_bin"}
    if set(parameters) - allowed:
        raise ValueError(f"Unsupported LightGBM parameters: {set(parameters)-allowed}")
    model = lgb.LGBMRegressor(objective="regression", random_state=42, deterministic=True,
                              force_col_wise=True, verbosity=-1, **parameters)
    deadline = time.perf_counter() + float(config["max_training_minutes"]) * 60

    def stop_at_deadline(env):
        if time.perf_counter() >= deadline:
            raise TimeoutError(f"Fit exceeded {config['max_training_minutes']} minute experiment limit")
    stop_at_deadline.order = 40
    started = time.perf_counter()
    try:
        model.fit(out_train[features], out_train.erc,
                  eval_set=[(out_val[features], out_val.erc)], eval_metric="l1",
                  callbacks=[lgb.early_stopping(int(config["early_stopping_rounds"]), verbose=False),
                             stop_at_deadline])
    except TimeoutError as exc:
        output.mkdir(parents=True, exist_ok=False)
        (output / "TIMEOUT.txt").write_text(str(exc) + "\n", encoding="utf-8")
        raise
    training_seconds = time.perf_counter() - started
    del out_train, out_val

    output.mkdir(parents=True, exist_ok=False)
    model.booster_.save_model(str(output / "model.txt"))
    (output / "feature_schema.json").write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
    (output / "experiment_config.json").write_text(Path(config_path).read_text(encoding="utf-8"), encoding="utf-8")
    import shutil
    shutil.copyfile(config["crosswalk"], output / "grid_id_mapping.csv")

    totals = {"original": {"n": 0, "y": 0.0, "y2": 0.0, "abs": 0.0, "sq": 0.0},
              "regularized": {"n": 0, "y": 0.0, "y2": 0.0, "abs": 0.0, "sq": 0.0}}
    val_path = prepared / schema["splits"]["validation"]["file"]
    for chunk in pd.read_csv(val_path, usecols=features + ["erc"],
                             dtype={f: np.float32 for f in features + ["erc"]}, chunksize=250_000):
        y = chunk.erc.to_numpy(dtype=np.float64)
        if np.isnan(y).any():
            raise ValueError("Missing label encountered during validation evaluation")
        preds = {"original": original.predict(chunk[features]),
                 "regularized": model.predict(chunk[features])}
        for name, pred in preds.items():
            err = y - np.asarray(pred, dtype=np.float64)
            item = totals[name]
            item["n"] += len(y); item["y"] += float(y.sum()); item["y2"] += float(np.dot(y, y))
            item["abs"] += float(np.abs(err).sum()); item["sq"] += float(np.dot(err, err))

    if any(item["n"] != schema["splits"]["validation"]["rows"] for item in totals.values()):
        raise ValueError("Validation row count differs from prepared split schema")
    scores = {name: _score(item) for name, item in totals.items()}
    preferred = "regularized" if scores["regularized"]["MAE"] < scores["original"]["MAE"] else "original"
    base_gain = original.feature_importance(importance_type="gain")
    alt_gain = model.booster_.feature_importance(importance_type="gain")
    gain_sum_base, gain_sum_alt = float(base_gain.sum()), float(alt_gain.sum())
    pd.DataFrame({"feature": features, "original_gain": base_gain, "regularized_gain": alt_gain,
                  "original_gain_share": base_gain / gain_sum_base if gain_sum_base else 0,
                  "regularized_gain_share": alt_gain / gain_sum_alt if gain_sum_alt else 0}).to_csv(
                      output / "feature_importance_comparison.csv", index=False)
    report = {"experiment": "single_regularized_lightgbm_alternative", "selection_metric": "validation MAE",
              "test_data_accessed": False, "test_data_used_for_selection": False,
              "target_definition": schema["target_definition"], "feature_order": features,
              "validation_period": {"start": schema["splits"]["validation"]["first_date"],
                                    "end": schema["splits"]["validation"]["last_date"],
                                    "rows": schema["splits"]["validation"]["rows"]},
              "original_model_dir": str(original_path), "original_validation_metrics": scores["original"],
              "regularized_validation_metrics": scores["regularized"],
              "preferred_by_validation_MAE": preferred, "best_iteration": int(model.best_iteration_),
              "training_seconds": training_seconds, "random_seed": 42, "parameters": model.get_params(),
              "versions": {p: importlib.metadata.version(p) for p in ("lightgbm", "pandas", "numpy")}}
    save_json(output / "validation_comparison.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--prepared", required=True)
    parser.add_argument("--original-model", required=True)
    parser.add_argument("--output", required=True, help="New, non-existing experiment directory")
    args = parser.parse_args()
    print(json.dumps(run(args.config, args.prepared, args.original_model, args.output), indent=2))


if __name__ == "__main__":
    main()
