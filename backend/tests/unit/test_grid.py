import pytest

from app.services.grid import geometry_bounds, geometry_intersects, rectangle


@pytest.mark.parametrize(
    "coordinates",
    [
        [],
        [[[0, 0], [1, 1], [0, 0]]],
        [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]],
        [[[0, 0], [1, 0], [1, 1], [0, 1]]],
        [[[0, 0], [181, 0], [181, 1], [0, 0]]],
    ],
)
def test_invalid_geometry(coordinates):
    with pytest.raises(ValueError):
        geometry_bounds({"type": "Polygon", "coordinates": coordinates})


def test_polygon_hole_and_boundary_intersection():
    polygon = rectangle((0, 0, 10, 10))
    polygon["coordinates"].append(rectangle((3, 3, 7, 7))["coordinates"][0])
    assert not geometry_intersects(polygon, rectangle((4, 4, 6, 6)))
    assert geometry_intersects(polygon, rectangle((10, 0, 11, 1)))
    assert not geometry_intersects(polygon, rectangle((11, 0, 12, 1)))


def test_multipolygon():
    polygon = {
        "type": "MultiPolygon",
        "coordinates": [
            rectangle((0, 0, 1, 1))["coordinates"],
            rectangle((2, 2, 3, 3))["coordinates"],
        ],
    }
    assert geometry_intersects(polygon, rectangle((2.1, 2.1, 2.9, 2.9)))
