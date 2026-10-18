"""Offline geometry-based crosswalk. Never derives geography from numeric IDs."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def grid_features(path):
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    if document.get("type") != "FeatureCollection":
        raise ValueError("Grid must be a GeoJSON FeatureCollection")
    crs = document.get("crs", {}).get("properties", {}).get("name", "EPSG:4326")
    if crs not in ("EPSG:4326", "urn:ogc:def:crs:OGC:1.3:CRS84", "urn:ogc:def:crs:EPSG::4326"):
        raise ValueError("Expected WGS84 longitude/latitude GeoJSON")
    result = {}
    for feature in document["features"]:
        props = feature["properties"]
        key = str(props.get("cell_id", props.get("id", feature.get("id", ""))))
        if not key or key in result:
            raise ValueError("Missing/duplicate grid cell ID")
        geometry = feature["geometry"]
        if geometry["type"] not in ("Polygon", "MultiPolygon"):
            raise ValueError("Grid cells must be polygons")
        result[key] = geometry
    if not result:
        raise ValueError("Empty grid")
    return result


def ring_key(ring):
    points = [tuple(p) for p in ring]
    if len(points) < 4 or points[0] != points[-1]:
        raise ValueError("Invalid polygon ring")
    if any(len(p) != 2 or not all(math.isfinite(v) for v in p)
           or not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90) for p in points):
        raise ValueError("Invalid WGS84 coordinates")
    points.pop()
    def rotate(seq):
        i = min(range(len(seq)), key=seq.__getitem__)
        return tuple(seq[i:] + seq[:i])
    return min(rotate(points), rotate(list(reversed(points))))


def geometry_key(g):
    """Exact coordinates, independent of ring orientation/start and part order.

    No rounding or nearest-center matching: differing representations require
    the metric geometry comparison mode, not a guessed correspondence.
    """
    parts = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    return tuple(sorted((ring_key(p[0]), tuple(sorted(ring_key(r) for r in p[1:]))) for p in parts))


def build_crosswalk(numeric_path, authoritative_path, output, metric=False):
    numeric, authoritative = grid_features(numeric_path), grid_features(authoritative_path)
    if any(not k.isdigit() for k in numeric):
        raise ValueError("Numeric grid must have integer IDs")
    import re
    if any(not re.fullmatch(r"ca_3km_3310_v1_c-?\d+_r-?\d+", k) for k in authoritative):
        raise ValueError("Expected authoritative ca_3km_3310_v1 IDs")
    pairs = []
    if metric:
        # GIS only on a workstation that already has these packages. Training
        # consumes the exported crosswalk and requires no native GIS runtime.
        from shapely.geometry import shape
        from shapely.ops import transform
        from shapely.strtree import STRtree
        from pyproj import Transformer
        project = Transformer.from_crs(4326, 3310, always_xy=True).transform
        keys = list(authoritative)
        geoms = [transform(project, shape(authoritative[k])) for k in keys]
        if any(not g.is_valid or g.area <= 0 for g in geoms):
            raise ValueError("Invalid authoritative polygon")
        tree = STRtree(geoms)
        for key, geometry in numeric.items():
            g = transform(project, shape(geometry))
            if not g.is_valid or g.area <= 0:
                raise ValueError(f"Invalid numeric polygon {key}")
            matches = []
            for idx in tree.query(g.buffer(0.1)):
                other = geoms[int(idx)]
                difference = g.symmetric_difference(other).area / max(g.area, other.area)
                distance = g.hausdorff_distance(other)
                if difference <= 1e-6 and distance <= 0.1:
                    matches.append((keys[int(idx)], difference, distance))
            if len(matches) != 1:
                raise ValueError(f"Cell {key}: {len(matches)} equivalent boundaries; refusing crosswalk")
            pairs.append((key, *matches[0]))
    else:
        index = {}
        for key, g in authoritative.items():
            signature = geometry_key(g)
            if signature in index:
                raise ValueError("Duplicate authoritative geometry")
            index[signature] = key
        for key, g in numeric.items():
            match = index.get(geometry_key(g))
            if match is None:
                raise ValueError(f"Cell {key}: no exact boundary match. Supply correct grid or use --metric with existing GIS packages.")
            pairs.append((key, match, 0.0, 0.0))
    if len({r[1] for r in pairs}) != len(pairs) or len(pairs) != len(authoritative):
        raise ValueError("Crosswalk is not a complete one-to-one statewide equivalence")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["numeric_cell_id", "cell_id", "grid_version", "symmetric_difference_fraction", "hausdorff_m"])
        writer.writerows((n, a, "ca_3km_3310_v1", diff, dist) for n, a, diff, dist in pairs)
    manifest = {"numeric_grid_sha256": digest(numeric_path), "authoritative_grid_sha256": digest(authoritative_path),
                "crosswalk_sha256": digest(output), "count": len(pairs),
                "method": "EPSG3310_boundary_equivalence" if metric else "exact_WGS84_boundaries",
                "max_symmetric_difference_fraction": max(r[2] for r in pairs),
                "max_hausdorff_m": max(r[3] for r in pairs)}
    output.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--numeric-grid", required=True)
    parser.add_argument("--authoritative-grid", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--metric", action="store_true", help="Use existing Shapely 2 / pyproj; 0.1 m boundary and 1e-6 area tolerance")
    args = parser.parse_args()
    print(json.dumps(build_crosswalk(args.numeric_grid, args.authoritative_grid, args.output, args.metric), indent=2))


if __name__ == "__main__":
    main()
