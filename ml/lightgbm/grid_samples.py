"""Verify existing polygon lattice and derive samples; never generate a grid."""
import math
from spatial import grid_features

# EPSG:3310 GRS80 California Albers, as defined by the owner's grid contract.
A = 6378137.0
E2 = 2 / 298.257222101 - (1 / 298.257222101)**2
E = math.sqrt(E2)


def q(phi):
    s = math.sin(phi)
    return (1-E2) * (s/(1-E2*s*s) - math.log((1-E*s)/(1+E*s))/(2*E))


def m(phi):
    return math.cos(phi)/math.sqrt(1-E2*math.sin(phi)**2)


P1, P2 = math.radians(34), math.radians(40.5)
N = (m(P1)**2-m(P2)**2)/(q(P2)-q(P1))
C = m(P1)**2 + N*q(P1)
R0 = A*math.sqrt(C)/N


def project(lon, lat):
    rho = A*math.sqrt(C-N*q(math.radians(lat)))/N
    theta = N*math.radians(lon+120)
    return rho*math.sin(theta), R0-rho*math.cos(theta)-4000000


def unproject(x, y):
    y = R0-(y+4000000)
    rho = math.hypot(x, y)
    wanted = (C-(rho*N/A)**2)/N
    lo, hi = -math.pi/2, math.pi/2
    for _ in range(48):
        mid = (lo+hi)/2
        if q(mid) < wanted:
            lo = mid
        else:
            hi = mid
    return -120+math.degrees(math.atan2(x, y)/N), math.degrees((lo+hi)/2)


def inside(point, ring):
    x, y = point
    result = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            result = not result
    return result


def sample_polygons(path):
    """Infer lattice from ALL projected boundaries, not from row order/IDs.

    Full-square center sampling intentionally includes coastal centers outside
    state-clipped cells. This matches the documented ERC pilot support; export
    flags distinguish it from within-polygon samples or area-mean labels.
    """
    result, used = [], set()
    for cell_id, g in grid_features(path).items():
        polygons = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        points = [project(*p) for poly in polygons for ring in poly for p in ring]
        x0, x1 = min(p[0] for p in points), max(p[0] for p in points)
        y0, y1 = min(p[1] for p in points), max(p[1] for p in points)
        ix, iy = math.floor((x0+x1)/6000), math.floor((y0+y1)/6000)
        if (ix, iy) in used:
            raise ValueError(f"Duplicate polygon lattice index {ix,iy}")
        if x0 < ix*3000-0.3 or x1 > (ix+1)*3000+0.3 or y0 < iy*3000-0.3 or y1 > (iy+1)*3000+0.3:
            raise ValueError(f"Cell {cell_id} boundaries do not fit one declared EPSG3310 square")
        used.add((ix, iy))
        lon, lat = unproject((ix+0.5)*3000, (iy+0.5)*3000)
        within = any(inside((lon,lat), poly[0]) and not any(inside((lon,lat), r) for r in poly[1:]) for poly in polygons)
        result.append({"cell_id": cell_id, "ix": ix, "iy": iy, "sample_lat": lat, "sample_lon": lon,
                       "sample_inside_clipped_polygon": within})
    return result
