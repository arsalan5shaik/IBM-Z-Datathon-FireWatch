#!/usr/bin/env python3
"""Inspect ONE actual seven-day ECMWF forecast issued during 2024-25.

The `run` timestamp is a model INITIALISATION, not the time results were
available. Account for publication delay during rigorous backtesting.
"""
import argparse
import json
from pathlib import Path
from datetime import date, timedelta
from fetch_weather_elevation import cached_json, numeric, UNITS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Make one request, only after approval")
    args = parser.parse_args()
    params = {
        "latitude": 36.7378, "longitude": -119.7871,
        "run": "2025-08-01T00:00", "models": "ecmwf_ifs", "forecast_days": 7,
        "daily": "temperature_2m_max,precipitation_sum,wind_speed_10m_max",
        "timezone": "America/Los_Angeles", "wind_speed_unit": "ms",
    }
    if not args.live:
        print("DRY RUN: one archived forecast request; use --live only after approval.")
        print(json.dumps(params, indent=2))
        return
    cache = Path(__file__).resolve().parents[1] / "output" / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    def validate(payload):
        if not isinstance(payload, dict) or not isinstance(payload.get("daily"), dict):
            raise ValueError("Missing daily forecast data")
        data = payload["daily"]
        dates = data.get("time", [])
        if len(dates) != 7 or len(set(dates)) != 7:
            raise ValueError("Expected seven distinct forecast dates")
        first = date.fromisoformat(dates[0])
        if dates != [(first + timedelta(days=i)).isoformat() for i in range(7)]:
            raise ValueError("Forecast dates must be consecutive")
        if payload.get("timezone") != params["timezone"]:
            raise ValueError("Unexpected forecast timezone")
        for field in params["daily"].split(","):
            if len(data.get(field, [])) != 7:
                raise ValueError(f"Missing forecast field: {field}")
            if payload.get("daily_units", {}).get(field) != UNITS[field]:
                raise ValueError(f"Unexpected forecast units: {field}")
            for value in data[field]:
                numeric(value, field, None if field.startswith("temperature") else 0)
    payload, origin = cached_json("https://single-runs-api.open-meteo.com/v1/forecast",
                                  params, cache, validate, 1)
    print(json.dumps({"run": params["run"], "origin": origin, "response": payload}, indent=2))


if __name__ == "__main__":
    main()
