from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.time import utc_hour


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)


class HistoryMessage(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class ChatContext(StrictModel):
    place_id: str | None = Field(default=None, max_length=150)
    cell_id: str | None = Field(default=None, max_length=100)
    hour: datetime | None = None
    incident_id: str | None = Field(default=None, max_length=150)


class ChatRequest(StrictModel):
    message: str = Field(min_length=1, max_length=8000)
    location_id: str | None = Field(default=None, max_length=150)
    selected_hour: datetime | None = None
    history: list[HistoryMessage] = Field(default_factory=list, max_length=20)
    context: ChatContext | None = None

    @field_validator("message")
    @classmethod
    def nonempty_message(cls, value):
        if not value.strip():
            raise ValueError("Nonempty message required")
        return value.strip()

    @model_validator(mode="after")
    def coherent_context(self):
        if self.context:
            if (
                self.location_id
                and self.context.place_id
                and self.context.place_id != self.location_id
            ):
                raise ValueError("Conflicting location context")
            self.location_id = self.location_id or self.context.place_id
            if self.selected_hour and self.context.hour and self.context.hour != self.selected_hour:
                raise ValueError("Conflicting time context")
            self.selected_hour = self.selected_hour or self.context.hour
        if self.selected_hour:
            self.selected_hour = utc_hour(self.selected_hour)
        return self


class ChatSource(StrictModel):
    id: str
    kind: Literal["firewatch", "research"]
    title: str
    provider: str
    url: str | None = None
    retrieved_at: str
    published_at: str | None = None
    valid_at: str | None = None
    freshness: str | None = None
    scope: str | None = None


class ChatResponse(StrictModel):
    answer: str = Field(max_length=16000)
    sources: list[ChatSource] = Field(default_factory=list, max_length=30)
    tools_used: list[str] = Field(default_factory=list, max_length=20)
    location: dict | None = None
    requested_time: str | None = None
    data_freshness: dict = Field(default_factory=dict)
    limitations: list[str] = Field(default_factory=list, max_length=20)
    suggested_questions: list[str] = Field(default_factory=list, max_length=4)
    grounding: list[dict] = Field(default_factory=list)
    model: str | None = None
    mode: Literal["openai", "scope_refusal", "clarification"] = "openai"


class ToolArgs(StrictModel):
    location_id: str | None = Field(default=None, max_length=150)
    hour: datetime | None = None

    @field_validator("hour")
    @classmethod
    def aligned_hour(cls, value):
        return utc_hour(value) if value else value


class SearchArgs(StrictModel):
    query: str = Field(min_length=2, max_length=120)


class TimeArgs(StrictModel):
    expression: str = Field(min_length=1, max_length=200)


class ResearchArgs(StrictModel):
    query: str = Field(min_length=5, max_length=400)


class FinalAnswer(StrictModel):
    within_scope: bool
    answer: str = Field(min_length=1, max_length=12000)
    source_ids: list[Annotated[str, Field(max_length=80)]] = Field(max_length=30)
    limitations: list[Annotated[str, Field(max_length=1000)]] = Field(max_length=10)
    suggested_questions: list[Annotated[str, Field(max_length=200)]] = Field(max_length=4)
