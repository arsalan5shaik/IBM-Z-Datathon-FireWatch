"""Indexed, offline Census lookup; bounded lazy boundary cache, no geocoding calls.

Consumes the existing frontend geography instead of a second divergent dataset.
The supplied geometry is already projected/simplified by build-geodata.mjs and
is for display only, never precise area calculations or ML grid generation.
"""

import re
import unicodedata
from collections import OrderedDict, defaultdict
from pathlib import Path
from threading import RLock

from app.errors import APIError
from app.schemas.locations import Location, SearchResponse
from app.services.grid import geometry_bounds, polygons, segments_intersect
from app.services.jsonio import read_json

SOURCE = "https://www2.census.gov/geo/tiger"
URLS = {
    "county": f"{SOURCE}/GENZ2023/shp/cb_2023_us_county_500k.zip",
    "place": f"{SOURCE}/GENZ2023/shp/cb_2023_06_place_500k.zip",
    "zip": f"{SOURCE}/GENZ2020/shp/cb_2020_us_zcta520_500k.zip",
}


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value).split())


def grams(value: str, size: int) -> set[str]:
    return {value[i : i + size] for i in range(len(value) - size + 1)}


def display_bounds(geometry):
    """Validate WGS84 rings, using an x sweep to avoid quadratic statewide rings."""
    bounds = geometry_bounds(geometry, validate=False)
    for polygon in polygons(geometry):
        for ring in polygon:
            edges = list(zip(ring, ring[1:], strict=False))
            area = sum(a[0] * b[1] - b[0] * a[1] for a, b in edges)
            if abs(area) < 1e-12 or any(a == b for a, b in edges):
                raise ValueError("Degenerate ring")
            active = []
            ordered = sorted(enumerate(edges), key=lambda item: min(p[0] for p in item[1]))
            for i, (a, b) in ordered:
                left = min(a[0], b[0])
                active = [(j, c, d) for j, c, d in active if max(c[0], d[0]) >= left]
                for j, c, d in active:
                    if abs(i - j) in (1, len(edges) - 1):
                        continue
                    if max(a[1], b[1]) < min(c[1], d[1]) or min(a[1], b[1]) > max(c[1], d[1]):
                        continue
                    if segments_intersect(a, b, c, d):
                        raise ValueError("Self-intersecting ring")
                active.append((i, a, b))
    return bounds


class LocationStore:
    def __init__(self, root: Path):
        self.root = root
        self.records: dict[str, Location] = {}
        self.names: dict[str, str] = {}
        self.index: dict[str, set[str]] = defaultdict(set)
        self.shards: OrderedDict[Path, dict] = OrderedDict()
        self.boundaries: OrderedDict[str, dict] = OrderedDict()
        self.lock = RLock()
        self.loaded = False

    def shard(self, record) -> Path | None:
        if record["type"] == "county":
            return self.root / "ca-counties.geojson"
        if record["type"] == "zip":
            return self.root / "boundaries" / "zcta" / f"{record['name'][:3]}.geojson"
        county = normalize(record.get("county") or "").replace(" ", "-")
        return self.root / "boundaries" / "places" / f"{county}.geojson" if county else None

    def load(self):
        with self.lock:
            if self.loaded:
                return
            try:
                raw = read_json(self.root / "places.json", max_bytes=2_000_000)
                records, names, index = {}, {}, defaultdict(set)
                for row in raw["results"]:
                    kind = row["type"]
                    path = self.shard(row)
                    lon, lat = row["center"]
                    label = f"{row['name']} ZCTA" if kind == "zip" else row["name"]
                    context = row.get("county")
                    display = f"{label}, {context} County, California" if context else label
                    record = Location.model_validate(
                        row
                        | {
                            "display_name": display,
                            "longitude": lon,
                            "latitude": lat,
                            "boundary_available": path is not None and path.is_file(),
                            "dataset_version": "2020" if kind == "zip" else "2023",
                            "dataset_url": URLS.get(kind, URLS["place"]),
                        }
                    )
                    if record.id in records:
                        raise ValueError("Duplicate location ID")
                    records[record.id] = record
                    name = normalize(record.name)
                    names[record.id] = name
                    for gram in grams(name, 2) | grams(name, 3):
                        index[gram].add(record.id)
                self.records, self.names, self.index = records, names, index
                self.loaded = True
            except (OSError, ValueError, KeyError, TypeError):
                raise APIError(
                    "locations_unavailable",
                    "Local California geographic catalog is invalid or missing",
                    503,
                ) from None

    def get(self, location_id: str) -> Location:
        self.load()
        try:
            return self.records[location_id]
        except KeyError:
            raise APIError("location_not_found", "Unknown California location", 404) from None

    def search(self, query: str, limit: int) -> SearchResponse:
        self.load()
        q = normalize(query)
        q = re.sub(r"(?: (?:ca|california|usa|us))+$", "", q).strip()
        county = bool(re.search(r"\b(?:county|co)$", q))
        if county:
            q = re.sub(r"\s*\b(?:county|co)$", "", q).strip()
        if len(q) < 2:
            raise APIError(
                "invalid_query", "Enter at least two letters or an exact five-digit ZIP", 422
            )
        if q.isdigit():
            record = self.records.get(f"zip-{q}") if len(q) == 5 else None
            results = [record] if record else []
        else:
            keys = grams(q, min(3, len(q)))
            candidates = set.intersection(*(self.index.get(key, set()) for key in keys))
            results = [
                self.records[key]
                for key in candidates
                if q in self.names[key] and (not county or self.records[key].type == "county")
            ]
            results.sort(
                key=lambda row: (
                    normalize(row.name).removesuffix(" county") != q,
                    not normalize(row.name).startswith(q),
                    row.type not in ("city", "town"),
                    -(row.population or 0),
                    row.name,
                    row.id,
                )
            )
        return SearchResponse(
            results=results[:limit], total=len(results), limit=limit, truncated=len(results) > limit
        )

    def boundary(self, location_id: str) -> dict:
        record = self.get(location_id)
        with self.lock:
            if location_id in self.boundaries:
                self.boundaries.move_to_end(location_id)
                return self.boundaries[location_id]
            path = self.shard(record.model_dump())
            if path is None or not path.is_file():
                raise APIError(
                    "boundary_unavailable", "No geographic boundary for this location", 404
                )
            try:
                if path not in self.shards:
                    raw = read_json(path, max_bytes=2_000_000)
                    if raw.get("type") != "FeatureCollection" or "crs" in raw:
                        raise ValueError("WGS84 FeatureCollection required")
                    features = {}
                    for feature in raw["features"]:
                        key = feature.get("id", feature.get("properties", {}).get("id"))
                        if key in features:
                            raise ValueError("Duplicate boundary ID")
                        features[key] = feature
                    self.shards[path] = features
                    if len(self.shards) > 32:
                        self.shards.popitem(last=False)
                self.shards.move_to_end(path)
                feature = self.shards[path].get(location_id)
                if feature is None:
                    raise APIError(
                        "boundary_unavailable", "Boundary is absent from its source shard", 404
                    )
                # Validate each selected geometry once, including rings, holes and intersections.
                bounds = display_bounds(feature["geometry"])
                if any(abs(a - b) > 0.002 for a, b in zip(bounds, record.bbox, strict=True)):
                    raise ValueError("Boundary does not match location bbox")
                result = {
                    "type": "Feature",
                    "id": location_id,
                    "geometry": feature["geometry"],
                    "properties": record.model_dump(mode="json"),
                    "metadata": {
                        "source": record.dataset_source,
                        "source_url": record.dataset_url,
                        "dataset_version": record.dataset_version,
                        "crs": "EPSG:4326",
                        "coordinate_order": "longitude,latitude",
                        "display_only": True,
                        "simplification_m": 250
                        if record.type == "county"
                        else 100
                        if record.type == "zip"
                        else 90,
                        "approximate": record.approximate,
                        "limitation": "ZCTAs approximate ZIP areas, not USPS delivery boundaries"
                        if record.type == "zip"
                        else "Cartographic display boundary; not survey geometry",
                    },
                }
                self.boundaries[location_id] = result
                if len(self.boundaries) > 128:
                    self.boundaries.popitem(last=False)
                return result
            except (OSError, ValueError, KeyError, TypeError):
                raise APIError(
                    "boundary_invalid", "Geographic boundary failed validation", 503
                ) from None
