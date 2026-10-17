import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.grid import geometry_bounds
from app.services.locations import LocationStore

DATA = Path(__file__).resolve().parents[3] / "frontend/public/data"


@pytest.fixture
def locations():
    return LocationStore(DATA)


@pytest.fixture
def geo_client(tmp_path):
    app = create_app(Settings(_env_file=None, repo_root=tmp_path, locations_data_dir=DATA))
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize(
    "query,expected",
    [
        ("Stockton", "place-ca-stockton"),
        ("sAcRaMeNtO, California", "place-ca-sacramento"),
        ("san die", "place-ca-san-diego"),
        ("San Joaquin County", "county-ca-san-joaquin"),
        ("sacramento co.", "county-ca-sacramento"),
        ("95202", "zip-95202"),
        ("95814", "zip-95814"),
        ("Fresno", "place-ca-fresno"),
    ],
)
def test_search(geo_client, query, expected):
    response = geo_client.get("/api/v1/locations/search", params={"q": query})
    assert response.status_code == 200
    first = response.json()["results"][0]
    assert first["id"] == expected
    assert first["state"] == "CA" and first["boundary_available"]
    assert first["center"] == [first["longitude"], first["latitude"]]
    assert "census.gov" in first["dataset_url"]
    assert first["dataset_version"] == ("2020" if first["type"] == "zip" else "2023")


def test_ambiguity_and_stable_ids(locations):
    matches = locations.search("Mountain View", 25).results
    assert {r.county for r in matches} >= {"Santa Clara", "Contra Costa"}
    assert len(locations.records) == 3478
    assert locations.search("Stockton", 10) == locations.search("Stockton", 10)
    matches = locations.search("Spring Valley", 25).results
    ids = {r.id for r in matches}
    assert "place-ca-spring-valley-lake-county-lake" in ids
    assert "place-ca-spring-valley-lake-county-san-bernardino" in ids


@pytest.mark.parametrize("query", ["Reno, NV", "Stockton, Texas", "89501", "00000", "zzzzzzzzzz"])
def test_outside_and_unknown(geo_client, query):
    assert geo_client.get("/api/v1/locations/search", params={"q": query}).json()["results"] == []


@pytest.mark.parametrize(
    "params",
    [
        {"q": "a"},
        {"q": "  "},
        {"q": "!!!"},
        {"q": "a" * 121},
        {"q": "Stockton", "limit": 26},
        {"q": "Stockton", "limit": 0},
    ],
)
def test_validation(geo_client, params):
    assert geo_client.get("/api/v1/locations/search", params=params).status_code == 422


def test_bounded_and_legacy_alias(geo_client):
    result = geo_client.get("/api/v1/locations/search?q=san&limit=2").json()
    assert len(result["results"]) == 2 and result["truncated"] and result["total"] > 2
    assert geo_client.get("/api/v1/places/search?q=Stockton").json() == (
        geo_client.get("/api/v1/locations/search?q=Stockton").json()
    )


@pytest.mark.parametrize(
    "key",
    [
        "place-ca-stockton",
        "place-ca-sacramento",
        "zip-95202",
        "county-ca-san-joaquin",
        "place-ca-spring-valley-lake-county-lake",
        "place-ca-spring-valley-lake-county-san-bernardino",
    ],
)
def test_real_boundary(geo_client, key):
    response = geo_client.get(f"/api/v1/locations/{key}/boundary")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == key and body["geometry"]["type"] in ("Polygon", "MultiPolygon")
    assert geometry_bounds(body["geometry"])[0] < -114
    assert body["metadata"]["crs"] == "EPSG:4326"
    assert body["metadata"]["display_only"]
    assert body["metadata"]["approximate"] == key.startswith("zip-")


def test_boundary_cache_and_preserved_geometry(locations, monkeypatch):
    first = locations.boundary("place-ca-stockton")
    original = json.loads((DATA / "boundaries/places/san-joaquin.geojson").read_text())["features"]
    assert first["geometry"] == next(f["geometry"] for f in original if f["id"] == first["id"])
    monkeypatch.setattr(
        "app.services.locations.read_json", lambda *a, **k: pytest.fail("cache miss")
    )
    assert locations.boundary(first["id"]) is first


def test_missing_and_blocked_grid(geo_client, client):
    assert geo_client.get("/api/v1/locations/not-real/boundary").status_code == 404
    assert (
        geo_client.get("/api/v1/locations/place-ca-stockton/cells").json()["error"]["code"]
        == "ml_grid_mapping_unavailable"
    )
    assert client.get("/api/v1/locations/search?q=Stockton").status_code == 503


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Polygon", "coordinates": [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[-121, 38], [-120, 38], [-121, 39]]]},
        {"type": "Polygon", "coordinates": [[[500000, 4200000]] * 4]},
    ],
)
def test_malformed_boundary_is_not_replaced_with_circle(tmp_path, geometry):
    # Explicit synthetic geometry is solely an error-path fixture.
    root = tmp_path
    raw = json.loads((DATA / "places.json").read_text())
    raw["results"] = [next(r for r in raw["results"] if r["id"] == "county-ca-san-joaquin")]
    (root / "places.json").write_text(json.dumps(raw))
    (root / "ca-counties.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "id": "county-ca-san-joaquin", "geometry": geometry},
                ],
            }
        )
    )
    from app.errors import APIError

    with pytest.raises(APIError) as error:
        LocationStore(root).boundary("county-ca-san-joaquin")
    assert error.value.code == "boundary_invalid"
