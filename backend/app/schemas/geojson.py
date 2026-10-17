from typing import Any, Literal

from pydantic import BaseModel


class Feature(BaseModel):
    type: Literal["Feature"] = "Feature"
    id: str
    geometry: dict[str, Any]
    properties: dict[str, Any]


class FeatureCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    metadata: dict[str, Any]
    features: list[Feature]
