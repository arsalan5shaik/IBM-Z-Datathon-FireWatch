#!/usr/bin/env python3
"""Optional workstation GIS preprocessing. No network calls of any kind.

Default: Fresno pilot; --scope california builds the statewide geometry only.
Install dependencies from requirements-gis.txt in a local environment, not LinuxONE.
"""
import argparse
import csv
import hashlib
import io
import json
import math
import platform
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = (0, 0)
CRS = "EPSG:3310"
ANCHOR_SIZE = 10000


def require_gis():
    global shapefile, pyproj, shapely, box, shape, mapping, Point, transform, unary_union, orient
    try:
        import shapefile
        import pyproj
        import shapely
        from shapely.geometry import box, shape, mapping, Point
        from shapely.geometry.polygon import orient
        from shapely.ops import unary_union
        def transform(function, geometry):
            return shapely.transform(geometry, function, interleaved=False)
    except ImportError as exc:
        raise SystemExit("Optional GIS dependencies missing. Use the workstation environment described in docs/GRID_PILOT.md; LinuxONE CSV consumers need none.") from exc


def grid_version(size):
    return f"ca_{size // 1000}km_3310_v1"


def cell_id(column, row, size=3000):
    return f"{grid_version(size)}_c{column}_r{row}"


def point_cell_id(x, y, size=3000):
    """Half-open squares: west/south inclusive, east/north exclusive."""
    return cell_id(math.floor((x - ORIGIN[0]) / size), math.floor((y - ORIGIN[1]) / size), size)


def load_boundary(path, predicate):
    """Read a zipped shapefile in memory, preserving and using its actual .prj."""
    with ZipFile(path) as archive:
        shp_files = [n for n in archive.namelist() if n.lower().endswith(".shp")]
        if len(shp_files) != 1:
            raise ValueError(f"Expected one shapefile in {path}")
        stem = shp_files[0][:-4]
        names = {n.lower(): n for n in archive.namelist()}
        def component(extension):
            return archive.read(names[(stem + extension).lower()])
        source_crs = pyproj.CRS.from_wkt(component(".prj").decode("utf-8-sig"))
        converter = pyproj.Transformer.from_crs(source_crs, CRS, always_xy=True)
        reader = shapefile.Reader(shp=io.BytesIO(component(".shp")),
                                  shx=io.BytesIO(component(".shx")),
                                  dbf=io.BytesIO(component(".dbf")))
        selected, attributes = [], []
        for record in reader.iterShapeRecords():
            properties = record.record.as_dict()
            if predicate(properties):
                geom = shape(record.shape.__geo_interface__)
                if not geom.is_valid:
                    raise ValueError(f"Invalid source boundary in {path}; review rather than silently repairing")
                selected.append(transform(converter.transform, geom))
                attributes.append(properties)
        if not selected:
            raise ValueError(f"No matching boundary in {path}")
        merged = unary_union(selected)
        if not merged.is_valid or merged.is_empty or merged.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError(f"Invalid projected boundary: {path}")
        return merged, {"source_crs_wkt": source_crs.to_wkt(), "selected_attributes": attributes}


def polygonal(geometry):
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry
    return unary_union([g for g in geometry.geoms if g.geom_type in ("Polygon", "MultiPolygon")])


def geographic(geometry, to_wgs84):
    # Densify straight projected square edges before conversion to geographic lines.
    geom = transform(to_wgs84.transform, geometry.segmentize(500))
    if geom.geom_type == "Polygon":
        geom = orient(geom, sign=1.0)
    else:
        from shapely.geometry import MultiPolygon
        geom = MultiPolygon([orient(g, sign=1.0) for g in geom.geoms])
    return mapping(geom)


def nearest_anchor(x, y, to_wgs84):
    """Nearest 10 km lattice center; ties use lowest column, then row."""
    column, row = math.floor(x / ANCHOR_SIZE), math.floor(y / ANCHOR_SIZE)
    candidates = []
    for c in range(column - 1, column + 2):
        for r in range(row - 1, row + 2):
            ax, ay = (c + 0.5) * ANCHOR_SIZE, (r + 0.5) * ANCHOR_SIZE
            candidates.append(((ax - x) ** 2 + (ay - y) ** 2, c, r, ax, ay))
    squared, c, r, ax, ay = min(candidates)
    longitude, latitude = to_wgs84.transform(ax, ay)
    aid = f"ca_w10km_3310_v1_c{c}_r{r}"
    return {"weather_anchor_id": aid, "cell_id": aid, "latitude": latitude,
            "longitude": longitude, "x_m": ax, "y_m": ay}, math.sqrt(squared)


def generate(state, region, size=3000):
    """Select by county, but always clip and sample against the STATE boundary."""
    if size not in (3000, 5000):
        raise ValueError("Supported grid sizes are 3000 and 5000 meters")
    to_wgs84 = pyproj.Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    shapely.prepare(state)
    shapely.prepare(region)
    minx, miny, maxx, maxy = region.bounds
    for row in range(math.floor(miny / size), math.ceil(maxy / size)):
        for column in range(math.floor(minx / size), math.ceil(maxx / size)):
            x, y = column * size, row * size
            square = box(x, y, x + size, y + size)
            selected = square if region.covers(square) else square.intersection(region)
            if selected.area <= 0:
                continue
            clipped = square if state.covers(square) else polygonal(square.intersection(state))
            if clipped.area <= 0:
                continue
            sample = clipped.centroid
            method = "state_clipped_centroid"
            if not clipped.contains(sample):
                sample = clipped.representative_point()
                method = "state_clipped_interior_point"
            longitude, latitude = to_wgs84.transform(sample.x, sample.y)
            anchor, distance = nearest_anchor(sample.x, sample.y, to_wgs84)
            record = {
                "grid_version": grid_version(size), "cell_id": cell_id(column, row, size),
                "grid_km": size // 1000, "column": column, "row": row,
                "latitude": latitude, "longitude": longitude,
                "x_m": sample.x, "y_m": sample.y, "sample_method": method,
                "square_min_x_m": x, "square_min_y_m": y,
                "square_max_x_m": x + size, "square_max_y_m": y + size,
                "square_center_x_m": x + size / 2, "square_center_y_m": y + size / 2,
                "full_square_area_m2": size * size, "cell_area_km2": clipped.area / 1e6,
                "boundary_coverage_fraction": min(1.0, clipped.area / (size * size)),
                "selection_coverage_fraction": min(1.0, selected.area / (size * size)),
                "land_coverage_fraction": None,
                "weather_anchor_id": anchor["weather_anchor_id"], "weather_anchor_distance_m": distance,
                "geometry_wgs84": json.dumps(geographic(clipped, to_wgs84), separators=(",", ":")),
            }
            yield record, anchor


def write_csv(path, rows):
    if not rows:
        raise ValueError(f"No rows for {path}")
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def validate_records(records, state, region, size):
    """Check actual outputs before writing; raises on any broken spatial contract."""
    if not records or len({r["cell_id"] for r in records}) != len(records):
        raise ValueError("Grid is empty or contains duplicate IDs")
    back = pyproj.Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    total_region_area = 0.0
    for r in records:
        x, y = r["square_min_x_m"], r["square_min_y_m"]
        if r["square_max_x_m"] - x != size or r["square_max_y_m"] - y != size:
            raise ValueError("Incorrect square dimensions")
        square = box(x, y, x + size, y + size)
        clip = square if state.covers(square) else square.intersection(state)
        overlap = clip.area if region.covers(square) else clip.intersection(region).area
        total_region_area += overlap
        if overlap <= 0 or not clip.is_valid:
            raise ValueError("Cell does not intersect selected California region")
        if not 0 < r["boundary_coverage_fraction"] <= 1:
            raise ValueError("Invalid coverage fraction")
        if not (-180 <= r["longitude"] <= 180 and -90 <= r["latitude"] <= 90):
            raise ValueError("Invalid geographic coordinate")
        if not clip.covers(Point(r["x_m"], r["y_m"])):
            raise ValueError("Sample point lies outside clipped cell")
        if not shape(json.loads(r["geometry_wgs84"])).is_valid:
            raise ValueError("Invalid geographic geometry")
        px, py = back.transform(r["longitude"], r["latitude"])
        if math.hypot(px - r["x_m"], py - r["y_m"]) > 0.01:
            raise ValueError("Coordinate transformation round trip exceeds 1 cm")
        if r["cell_id"] != point_cell_id(r["square_center_x_m"], r["square_center_y_m"], size):
            raise ValueError("Unstable lattice ID")
    if abs(total_region_area - region.intersection(state).area) > max(1, region.area * 1e-9):
        raise ValueError("Selected grid does not cover the region exactly once")


def build(raw, out, scope, size):
    manifest = json.loads((raw / "manifest.json").read_text(encoding="utf-8"))
    locked = json.loads((ROOT / "docs/BOUNDARY_SOURCES.json").read_text(encoding="utf-8"))
    for name in ("state", "counties"):
        entry = manifest["resources"][name]
        if hashlib.sha256((raw / entry["file"]).read_bytes()).hexdigest() != entry["sha256"] or entry["sha256"] != locked["resources"][name]["sha256"]:
            raise ValueError(f"Boundary checksum mismatch: {name}")
    state, state_meta = load_boundary(raw / manifest["resources"]["state"]["file"],
                                     lambda p: str(p.get("STATEFP", "")) == "06")
    fresno, county_meta = load_boundary(raw / manifest["resources"]["counties"]["file"],
                                       lambda p: str(p.get("GEOID", "")) == "06019")
    region = state if scope == "california" else state.intersection(fresno)
    pairs = list(generate(state, region, size))
    records = [p[0] for p in pairs]
    validate_records(records, state, region, size)
    anchors = {a["weather_anchor_id"]: a for _, a in pairs}
    anchor_rows = sorted(anchors.values(), key=lambda a: a["weather_anchor_id"])
    out.mkdir(parents=True, exist_ok=True)
    prefix = f"california_grid_{size // 1000}km" if scope == "california" else "fresno_grid_pilot" + ("" if size == 3000 else "_5km")
    write_csv(out / f"{prefix}.csv", records)
    features = [{"type": "Feature", "id": r["cell_id"],
                 "properties": {k: v for k, v in r.items() if k != "geometry_wgs84"},
                 "geometry": json.loads(r["geometry_wgs84"])} for r in records]
    (out / f"{prefix}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")), encoding="utf-8")
    write_csv(out / f"{prefix}_weather_anchors.csv", anchor_rows)
    write_csv(out / f"{prefix}_cell_weather_mapping.csv", [
        {"grid_version": r["grid_version"], "cell_id": r["cell_id"],
         "weather_anchor_id": r["weather_anchor_id"], "distance_km": r["weather_anchor_distance_m"] / 1000}
        for r in records])
    # Verify CSV compatibility using the existing standard-library reader. No requests.
    from fetch_weather_elevation import read_cells
    if len(read_cells(out / f"{prefix}.csv", None)) != len(records):
        raise ValueError("Pipeline CSV round-trip failed")
    read_cells(out / f"{prefix}_weather_anchors.csv", None)
    metadata = {
        "scope": scope, "grid_version": grid_version(size), "projected_crs": CRS,
        "geographic_crs": "EPSG:4326", "geojson_axis_order": "longitude,latitude",
        "origin_m": list(ORIGIN), "square_size_m": size,
        "id_convention": "ca_{size_km}km_3310_v1_c{signed_column}_r{signed_row}",
        "point_assignment": "floor(x/size),floor(y/size); west/south inclusive, east/north exclusive",
        "geometry_policy": "select positive-area region intersections; clip geometry to STATE, not county; no geometry simplification",
        "sample_policy": "state-clipped centroid if interior, else point-on-surface; identical across scopes",
        "boundary_source": manifest, "state_details": state_meta, "county_details": county_meta,
        "coverage_policy": "boundary_coverage_fraction is state polygon area/full square area; administrative boundary includes water",
        "land_coverage_fraction": "null: no spatial land/water mask supplied; ALAND totals cannot locate water within cells",
        "elevation": "not fetched; no numeric elevation values invented",
        "weather_anchor_policy": "10,000 m lattice centers at (column+0.5,row+0.5)*10000; Euclidean EPSG:3310 distance from sample; ties lowest column then row; anchors may lie outside California",
        "weather_resolution_note": "Anchor spacing is sampling density, not model resolution; no weather fetched",
        "rows": len(records), "partial_state_cells": sum(r["boundary_coverage_fraction"] < 1 - 1e-10 for r in records),
        "partial_selection_cells": sum(r["selection_coverage_fraction"] < 1 - 1e-10 for r in records),
        "weather_anchors": len(anchors), "region_area_km2": region.area / 1e6,
        "max_anchor_distance_m": max(r["weather_anchor_distance_m"] for r in records),
        "planned_requests_before_retries": {"weather_2024_2025_one_anchor_year_per_request": 2 * len(anchors),
                                             "elevation_100_points_per_batch": math.ceil(len(records) / 100),
                                             "elevation_points": len(records)},
        "validation": "unique IDs, square dimensions, positive California/region overlap, full region coverage, valid geometry, interior samples, coordinate round trips, existing CSV reader",
        "runtime": {"python": platform.python_version(), "shapely": shapely.__version__,
                    "pyproj": pyproj.__version__, "proj": pyproj.proj_version_str, "pyshp": shapefile.__version__},
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    metadata_path = out / f"{prefix}.metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: metadata[k] for k in ("scope", "rows", "partial_state_cells", "weather_anchors", "region_area_km2", "max_anchor_distance_m", "planned_requests_before_retries")}, indent=2))
    print(f"Validated outputs: {out.resolve()}")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundaries", type=Path, default=ROOT / "data/raw/ca_boundaries")
    parser.add_argument("--out", type=Path, default=ROOT / "data/processed")
    parser.add_argument("--scope", choices=("fresno", "california"), default="fresno")
    parser.add_argument("--size-m", type=int, choices=(3000, 5000), default=3000)
    args = parser.parse_args()
    require_gis()
    build(args.boundaries, args.out, args.scope, args.size_m)


if __name__ == "__main__":
    main()
