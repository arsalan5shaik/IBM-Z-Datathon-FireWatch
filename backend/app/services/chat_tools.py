"""Whitelisted, validated tools over existing services. No local HTTP or inference."""

import asyncio
import json
import logging
import re
from datetime import UTC, datetime, timedelta
from time import perf_counter

from pydantic import ValidationError

from app.errors import APIError
from app.schemas.chat import ChatSource, ResearchArgs, SearchArgs, TimeArgs, ToolArgs
from app.services.chat_research import research
from app.services.chat_time import forecast_hour, resolve_time
from app.services.forecast_store import category
from app.services.grid import CA_BBOX
from app.services.jsonio import reject_constant, unique_pairs
from app.services.locations import normalize as normalize_location
from app.services.time import iso
from app.services.weather_cache import hour_revision, sample_point, selected_hour

logger = logging.getLogger("firewatch.chat")

TOOL_MODELS = {
    "search_locations": SearchArgs,
    "resolve_time": TimeArgs,
    "get_weather": ToolArgs,
    "get_wind": ToolArgs,
    "get_detections": ToolArgs,
    "get_risk": ToolArgs,
    "get_shap": ToolArgs,
    "research_official_sources": ResearchArgs,
}
DESCRIPTIONS = {
    "search_locations": (
        "Resolve California cities/towns/counties/CDPs/ZCTAs using FireWatch."
        " Ask clarification for ambiguous results. Never invent IDs."
    ),
    "resolve_time": (
        "Resolve a California local date phrase against actual now and "
        "selected UTC hour. Explicit default noon; DST validation."
    ),
    "get_weather": (
        "Actual Open-Meteo forecast at a resolved place and UTC hour, "
        "including wind. Reuse before researching weather. Null args use "
        "selected context."
    ),
    "get_wind": (
        "Actual meteorological wind FROM north, km/h, same cached forecast service as weather."
    ),
    "get_detections": (
        "Recent 24-hour NASA FIRMS satellite detections, NOT confirmed "
        "wildfire incidents; absence never means safe."
    ),
    "get_risk": (
        "Actual published ML risk for the selected hour and place bbox, never"
        " inference. May be unavailable. Scores are not necessarily "
        "probabilities."
    ),
    "get_shap": (
        "Availability of real model explanations. Never substitute general "
        "risk factors for missing SHAP."
    ),
    "research_official_sources": (
        "Research authoritative California wildfire sources only after "
        "checking FireWatch adequacy. Required for confirmed incidents, "
        "historical facts, official warnings and safety questions. Never for "
        "an unrelated topic."
    ),
}


def tool_definitions():
    tools = []
    for name, model in TOOL_MODELS.items():
        schema = model.model_json_schema()
        # OpenAI strict functions require all properties, including nullable defaults.
        schema["required"] = list(schema.get("properties", {}))
        tools.append(
            {
                "type": "function",
                "name": name,
                "description": DESCRIPTIONS[name],
                "parameters": schema,
                "strict": True,
            }
        )
    return tools


def mentioned_locations(store, text):
    store.load()
    clean = f" {normalize_location(text)} "
    hits = [row for row in store.records.values() if f" {normalize_location(row.name)} " in clean]
    if not hits:
        return []
    longest = max(len(normalize_location(row.name)) for row in hits)
    hits = [row for row in hits if len(normalize_location(row.name)) == longest]
    return sorted(hits, key=lambda row: row.id)


class ChatTools:
    def __init__(self, state, client, request, now=None):
        self.state, self.client, self.settings = state, client, state.settings
        self.now = now or datetime.now(UTC)
        self.hour = forecast_hour(
            request.selected_hour or self.now.replace(minute=0, second=0, microsecond=0), self.now
        )
        self.location = state.locations.get(request.location_id) if request.location_id else None
        self.sources: dict[str, ChatSource] = {}
        self.evidence: dict[str, dict] = {}
        self.used = []
        self.research_calls = 0
        self.limitations = []
        self.emergency = bool(
            re.search(r"evacuat|shelter|immediate danger|emergency|safe to", request.message, re.I)
        )
        self.preparedness = bool(
            re.search(r"prepar|if I (?:receive|get)|should I do if", request.message, re.I)
        ) and not bool(
            re.search(
                r"current|active|right now|in effect|am I safe|immediate danger",
                request.message,
                re.I,
            )
        )
        self.needs_research = self.emergency or bool(
            re.search(
                (
                    "confirmed|active wildfires|camp "
                    "fire|histor|caused|warnings|policy|science|prepared|prevent|air "
                    "quality|smoke"
                    "|radiative power|\\bfrp\\b|how.*wind.*(?:affect|spread)"
                    "|official.*(?:incident|updates)"
                ),
                request.message,
                re.I,
            )
        )

    def register(self, name, result):
        key = f"fw-{len(self.sources) + 1}"
        valid = (
            result.get("forecast_hour")
            or result.get("observation_end")
            or result.get("metadata", {}).get("observation_end")
        )
        freshness = (
            result.get("cache_status")
            or result.get("metadata", {}).get("cache_status")
            or result.get("status")
        )
        if result.get("metadata", {}).get("stale"):
            freshness = "stale"
            self.limitations.append(f"{name} data is stale")
        self.sources[key] = ChatSource(
            id=key,
            kind="firewatch",
            title=name.replace("_", " "),
            provider=result.get("source", "FireWatch"),
            retrieved_at=iso(self.now),
            valid_at=valid,
            freshness=freshness,
            scope=self.location.display_name if self.location else "California",
            fetched_at=result.get("fetched_at"),
            generated_at=result.get("generated_at"),
            sampling_coordinates=result.get("sampling_coordinates"),
        )
        self.evidence[key] = result
        return result | {"source_id": key}

    async def execute(self, name, arguments):
        started = perf_counter()
        try:
            return await self._execute(name, arguments)
        finally:
            # Names only, never arguments, user messages, credentials or results.
            logger.info(
                "chat_tool_completed tool=%s duration_ms=%d",
                name if name in TOOL_MODELS else "unsupported",
                round((perf_counter() - started) * 1000),
                extra={
                    "tool": name if name in TOOL_MODELS else "unsupported",
                    "duration_ms": round((perf_counter() - started) * 1000),
                },
            )

    async def _execute(self, name, arguments):
        if len(self.used) >= self.settings.chat_max_tool_calls:
            raise APIError(
                "chat_tool_limit", "Chat tool budget exhausted; ask a narrower question", 422
            )
        if name not in TOOL_MODELS:
            raise APIError("chat_invalid_tool", "AI requested an unsupported tool", 502)
        try:
            raw = json.loads(
                arguments, object_pairs_hook=unique_pairs, parse_constant=reject_constant
            )
            args = TOOL_MODELS[name].model_validate(raw)
        except (ValueError, TypeError, ValidationError):
            raise APIError(
                "chat_invalid_tool_arguments", "AI supplied invalid tool arguments", 502
            ) from None
        self.used.append(name)
        if name == "search_locations":
            rows = await asyncio.to_thread(self.state.locations.search, args.query, 10)
            return self.register(name, rows.model_dump(mode="json") | {"status": "available"})
        if name == "resolve_time":
            return self.register(name, resolve_time(args.expression, self.hour, self.now))
        if name == "research_official_sources":
            if self.research_calls >= self.settings.chat_max_research_calls:
                raise APIError("chat_research_limit", "Online research budget exhausted", 422)
            # Weather-only questions with adequate local data do not spend research calls.
            if not self.needs_research and any(
                row.get("status") == "available"
                and row.get("source") == "Open-Meteo"
                and row.get("cache_status") == "fresh"
                for row in self.evidence.values()
            ):
                return {
                    "status": "not_needed",
                    "reason": "Fresh FireWatch forecast already answers the weather request",
                }
            self.research_calls += 1
            try:
                result = await research(self.client, args.query, self.now, self.emergency)
                if result.get("partial_retrieval"):
                    self.limitations.append(
                        "Some research actions failed; only completed retrievals support citations"
                    )
                registered = []
                for item in result["sources"]:
                    source = ChatSource.model_validate(item)
                    source.id = f"research-{self.research_calls}-{source.id}"
                    self.sources[source.id] = source
                    registered.append(source.model_dump())
                return result | {
                    "sources": registered,
                    "source_ids": [s.id for s in self.sources.values() if s.kind == "research"],
                }
            except APIError as error:
                self.limitations.append(
                    f"Research unavailable ({error.code}); "
                    "current official information is not verified"
                )
                return {
                    "status": "unavailable",
                    "code": error.code,
                    "reason": "No verified external research is available",
                }
        location = self.state.locations.get(args.location_id) if args.location_id else self.location
        if args.location_id:
            self.location = location
        hour = forecast_hour(args.hour or self.hour, self.now)
        self.hour = hour
        try:
            if name in ("get_weather", "get_wind"):
                if location is None:
                    return self.register(
                        name,
                        {"status": "unavailable", "reason": "Resolve a California location first"},
                    )
                point = sample_point(location.latitude, location.longitude)
                [(entry, freshness)] = await self.state.weather.get([point])
                row = selected_hour(entry, hour)
                result = row.model_dump(mode="json") | {
                    "temperature_f": round(row.temperature_c * 9 / 5 + 32, 1),
                    "status": "available",
                    "source": "Open-Meteo",
                    "data_kind": "forecast",
                    "cache_status": freshness,
                    "fetched_at": iso(entry.forecast.fetched_at),
                    "revision": hour_revision(point, row),
                    "location_id": location.id,
                    "representative_coordinates": list(location.center),
                    "sampling_coordinates": [point.longitude, point.latitude],
                    "provider_coordinates": [entry.forecast.longitude, entry.forecast.latitude],
                    "sampling": "Coarse 0.5-degree anchor, not a 3 km or street-level weather grid",
                    "wind_direction_convention": "degrees FROM north; km/h",
                }
                if freshness == "stale":
                    self.limitations.append("Forecast weather is stale")
                return self.register(name, result)
            if name == "get_detections":
                bounds = location.bbox if location else CA_BBOX
                data = await asyncio.to_thread(
                    self.state.fires.query,
                    bounds,
                    self.now - timedelta(hours=24),
                    100,
                    now=self.now,
                )
                return self.register(
                    name,
                    {
                        "status": "available",
                        "source": "NASA FIRMS",
                        "not_confirmed_incidents": True,
                        # Keep acquisition time separate from retrieval and coverage
                        # metadata. A compact transport also avoids sending the full
                        # GeoJSON/provider diagnostics to the paid model.
                        **{
                            key: data.metadata[key]
                            for key in (
                                "cache_status",
                                "stale",
                                "fetched_at",
                                "requested_since",
                                "requested_hours",
                                "matched_count",
                                "returned_count",
                                "truncated",
                                "partial_sources",
                                "partial_time_coverage",
                                "units",
                            )
                        },
                        "observation_start": min(
                            (f.properties["acquired_at"] for f in data.features), default=None
                        ),
                        "observation_end": max(
                            (f.properties["acquired_at"] for f in data.features), default=None
                        ),
                        "observation_time_scope": "Acquisition range of returned observations",
                        "query_bbox": list(bounds),
                        "geographic_scope": "Location bounding box, not a distance-radius search",
                        "detections": [
                            {
                                "coordinates": feature.geometry["coordinates"],
                                **{
                                    key: feature.properties[key]
                                    for key in (
                                        "id",
                                        "acquired_at",
                                        "product",
                                        "satellite",
                                        "confidence",
                                        "frp_mw",
                                    )
                                },
                            }
                            for feature in data.features
                        ],
                    },
                )
            if name == "get_risk":
                return self.register(name, await asyncio.to_thread(self.risk, location, hour))
            return self.register(
                name,
                {
                    "status": "unavailable",
                    "reason": (
                        "Real SHAP artifact contract/service is not operational; no "
                        "explanations invented"
                    ),
                },
            )
        except APIError as error:
            result = {
                "status": "unavailable",
                "code": error.code,
                "reason": f"FireWatch {name} data is unavailable; no values may be inferred",
            }
            self.limitations.append(result["reason"])
            return self.register(name, result)

    def risk(self, location, hour):
        manifest, grid = self.state.forecasts.snapshot()
        if manifest.data_mode != "live":
            raise APIError("live_predictions_unavailable", "Only fixture predictions are available")
        if location is None:
            return {
                "status": "unavailable",
                "reason": "Select an area for bounded prediction retrieval",
            }
        if hour not in manifest.hours:
            raise APIError("forecast_hour_unavailable", "Requested forecast hour missing", 404)
        try:
            cells = grid.query(location.bbox, min(1000, self.settings.max_response_cells))
        except ValueError:
            return {
                "status": "unavailable",
                "reason": "Area exceeds bounded risk query; select a smaller location",
            }
        artifact, values = self.state.forecasts.hour(manifest, grid, hour, cells)
        scores = list(values.values())
        return {
            "status": "available" if scores else "unavailable",
            "source": "FireWatch ML artifacts",
            "forecast_hour": iso(hour),
            "generated_at": iso(artifact.generated_at),
            "model_version": artifact.model_version,
            "score_type": artifact.score_type,
            "target_type": artifact.target_type,
            "maximum_risk_score": max(scores) if scores else None,
            "mean_risk_index": sum(scores) / len(scores) if scores else None,
            "maximum_category": category(max(scores)) if scores else None,
            "selected_cells": len(cells),
            "available_cells": len(scores),
            "missing_cells": len(cells) - len(scores),
            "scope": "Selected location bounding box, not precise boundary intersection",
            "metadata": self.state.forecasts.metadata(manifest),
        }
