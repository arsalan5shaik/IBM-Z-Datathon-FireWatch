"""Predict ERC with the native LightGBM model and exact training feature contract."""
import argparse
import json
from pathlib import Path

from pipeline import KEYS, assemble, dates, load_config, numeric, read_table, unique


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--features", help="CSV/CSV.GZ with cell_id,date and each schema feature")
    inputs.add_argument("--config", help="Rebuild features from configured weather/static files")
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--contributions-output", help="Optional native LightGBM per-feature contributions CSV")
    args = parser.parse_args()
    import pandas as pd
    import lightgbm as lgb

    directory = Path(args.model_dir)
    schema = json.loads((directory / "feature_schema.json").read_text())
    features = schema["features"]
    start, end = pd.Timestamp(args.start_date), pd.Timestamp(args.end_date)
    if start > end:
        raise ValueError("start-date exceeds end-date")
    model = lgb.Booster(model_file=str(directory / "model.txt"))
    if model.feature_name() != features:
        raise ValueError("Native model feature order differs from schema")
    mapping = pd.read_csv(directory / "grid_id_mapping.csv", dtype=str)
    valid_cells = set(mapping.cell_id)

    if args.config:
        config = load_config(args.config)
        for key in ("weather_lag_days", "date_convention", "target_definition"):
            if config[key] != schema[key]:
                raise ValueError(f"Inference config mismatch: {key}")
        frame, assembled_features, crosswalk = assemble(config, labels=False)
        if crosswalk != schema["crosswalk"] or assembled_features != features:
            raise ValueError("Inference grid/feature schema differs from training")
        chunks = [frame]
    else:
        header = pd.read_csv(args.features, nrows=0).columns.tolist()
        required = KEYS + features
        if set(required) - set(header):
            raise ValueError(f"Inference feature file lacks schema columns: {sorted(set(required)-set(header))}")
        chunks = pd.read_csv(args.features, usecols=required, dtype={"cell_id": "string"}, chunksize=250_000)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    contrib_path = Path(args.contributions_output) if args.contributions_output else None
    if contrib_path:
        contrib_path.parent.mkdir(parents=True, exist_ok=True)
    seen, found_dates, count = set(), set(), 0
    wrote_predictions = wrote_contributions = False
    for chunk in chunks:
        dates(chunk, "inference")
        chunk = chunk[(chunk.date >= start) & (chunk.date <= end)].copy()
        if chunk.empty:
            continue
        unique(chunk, KEYS, "inference chunk")
        ids = set(chunk.cell_id)
        if ids - valid_cells:
            raise ValueError("Inference contains IDs outside the trained authoritative grid")
        numeric(chunk, features, "inference")
        keys = list(zip(chunk.cell_id.astype(str), chunk.date.dt.strftime("%Y-%m-%d")))
        if any(key in seen for key in keys):
            raise ValueError("Duplicate cell-date key across inference chunks")
        seen.update(keys)
        found_dates.update(chunk.date.dt.strftime("%Y-%m-%d").unique())
        prediction = model.predict(chunk[features])
        result = chunk[KEYS].copy()
        result["predicted_erc"] = prediction
        result["date"] = result.date.dt.strftime("%Y-%m-%d")
        result["grid_version"] = schema["grid_version"]
        result.to_csv(output_path, mode="at" if wrote_predictions else "wt", index=False,
                      header=not wrote_predictions)
        wrote_predictions = True
        count += len(result)
        if contrib_path:
            contributions = model.predict(chunk[features], pred_contrib=True)
            if contributions.shape[1] != len(features) + 1:
                raise ValueError("Native contribution output differs from ordered schema plus bias")
            table = chunk[KEYS].copy()
            for i, feature in enumerate(features):
                table[feature] = contributions[:, i]
            table["bias"] = contributions[:, -1]
            table["date"] = table.date.dt.strftime("%Y-%m-%d")
            table.to_csv(contrib_path, mode="at" if wrote_contributions else "wt", index=False,
                         header=not wrote_contributions)
            wrote_contributions = True
    expected_dates = set(pd.date_range(start, end).strftime("%Y-%m-%d"))
    if not wrote_predictions or expected_dates - found_dates:
        raise ValueError(f"No rows or missing requested inference dates: {sorted(expected_dates-found_dates)}")
    print(f"Wrote {count} ERC predictions to {output_path}")
    if contrib_path:
        print(f"Wrote native LightGBM contributions to {contrib_path}")


if __name__ == "__main__":
    main()
