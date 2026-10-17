"""Offline tests. Never call the provider network."""
import csv
import io
import json
from datetime import date, timedelta
from urllib.error import HTTPError
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("fetch", ROOT / "scripts" / "fetch_weather_elevation.py")
fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)

class WeatherPipelineTests(unittest.TestCase):
    def weather_fixture(self, year):
        start = date(year, 1, 1)
        days = (date(year + 1, 1, 1) - start).days
        return {"timezone": "America/Los_Angeles",
                "daily_units": {"time": "iso8601", **fetch.UNITS},
                "daily": {"time": [(start + timedelta(days=i)).isoformat() for i in range(days)],
                          **{field: [None] * days for field in fetch.DAILY_FIELDS}}}

    def test_weather_csv_cache_and_provenance(self):
        cells = fetch.read_cells(ROOT / "data/sample_california_cells.csv", 1)
        with tempfile.TemporaryDirectory() as d, patch.object(fetch, "get_json", side_effect=[self.weather_fixture(y) for y in fetch.YEARS]) as request:
            out = Path(d)
            fetch.fetch_weather(cells, out, "historical-weather", 0)
            fetch.fetch_weather(cells, out, "historical-weather", 0)
            self.assertEqual(request.call_count, 2)
            for year, count in ((2024, 366), (2025, 365)):
                with (out / f"weather_{year}.csv").open(newline="") as fh:
                    rows = list(csv.DictReader(fh))
                self.assertEqual(len(rows), count)
                self.assertEqual(rows[0]["cell_id"], cells[0]["cell_id"])
                self.assertEqual(float(rows[0]["latitude"]), cells[0]["latitude"])
                self.assertEqual(rows[-1]["date"], f"{year}-12-31")
                self.assertEqual(rows[0]["precipitation_sum"], "")
            envelope = json.loads(next((out / "cache").glob("*.json")).read_text())
            self.assertIn("extracted_at_utc", envelope)
            self.assertIn("params", envelope)

    def test_weather_validation(self):
        for mutation in ("date", "units", "humidity", "nonfinite"):
            with self.subTest(mutation=mutation):
                p = self.weather_fixture(2024)
                if mutation == "date":
                    p["daily"]["time"][1] = p["daily"]["time"][0]
                elif mutation == "units":
                    p["daily_units"]["wind_speed_10m_max"] = "km/h"
                elif mutation == "humidity":
                    p["daily"]["relative_humidity_2m_min"][0] = 101
                else:
                    p["daily"]["temperature_2m_max"][0] = float("nan")
                with self.assertRaises(ValueError):
                    fetch.validate_weather(p, 2024)

    def test_retry_and_timeout(self):
        error = HTTPError("https://example.invalid", 429, "limited", {"Retry-After": "65"}, None)
        with patch.object(fetch, "urlopen", side_effect=[error, io.StringIO('{"ok": true}')]) as request, patch.object(fetch.time, "sleep") as sleep:
            self.assertEqual(fetch.get_json("https://example.invalid", {}), {"ok": True})
            sleep.assert_called_once_with(65)
            self.assertEqual(request.call_args.kwargs["timeout"], 90)
        with patch.object(fetch, "urlopen", side_effect=TimeoutError), patch.object(fetch.time, "sleep"):
            with self.assertRaises(RuntimeError):
                fetch.get_json("https://example.invalid", {}, retries=1)

    def test_elevation_validation(self):
        fetch.validate_elevation({"elevation": [None, -80]}, 2)
        for value in ("100", True, float("inf")):
            with self.assertRaises(ValueError):
                fetch.validate_elevation({"elevation": [value]}, 1)

    def test_invalid_response_not_cached(self):
        with tempfile.TemporaryDirectory() as d, patch.object(fetch, "get_json", return_value={"elevation": ["bad"]}):
            with self.assertRaises(ValueError):
                fetch.cached_json(fetch.ELEVATION_URL, {}, Path(d), lambda p: fetch.validate_elevation(p, 1), 0)
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_http_date_retry_after(self):
        from email.utils import format_datetime
        future = fetch.datetime.now(fetch.timezone.utc) + timedelta(seconds=90)
        self.assertGreater(fetch.retry_wait(format_datetime(future), 0), 85)
        with self.assertRaises(RuntimeError):
            fetch.retry_wait("3600", 0)

    def test_large_elevation_guard(self):
        cells = [{"cell_id": str(i), "latitude": 36, "longitude": -119} for i in range(20)]
        with patch("sys.argv", ["fetch", "--elevation-only", "--limit", "20"]), patch.object(fetch, "read_cells", return_value=cells), patch.object(fetch, "get_json") as request:
            with self.assertRaises(SystemExit):
                fetch.main()
            request.assert_not_called()

    def test_dates_and_units_contract(self):
        self.assertEqual(fetch.YEARS, (2024, 2025))
        self.assertIn("wind_direction_10m_dominant", fetch.DAILY_FIELDS)
        self.assertIn("relative_humidity_2m_min", fetch.DAILY_FIELDS)

    def test_read_cells_from_sample(self):
        cells = fetch.read_cells(ROOT / "data" / "sample_california_cells.csv", 1)
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]["cell_id"], "CA_FRESNO")

    def test_duplicate_cells_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"cells.csv"
            p.write_text("cell_id,latitude,longitude\nA,36.7,-119.7\nA,36.7,-119.7\n")
            with self.assertRaises(ValueError):
                fetch.read_cells(p, None)

    def test_wrong_weather_payload_rejected(self):
        cells = fetch.read_cells(ROOT / "data" / "sample_california_cells.csv", 1)
        fake = {"daily": {"time": ["2024-01-01"]}}
        with tempfile.TemporaryDirectory() as d, patch.object(fetch, 'get_json', return_value=fake):
            with self.assertRaisesRegex(ValueError, "expected"):
                fetch.fetch_weather(cells, Path(d), "historical-forecast", 0)

    def test_mocked_elevation(self):
        cells = fetch.read_cells(ROOT / "data" / "sample_california_cells.csv", 2)
        with tempfile.TemporaryDirectory() as d, patch.object(fetch, 'get_json', return_value={"elevation": [95.1, 110.2]}):
            fetch.fetch_elevation(cells, Path(d), 0)
            with (Path(d)/"elevation.csv").open(newline='') as fh:
                rows = list(csv.DictReader(fh))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]['elevation_m'], '95.1')
            self.assertEqual(rows[1]['cell_id'], 'CA_REDDING')

if __name__=='__main__':
    unittest.main()
