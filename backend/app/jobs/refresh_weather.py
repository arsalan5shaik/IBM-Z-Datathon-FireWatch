"""Export the proposed weather input packet without invoking inference/publication."""

import argparse
import asyncio
from pathlib import Path

import httpx

from app.config import Settings
from app.persistence.atomic import atomic_json, single_owner
from app.services.grid import Grid
from app.services.jsonio import read_json
from app.services.time import next_hour
from app.services.weather_cache import WeatherCache
from app.services.weather_inputs import WeatherSampling, prepare_inputs
from app.services.weather_provider import OpenMeteoProvider


async def export(settings, mapping_path):
    from datetime import UTC, datetime

    mapping = WeatherSampling.model_validate(read_json(mapping_path))
    if mapping.data_mode == "fixture" and not settings.allow_fixture_data:
        raise ValueError("Fixture mode not enabled")
    boundary_path = settings.shared_data_dir / "california.geojson"
    boundary = read_json(boundary_path)["geometry"] if boundary_path.exists() else None
    grid = Grid(read_json(settings.shared_data_dir / "grid.geojson"), boundary)
    target = settings.shared_data_dir / "weather-inputs/proposed.json"
    with single_owner(target.parent / ".weather-inputs.lock"):
        async with httpx.AsyncClient(follow_redirects=False) as client:
            cache = WeatherCache(OpenMeteoProvider(client, settings), settings)
            packet = await prepare_inputs(cache, mapping, grid, next_hour(datetime.now(UTC)))
            atomic_json(target, packet.model_dump(mode="json"))
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mapping", type=Path, required=True)
    args = parser.parse_args()
    try:
        asyncio.run(export(Settings(), args.mapping))
        print('{"job":"weather_inputs","outcome":"success","model_contract":"unconfirmed"}')
    except Exception:
        print('{"job":"weather_inputs","outcome":"failed","error":"weather_inputs_unavailable"}')
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
