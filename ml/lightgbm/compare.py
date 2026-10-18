"""Compare predictions only for identical keys, labels, and target semantics."""
import argparse
import json
from pathlib import Path

from pipeline import KEYS, metrics, numeric, read_table, save_json, unique


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lightgbm-dir", required=True)
    parser.add_argument("--xgboost-predictions", required=True, help="CSV: cell_id,date,erc,prediction")
    parser.add_argument("--xgboost-metadata", required=True, help="JSON with target_definition,date_convention,weather_lag_days,split=test")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = json.loads((Path(args.lightgbm_dir) / "evaluation.json").read_text())
    other = json.loads(Path(args.xgboost_metadata).read_text())
    for key in ("target_definition", "date_convention", "weather_lag_days"):
        if other.get(key) != report[key]:
            raise ValueError(f"Cannot compare: mismatched {key}")
    if other.get("split") != "test":
        raise ValueError("XGBoost predictions must be from its held-out test partition")
    left = read_table(Path(args.lightgbm_dir) / "test_predictions.csv")
    right = read_table(args.xgboost_predictions)
    for name, frame in (("lightgbm", left), ("xgboost", right)):
        unique(frame, KEYS, name)
        numeric(frame, ["erc", "prediction"], name)
        if frame[["erc", "prediction"]].isna().any().any():
            raise ValueError(f"{name}: missing labels/predictions")
    joined = left.merge(right, on=KEYS, how="outer", suffixes=("_lgb", "_xgb"), indicator=True, validate="one_to_one")
    if not joined._merge.eq("both").all() or not joined.erc_lgb.eq(joined.erc_xgb).all():
        raise ValueError("Cannot compare: evaluation keys or exact ERC targets differ")
    save_json(args.output, {"rows": len(joined), "lightgbm": metrics(joined.erc_lgb, joined.prediction_lgb),
                            "xgboost": metrics(joined.erc_xgb, joined.prediction_xgb),
                            "note": "Same held-out examples and target semantics; model inputs may differ."})


if __name__ == "__main__":
    main()
