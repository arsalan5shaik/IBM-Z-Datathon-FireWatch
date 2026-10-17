"""Location contract preserves frontend Census IDs and legacy place fields."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Location(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    type: Literal["city", "town", "cdp", "county", "zip"]
    county: str | None
    near: str | None = None
    state: Literal["CA"] = "CA"
    center: tuple[float, float]
    bbox: tuple[float, float, float, float]
    population: int | None = Field(default=None, ge=0)
    approximate: bool = False
    display_name: str
    latitude: float
    longitude: float
    boundary_available: bool
    dataset_source: str = "US Census Bureau cartographic boundary files"
    dataset_version: Literal["2023", "2020"]
    dataset_url: str

    @model_validator(mode="after")
    def california_coordinates(self):
        w, s, e, n = self.bbox
        if not (-125 <= w < e <= -114 and 32 <= s < n <= 42.1):
            raise ValueError("California WGS84 bbox required")
        if not (w <= self.longitude <= e and s <= self.latitude <= n):
            raise ValueError("Representative point must be inside its bbox")
        if self.center != (self.longitude, self.latitude):
            raise ValueError("Coordinate ordering must be longitude, latitude")
        return self


class SearchResponse(BaseModel):
    results: list[Location]
    total: int
    limit: int
    truncated: bool


class BoundaryResponse(BaseModel):
    type: Literal["Feature"] = "Feature"
    id: str
    geometry: dict
    properties: Location
    metadata: dict
