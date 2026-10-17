from fastapi import APIRouter, Path, Query, Request

from app.errors import APIError
from app.schemas.locations import BoundaryResponse, SearchResponse

router = APIRouter(prefix="/api/v1", tags=["locations"])


@router.get("/locations/search", response_model=SearchResponse)
@router.get("/places/search", response_model=SearchResponse, include_in_schema=False)
def search(
    request: Request,
    q: str = Query(min_length=2, max_length=120),
    limit: int = Query(default=10, ge=1, le=25),
):
    """Indexed California cities, towns, CDPs, counties and exact Census ZCTAs."""
    return request.app.state.locations.search(q, limit)


@router.get("/locations/{location_id}/boundary", response_model=BoundaryResponse)
@router.get(
    "/places/{location_id}/boundary", response_model=BoundaryResponse, include_in_schema=False
)
def boundary(request: Request, location_id: str = Path(max_length=150)):
    """Cached Census display geometry, including holes and disconnected parts."""
    return request.app.state.locations.boundary(location_id)


@router.get("/locations/{location_id}/cells")
def cells(request: Request, location_id: str = Path(max_length=150)):
    """Explicit blocked integration: no authoritative ML grid/mapping supplied."""
    request.app.state.locations.get(location_id)
    raise APIError(
        "ml_grid_mapping_unavailable",
        "Authoritative ML grid and precise boundary intersection contract are not available",
        503,
    )
