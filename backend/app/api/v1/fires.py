from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query, Request
from pydantic import AwareDatetime

from app.errors import APIError
from app.schemas.geojson import FeatureCollection
from app.services.grid import CA_BBOX
from app.services.grid import bbox as parse_bbox

router = APIRouter(prefix="/api/v1/fires", tags=["satellite observations"])


@router.get(
    "/live",
    response_model=FeatureCollection,
    summary="Cached near-real-time satellite hotspots; not confirmed wildfires",
    description="NASA FIRMS NOAA-20/21 VIIRS observations. Cache-only: GET never contacts NASA. "
    "Choose hours OR an aware since timestamp. "
    "Stale and partial coverage are explicit in metadata.",
)
def live(
    request: Request,
    bbox: str = Query(default=",".join(map(str, CA_BBOX)), max_length=100),
    hours: float | None = Query(default=None, gt=0, le=72),
    since: AwareDatetime | None = None,
    limit: int | None = Query(default=None, ge=1, le=5000),
):
    settings = request.app.state.settings
    now = datetime.now(UTC)
    if hours is not None and since is not None:
        raise APIError("invalid_time_selection", "Specify hours or since, not both", 422)
    start = (
        since.astimezone(UTC)
        if since is not None
        else now - timedelta(hours=hours if hours is not None else 24)
    )
    requested_hours = (now - start).total_seconds() / 3600
    if not 0 < requested_hours <= settings.firms_max_hours:
        raise APIError(
            "invalid_lookback", "Lookback must be positive and within configured maximum", 422
        )
    limit = settings.firms_default_limit if limit is None else limit
    if limit > settings.firms_max_limit:
        raise APIError("invalid_limit", "Limit exceeds configured maximum", 422)
    try:
        bounds = parse_bbox(bbox)
        if (
            bounds[0] < CA_BBOX[0]
            or bounds[1] < CA_BBOX[1]
            or bounds[2] > CA_BBOX[2]
            or bounds[3] > CA_BBOX[3]
        ):
            raise ValueError("Outside California coverage rectangle")
    except ValueError:
        raise APIError("invalid_bbox", "Use a valid bbox within California coverage", 422) from None
    return request.app.state.fires.query(bounds, start, limit, now=now)
