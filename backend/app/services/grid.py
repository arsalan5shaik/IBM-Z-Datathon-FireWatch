"""Pure Python polygon validation and bucket index; grid generation belongs to ML.

No native geospatial runtime is assumed. Grid source CRS/resolution must be
declared; an authoritative California boundary is required in live mode.
"""

import math
from collections import defaultdict

CA_BBOX = (-124.6, 32.4, -114.0, 42.1)


def bbox(value: str, max_area: float = 110) -> tuple[float, float, float, float]:
    numbers = tuple(float(part) for part in value.split(","))
    if len(numbers) != 4 or not all(math.isfinite(n) for n in numbers):
        raise ValueError("Four finite bbox coordinates required")
    west, south, east, north = numbers
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("Invalid WGS84 bbox")
    if (east - west) * (north - south) > max_area:
        raise ValueError("Bounding box too large")
    return numbers


def intersects(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_segment(p, a, b):
    return abs(cross(a, b, p)) < 1e-12 and (
        min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])
    )


def segments_intersect(a, b, c, d):
    if any((on_segment(p, x, y)) for p, x, y in ((a, c, d), (b, c, d), (c, a, b), (d, a, b))):
        return True
    return (cross(a, b, c) > 0) != (cross(a, b, d) > 0) and (
        (cross(c, d, a) > 0) != (cross(c, d, b) > 0)
    )


def point_in_ring(point, ring):
    inside = False
    for a, b in zip(ring, ring[1:], strict=False):
        if on_segment(point, a, b):
            return True
        if (a[1] > point[1]) != (b[1] > point[1]):
            x = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if point[0] < x:
                inside = not inside
    return inside


def polygons(geometry):
    if geometry.get("type") == "Polygon":
        return [geometry["coordinates"]]
    if geometry.get("type") == "MultiPolygon":
        return geometry["coordinates"]
    raise ValueError("Polygon or MultiPolygon required")


def geometry_bounds(geometry, validate=True):
    points = []
    parts = polygons(geometry)
    if not parts:
        raise ValueError("Empty geometry")
    for polygon in parts:
        if not polygon:
            raise ValueError("Empty polygon")
        for ring in polygon:
            if len(ring) < 4 or ring[0] != ring[-1] or len(ring) > 10000:
                raise ValueError("Invalid closed ring")
            for point in ring:
                if len(point) != 2 or not all(
                    type(x) in (int, float) and math.isfinite(x) for x in point
                ):
                    raise ValueError("Invalid coordinate")
                if not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                    raise ValueError("Invalid WGS84 coordinate")
            if validate:
                if (
                    abs(
                        sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:], strict=False))
                    )
                    < 1e-12
                ):
                    raise ValueError("Zero-area ring")
                edges = list(zip(ring, ring[1:], strict=False))
                for i, (a, b) in enumerate(edges):
                    if a == b:
                        raise ValueError("Duplicate vertex")
                    for j in range(i + 2, len(edges)):
                        if i == 0 and j == len(edges) - 1:
                            continue
                        if segments_intersect(a, b, *edges[j]):
                            raise ValueError("Self-intersecting ring")
            points.extend(ring)
        for hole in polygon[1:]:
            if not all(point_in_ring(p, polygon[0]) for p in hole):
                raise ValueError("Hole outside exterior")
    return (
        min(p[0] for p in points),
        min(p[1] for p in points),
        max(p[0] for p in points),
        max(p[1] for p in points),
    )


def contains(geometry, point):
    return any(
        point_in_ring(point, p[0]) and not any(point_in_ring(point, h) for h in p[1:])
        for p in polygons(geometry)
    )


def geometry_intersects(a, b):
    if not intersects(geometry_bounds(a, False), geometry_bounds(b, False)):
        return False
    for pa in polygons(a):
        for pb in polygons(b):
            if contains(a, pb[0][0]) or contains(b, pa[0][0]):
                return True
            for ra in pa:
                for rb in pb:
                    if any(
                        segments_intersect(x, y, u, v)
                        for x, y in zip(ra, ra[1:], strict=False)
                        for u, v in zip(rb, rb[1:], strict=False)
                    ):
                        return True
    return False


def rectangle(bounds):
    w, s, e, n = bounds
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


class Grid:
    def __init__(self, document, boundary=None):
        metadata = document["metadata"]
        if document["type"] != "FeatureCollection" or metadata["grid_resolution_m"] != 3000:
            raise ValueError("3 km FeatureCollection required")
        if metadata["source_epsg"] != 3310 or metadata["data_mode"] not in {"fixture", "live"}:
            raise ValueError("Grid provenance required")
        self.version = metadata["grid_version"]
        self.mode = metadata["data_mode"]
        if self.mode == "live" and boundary is None:
            raise ValueError("Authoritative California boundary required")
        self.cells = {}
        self.index = defaultdict(set)
        if not 0 < len(document["features"]) <= 100000:
            raise ValueError("Invalid grid count")
        for feature in document["features"]:
            cell_id = feature["properties"]["cell_id"]
            geometry = feature["geometry"]
            bounds = geometry_bounds(geometry)
            if cell_id in self.cells or not isinstance(cell_id, str) or not cell_id:
                raise ValueError("Invalid/duplicate cell ID")
            if feature["properties"]["grid_version"] != self.version or not intersects(
                bounds, CA_BBOX
            ):
                raise ValueError("Grid version or California extent mismatch")
            if boundary and not geometry_intersects(geometry, boundary):
                raise ValueError("Cell does not intersect California")
            self.cells[cell_id] = geometry
            for key in self.buckets(bounds):
                self.index[key].add(cell_id)

    @staticmethod
    def buckets(bounds):
        w, s, e, n = bounds
        if (e - w) * (n - s) > 110:
            raise ValueError("Geometry extent too large")
        return (
            (x, y)
            for x in range(math.floor(w * 4), math.floor(e * 4) + 1)
            for y in range(math.floor(s * 4), math.floor(n * 4) + 1)
        )

    def query(self, bounds, limit):
        candidates = set()
        for key in self.buckets(bounds):
            candidates.update(self.index.get(key, ()))
        box = rectangle(bounds)
        result = []
        for cell_id in sorted(candidates):
            if geometry_intersects(self.cells[cell_id], box):
                result.append(cell_id)
                if len(result) > limit:
                    raise ValueError("Result exceeds cell limit; request a smaller bbox")
        return result
