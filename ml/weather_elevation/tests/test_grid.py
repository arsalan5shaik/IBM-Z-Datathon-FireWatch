"""Offline grid fixtures; GIS checks skip when optional packages are absent."""
import csv
import importlib.util
import json
import math
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("grid", ROOT / "scripts/build_prediction_grid.py")
grid = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(grid)
try:
    grid.require_gis()
    GIS = True
except SystemExit:
    GIS = False


class GridIDTests(unittest.TestCase):
    def test_half_open_ids_negative_coordinates_and_sizes(self):
        self.assertEqual(grid.point_cell_id(0, 0), "ca_3km_3310_v1_c0_r0")
        self.assertEqual(grid.point_cell_id(-0.01, -3000), "ca_3km_3310_v1_c-1_r-1")
        self.assertEqual(grid.point_cell_id(3000, 3000), "ca_3km_3310_v1_c1_r1")
        self.assertEqual(grid.point_cell_id(4999, 5000, 5000), "ca_5km_3310_v1_c0_r1")


@unittest.skipUnless(GIS, "Optional workstation GIS dependencies not installed")
class GridGeometryTests(unittest.TestCase):
    def setUp(self):
        # Includes partial edges and a hole; all synthetic coordinates in meters.
        self.state = grid.box(-4500, -4500, 7500, 7500).difference(grid.box(500, 500, 1500, 1500))
        self.region = self.state.intersection(grid.box(-1000, -1000, 4000, 4000))
        self.pairs = list(grid.generate(self.state, self.region))
        self.rows = [r for r, _ in self.pairs]

    def test_dimensions_coverage_geometry_and_coordinates(self):
        grid.validate_records(self.rows, self.state, self.region, 3000)
        self.assertEqual(len(self.rows), len({r["cell_id"] for r in self.rows}))
        for r in self.rows:
            self.assertEqual(r["full_square_area_m2"], 9_000_000)
            self.assertGreater(r["boundary_coverage_fraction"], 0)
            self.assertIsNone(r["land_coverage_fraction"])
            self.assertEqual(grid.shape(json.loads(r["geometry_wgs84"])).geom_type, "Polygon")

    def test_pilot_and_statewide_have_identical_ids_samples_and_anchors(self):
        all_rows = {r["cell_id"]: r for r, _ in grid.generate(self.state, self.state)}
        for r in self.rows:
            self.assertEqual({k: v for k, v in r.items() if k != "selection_coverage_fraction"},
                             {k: v for k, v in all_rows[r["cell_id"]].items() if k != "selection_coverage_fraction"})

    def test_5km_uses_same_logic(self):
        records = [r for r, _ in grid.generate(self.state, self.region, 5000)]
        grid.validate_records(records, self.state, self.region, 5000)
        self.assertTrue(all(r["full_square_area_m2"] == 25_000_000 for r in records))

    def test_anchor_nearest_distance_and_tie_break(self):
        converter = grid.pyproj.Transformer.from_crs(grid.CRS, "EPSG:4326", always_xy=True)
        for x, y in ((0, 0), (-1, -1), (9999, 9999), (10500, -9000)):
            anchor, distance = grid.nearest_anchor(x, y, converter)
            brute = min((math.hypot((c + .5)*10000 - x, (r + .5)*10000 - y), c, r)
                        for c in range(-3, 4) for r in range(-3, 4))
            self.assertAlmostEqual(distance, brute[0])
            self.assertEqual(anchor["x_m"], (brute[1] + .5)*10000)
            self.assertLessEqual(distance, math.sqrt(2)*5000)

    def test_csv_readable_by_existing_pipeline_without_network(self):
        spec = importlib.util.spec_from_file_location("fetch", ROOT / "scripts/fetch_weather_elevation.py")
        fetch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fetch)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "cells.csv"
            grid.write_csv(path, self.rows)
            cells = fetch.read_cells(path, None)
            self.assertEqual(len(cells), len(self.rows))
            self.assertEqual(cells[0]["cell_id"], self.rows[0]["cell_id"])
            with path.open(newline="") as stream:
                restored = list(csv.DictReader(stream))
            self.assertEqual(json.loads(restored[0]["geometry_wgs84"]), json.loads(self.rows[0]["geometry_wgs84"]))

    def test_interior_point_fallback_and_disconnected_geometry(self):
        state = grid.box(0, 0, 3000, 3000).difference(grid.box(500, 500, 2500, 2500))
        row, _ = next(grid.generate(state, state))
        self.assertEqual(row["sample_method"], "state_clipped_interior_point")
        self.assertTrue(state.contains(grid.Point(row["x_m"], row["y_m"])))
        state = grid.unary_union([grid.box(0, 0, 500, 500), grid.box(2000, 2000, 2500, 2500)])
        rows = [r for r, _ in grid.generate(state, state)]
        grid.validate_records(rows, state, state, 3000)
        self.assertEqual(json.loads(rows[0]["geometry_wgs84"])["type"], "MultiPolygon")

    def test_tampered_dimensions_rejected(self):
        self.rows[0]["square_max_x_m"] += 1
        with self.assertRaisesRegex(ValueError, "dimensions"):
            grid.validate_records(self.rows, self.state, self.region, 3000)


if __name__ == "__main__":
    unittest.main()
