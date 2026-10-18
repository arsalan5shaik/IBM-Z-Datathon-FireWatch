"""Offline contract tests. No generated ERC labels, fit, network or installation."""
import csv
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from spatial import build_crosswalk, digest, geometry_key
from pipeline import load_config


def polygon(x=0):
    return {"type": "Polygon", "coordinates": [[[x, 0], [x+1, 0], [x+1, 1], [x, 1], [x, 0]]]}


def write_grid(path, features):
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"cell_id": key}, "geometry": geometry} for key, geometry in features]}))


class SpatialTests(unittest.TestCase):
    def test_ring_winding_start_and_feature_order_do_not_define_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            n, a, out = directory/"n.json", directory/"a.json", directory/"mapping.csv"
            first = polygon()
            reversed_ring = {"type": "Polygon", "coordinates": [list(reversed(first["coordinates"][0]))]}
            write_grid(n, [(20, first), (3, polygon(2))])
            write_grid(a, [("ca_3km_3310_v1_c2_r0", polygon(2)), ("ca_3km_3310_v1_c0_r0", reversed_ring)])
            manifest = build_crosswalk(n, a, out)
            with out.open() as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(rows[0]["numeric_cell_id"], "20")
            self.assertEqual(rows[0]["cell_id"], "ca_3km_3310_v1_c0_r0")
            self.assertEqual(manifest["crosswalk_sha256"], digest(out))

    def test_equal_counts_and_centers_do_not_establish_boundary_equivalence(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            n, a = directory/"n.json", directory/"a.json"
            write_grid(n, [(1, polygon())])
            altered = polygon()
            altered["coordinates"][0][1][0] = 0.9
            write_grid(a, [("ca_3km_3310_v1_c0_r0", altered)])
            with self.assertRaisesRegex(ValueError, "no exact boundary match"):
                build_crosswalk(n, a, directory/"out.csv")

    def test_holes_preserved(self):
        g = polygon()
        h = polygon()
        h["coordinates"].append([[0.2,0.2],[0.3,0.2],[0.3,0.3],[0.2,0.2]])
        self.assertNotEqual(geometry_key(g), geometry_key(h))

    def test_future_weather_lag_rejected(self):
        config = json.loads((ROOT/"config.example.json").read_text())
        config["weather_lag_days"] = 0
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)/"config.json"
            p.write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, "weather_lag_days"):
                load_config(p)


@unittest.skipUnless(importlib.util.find_spec("pandas"), "pandas is not available in this interpreter")
class DataTests(unittest.TestCase):
    def test_inference_join_uses_previous_date_and_retains_missing_elevation(self):
        import pandas as pd
        from pipeline import assemble
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            n, a, crosswalk = directory/"n.json", directory/"a.json", directory/"mapping.csv"
            write_grid(n, [(20, polygon()), (3, polygon(2))])
            ids = ["ca_3km_3310_v1_c0_r0", "ca_3km_3310_v1_c2_r0"]
            write_grid(a, [(ids[1], polygon(2)), (ids[0], polygon())])
            build_crosswalk(n, a, crosswalk)
            pd.DataFrame({"cell_id": ["20", "3"], "min_elevation_m": [float("nan"), -5.0],
                          "max_elevation_m": [float("nan"), 0.0]}).to_csv(directory/"elevation.csv", index=False)
            pd.DataFrame({"cell_id": ["20", "3"], "date": ["2024-07-19"]*2,
                          "temperature": [20.0, 21.0]}).to_csv(directory/"weather.csv", index=False)
            vegetation = pd.DataFrame({"cell_id": ids, "available_date": ["2020-01-01"]*2, "vegetation_fraction": [0.5, 0.7]})
            vegetation.to_csv(directory/"vegetation.csv", index=False)
            config = {"grid": str(n), "crosswalk": str(crosswalk), "elevation": str(directory/"elevation.csv"),
                      "weather": {"path": str(directory/"weather.csv"), "id_namespace": "numeric"},
                      "vegetation": {"path": str(directory/"vegetation.csv"), "id_namespace": "authoritative"},
                      "weather_features": ["temperature"], "vegetation_features": ["vegetation_fraction"], "weather_lag_days": 1}
            frame, features, manifest = assemble(config, labels=False)
            self.assertEqual(set(frame.cell_id), set(ids))
            self.assertTrue(frame.date.eq(pd.Timestamp("2024-07-20")).all())
            self.assertTrue((frame.weather_source_date < frame.date).all())
            self.assertTrue(pd.isna(frame.set_index("cell_id").loc[ids[0], "min_elevation_m"]))
            self.assertEqual(frame.set_index("cell_id").loc[ids[1], "min_elevation_m"], -5)
            self.assertEqual(frame.set_index("cell_id").loc[ids[1], "max_elevation_m"], 0)
            self.assertNotIn("erc", features)
            vegetation["available_date"] = "2025-01-01"
            vegetation.to_csv(directory/"vegetation.csv", index=False)
            with self.assertRaisesRegex(ValueError, "after target date"):
                assemble(config, labels=False)

    def test_chronological_splits_keep_whole_dates_together(self):
        import pandas as pd
        from pipeline import chronological_parts
        # Test dates/keys only. No ERC labels are fabricated.
        frame = pd.DataFrame({"cell_id": ["a", "b"]*3,
                              "date": pd.to_datetime(["2024-07-20"]*2 + ["2024-07-24"]*2 + ["2024-07-26"]*2)})
        parts = chronological_parts(frame, "2024-07-24", "2024-07-26")
        self.assertEqual([len(parts[k]) for k in ("train", "validation", "test")], [2, 2, 2])
        self.assertLess(parts["train"].date.max(), parts["validation"].date.min())
        self.assertLess(parts["validation"].date.max(), parts["test"].date.min())
        with self.assertRaises(ValueError):
            chronological_parts(frame, "2024-07-26", "2024-07-24")
        with self.assertRaises(ValueError):
            chronological_parts(frame, "2023-01-01", "2024-07-26")

    def test_missing_elevation_zero_negative_and_non_numeric(self):
        import pandas as pd
        from pipeline import numeric
        table = pd.DataFrame({"min_elevation_m": [0.0, -84.0, float("nan")]})
        numeric(table, ["min_elevation_m"], "elevation")
        self.assertEqual(table.iloc[0,0], 0)
        self.assertEqual(table.iloc[1,0], -84)
        self.assertTrue(pd.isna(table.iloc[2,0]))
        with self.assertRaises(ValueError):
            numeric(pd.DataFrame({"x": ["broken"]}), ["x"], "bad")

    def test_duplicate_cell_date_rejected(self):
        import pandas as pd
        from pipeline import unique
        with self.assertRaises(ValueError):
            unique(pd.DataFrame({"cell_id": ["1", "1"], "date": ["2024-01-01"]*2}), ["cell_id", "date"], "bad")

    def test_namespace_is_explicit_and_unknown_ids_rejected(self):
        import pandas as pd
        from pipeline import align
        mapping = pd.DataFrame({"numeric_cell_id": ["1"], "cell_id": ["ca_3km_3310_v1_c0_r0"]})
        with self.assertRaisesRegex(ValueError, "unknown grid IDs"):
            align(pd.DataFrame({"cell_id": ["CA_FRESNO"]}), {"id_namespace": "authoritative"}, mapping, "weather")
        with self.assertRaisesRegex(ValueError, "explicitly specify"):
            align(pd.DataFrame({"cell_id": ["1"]}), {}, mapping, "weather")


if __name__ == "__main__":
    unittest.main()
