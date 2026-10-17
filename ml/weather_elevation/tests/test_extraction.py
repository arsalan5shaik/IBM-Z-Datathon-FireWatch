"""Offline tests for batching, identity, validation and interruption recovery."""
import csv
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import extract_statewide_features as extract


def fixture(batch, year):
    days = (date(year + 1, 1, 1) - date(year, 1, 1)).days
    return [{"latitude": a["latitude"], "longitude": a["longitude"], "location_id": i,
             "timezone": "America/Los_Angeles", "daily_units": {"time": "iso8601", **extract.UNITS},
             "daily": {"time": [(date(year, 1, 1) + timedelta(days=n)).isoformat() for n in range(days)],
                       **{field: [1.0] * days for field in extract.DAILY_FIELDS}}}
            for i, a in enumerate(batch)]


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        output = patch("sys.stdout", new_callable=io.StringIO)
        output.start()
        self.addCleanup(output.stop)
        self.anchors = [{"weather_anchor_id": f"A{i}", "latitude": 36.0+i*.01, "longitude": -119.0} for i in range(10)]
        self.cells = [{"cell_id": f"C{i}", "grid_version": "v1", "latitude": 36.0+i*.001,
                       "longitude": -119.0, "weather_anchor_id": f"A{i//2}"} for i in range(20)]
        self.mapping = [{"grid_version": "v1", "cell_id": c["cell_id"],
                         "weather_anchor_id": c["weather_anchor_id"], "distance_km": "1"} for c in self.cells]

    def make_inputs(self, directory):
        directory.mkdir()
        for name, rows in (("california_grid_3km.csv", self.cells),
                           ("california_grid_3km_weather_anchors.csv", self.anchors),
                           ("california_grid_3km_cell_weather_mapping.csv", self.mapping)):
            extract.write_csv(directory / name, list(rows[0]), rows)

    def test_pilot_selection_and_plan(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d) / "inputs"
            self.make_inputs(directory)
            anchors, cells, mapping = extract.inputs(directory, "pilot")
            self.assertEqual((len(anchors), len(cells), len(mapping)), (10, 20, 20))
            plan = extract.run(directory, Path(d)/"out", Path(d)/"usage.json")
            self.assertEqual(plan["weather_http_requests_before_retries"], 2)
            self.assertEqual(plan["weather_rows"], 7310)
            self.assertFalse((Path(d)/"out").exists())

    def test_interrupted_run_resumes_without_repeating_successes(self):
        with tempfile.TemporaryDirectory() as d:
            directory, out = Path(d)/"inputs", Path(d)/"out"
            self.make_inputs(directory)
            first = fixture(self.anchors, 2024)
            first[0]["daily"]["precipitation_sum"][0] = None
            with patch.object(extract.Client, "request", side_effect=[first, RuntimeError("interrupted")]) as request:
                with self.assertRaises(RuntimeError):
                    extract.run(directory, out, Path(d)/"usage.json", live=True)
                self.assertEqual(request.call_count, 2)
            self.assertTrue((out/"weather_2024.csv").exists())
            self.assertFalse((out/"weather_2025.csv").exists())
            with patch.object(extract.Client, "request", side_effect=[fixture(self.anchors, 2025), {"elevation": [91.0]*20}]) as request:
                report = extract.run(directory, out, Path(d)/"usage.json", live=True)
                self.assertEqual(request.call_count, 2)
            self.assertEqual(report["api_usage_this_run"]["cache_hits"], 1)
            self.assertEqual(report["data_quality"]["2024"]["missing_by_variable"]["precipitation_sum"], 1)
            with (out/"weather_2024.csv").open(newline="") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 3660)
            self.assertEqual(rows[0]["weather_anchor_id"], "A0")
            self.assertEqual(rows[0]["precipitation_sum"], "")
            with patch.object(extract.Client, "request") as request:
                report = extract.run(directory, out, Path(d)/"usage.json", live=True)
                request.assert_not_called()
                self.assertEqual(report["api_usage_this_run"]["cache_hits"], 3)

    def test_location_identity_coordinates_and_shape_validation(self):
        for kind in ("order", "count", "coordinate", "dates", "units", "nonfinite"):
            with self.subTest(kind=kind):
                p = fixture(self.anchors, 2024)
                if kind == "order": p[0]["location_id"] = 1
                if kind == "count": p.pop()
                if kind == "coordinate": p[0]["latitude"] = 0
                if kind == "dates": p[0]["daily"]["time"][1] = "2024-01-01"
                if kind == "units": p[0]["daily_units"]["wind_speed_10m_max"] = "km/h"
                if kind == "nonfinite": p[0]["daily"]["temperature_2m_max"][0] = float("nan")
                with self.assertRaises(ValueError):
                    extract.response_locations(p, self.anchors, 2024)

    def test_bad_payload_is_not_cached(self):
        with tempfile.TemporaryDirectory() as d:
            client = extract.Client(Path(d), Path(d)/"usage.json")
            with patch.object(client, "request", return_value={"elevation": ["bad"]}):
                with self.assertRaises(ValueError):
                    client.get(extract.ELEVATION_URL, {}, ["C0"], lambda p: extract.validate_elevation(p, 1), 1)
            self.assertEqual(list(client.cache.iterdir()), [])

    def test_quota_budget_persists_and_blocks_hourly_excess(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = Path(d)/"usage.json"
            client = extract.Client(Path(d), ledger)
            client.reserve(10)
            self.assertEqual(json.loads(ledger.read_text())[0]["units"], 10)
            extract.atomic_json(ledger, [{"at": extract.time.time()-120, "units": 3999}])
            with self.assertRaisesRegex(RuntimeError, "budget"):
                client.reserve(10)

    def test_429_retry_after_and_bounded_timeout_retries(self):
        class Response(io.BytesIO):
            headers = {}
        with tempfile.TemporaryDirectory() as d:
            client = extract.Client(Path(d), Path(d)/"usage.json")
            limited = HTTPError("https://example.invalid", 429, "limited", {"Retry-After": "2"}, None)
            with patch.object(extract, "urlopen", side_effect=[limited, Response(b'{"elevation":[91]}')]), patch.object(extract.time, "sleep"):
                self.assertEqual(client.request("https://example.invalid", {}, 1), {"elevation": [91]})
            self.assertEqual(client.stats["http_attempts"], 2)
            with patch.object(extract, "urlopen", side_effect=TimeoutError), patch.object(extract.time, "sleep"):
                with self.assertRaises(RuntimeError):
                    client.request("https://example.invalid", {}, 1)
            self.assertEqual(client.stats["http_attempts"], 6)

    def test_statewide_live_requires_separate_approval(self):
        with patch("sys.argv", ["extract", "--scope", "statewide", "--live"]), patch.object(extract, "run") as run:
            with self.assertRaises(SystemExit):
                extract.main()
            run.assert_not_called()

    def test_mapping_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)/"inputs"
            self.mapping[0]["weather_anchor_id"] = "unknown"
            self.make_inputs(directory)
            with self.assertRaisesRegex(ValueError, "mapping"):
                extract.inputs(directory, "pilot")


if __name__ == "__main__":
    unittest.main()
