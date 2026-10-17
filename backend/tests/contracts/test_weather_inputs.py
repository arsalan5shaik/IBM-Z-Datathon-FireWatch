import asyncio
from datetime import timedelta

import pytest

from app.config import Settings
from app.errors import APIError
from app.services.grid import Grid
from app.services.jsonio import read_json
from app.services.time import iso
from app.services.weather_cache import WeatherCache, sample_point
from app.services.weather_inputs import ProposedWeatherInputs, WeatherSampling, prepare_inputs
from tests.conftest_forecasts import EXAMPLES
from tests.unit.test_weather_cache import MockProvider
from tests.unit.test_weather_provider import NOW


def setup(tmp_path):
    settings = Settings(_env_file=None, repo_root=tmp_path)
    grid = Grid(read_json(EXAMPLES / "grid.mock.geojson"))
    mapping = WeatherSampling(
        schema_version="proposed-weather-1",
        data_mode="fixture",
        grid_version=grid.version,
        points=[sample_point(36.5, -120)],
        cell_to_anchor={cell: sample_point(36.5, -120).anchor_id for cell in grid.cells},
    )
    provider = MockProvider()
    cache = WeatherCache(provider, settings, lambda: NOW)
    return settings, grid, mapping, provider, cache


def test_proposed_inputs_168_hours_and_stable_partitions(tmp_path):
    settings, grid, mapping, _, cache = setup(tmp_path)

    async def run():
        first = await prepare_inputs(cache, mapping, grid, NOW + timedelta(hours=1))
        second = await prepare_inputs(cache, mapping, grid, NOW + timedelta(hours=2))
        assert len(first.partitions) == 168
        for hour in first.partitions.keys() & second.partitions.keys():
            assert first.partitions[hour].revision == second.partitions[hour].revision

    # Second requested window lacks the final hour: no extrapolation is allowed.
    with pytest.raises(APIError, match="Requested forecast hour"):
        asyncio.run(run())
    assert not (settings.shared_data_dir / "predictions").exists()


def test_overlap_revisions_ignore_fetch_timestamp_and_window_shift(tmp_path):
    _, grid, mapping, provider, cache = setup(tmp_path)
    from tests.unit.test_weather_provider import response

    provider.data = response(170)

    async def run():
        first = await prepare_inputs(cache, mapping, grid, NOW + timedelta(hours=1))
        second = await prepare_inputs(cache, mapping, grid, NOW + timedelta(hours=2))
        assert first.model_contract_status == "unconfirmed"
        assert all(
            first.partitions[h].revision == second.partitions[h].revision
            for h in first.partitions.keys() & second.partitions.keys()
        )
        assert iso(NOW + timedelta(hours=1)) in first.partitions

    asyncio.run(run())


def test_mapping_and_missing_inputs_fail_closed(tmp_path):
    _, grid, mapping, provider, cache = setup(tmp_path)
    provider.data["hourly"]["temperature_2m"][10] = None
    with pytest.raises(APIError):
        asyncio.run(prepare_inputs(cache, mapping, grid, NOW + timedelta(hours=1)))
    bad = mapping.model_copy(update={"grid_version": "wrong"})
    with pytest.raises(APIError, match="authoritative grid"):
        asyncio.run(prepare_inputs(cache, bad, grid, NOW + timedelta(hours=1)))


def test_proposed_exported_schemas_match():
    for name, model in (
        ("weather-inputs.proposed", ProposedWeatherInputs),
        ("weather-sampling.proposed", WeatherSampling),
    ):
        document = read_json(EXAMPLES.parent / "schemas" / f"{name}.schema.json")
        document.pop("$schema")
        assert document == model.model_json_schema()
