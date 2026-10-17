"""Explicit California-local interpretations, bounded absolute UTC forecast hours."""

import re
from datetime import UTC, datetime, time, timedelta

from app.errors import APIError
from app.services.time import CALIFORNIA, iso, utc_hour


def forecast_hour(hour, now):
    value = utc_hour(hour)
    start = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    if not start <= value <= start + timedelta(hours=168):
        raise APIError(
            "chat_time_unavailable",
            "Requested hour is outside available current/168 future hours",
            422,
        )
    return value


def local_hour(day, hour):
    naive = datetime.combine(day, time(hour))
    choices = [naive.replace(tzinfo=CALIFORNIA, fold=fold) for fold in (0, 1)]
    valid = [
        value
        for value in choices
        if value.astimezone(UTC).astimezone(CALIFORNIA).replace(tzinfo=None) == naive
    ]
    if not valid:
        raise APIError(
            "chat_time_nonexistent",
            "That California local hour does not exist during DST transition",
            422,
        )
    if len({value.utcoffset() for value in valid}) > 1:
        raise APIError(
            "chat_time_ambiguous", "Specify a UTC offset for this repeated California DST hour", 422
        )
    return valid[0].astimezone(UTC)


def resolve_time(expression, selected, now):
    text = expression.lower().strip()
    today = now.astimezone(CALIFORNIA).date()
    day = None
    match = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", text)
    if match:
        day = datetime.strptime(match[1], "%Y-%m-%d").date()
    elif "tomorrow" in text:
        day = today + timedelta(days=1)
    elif "weekend" in text:
        day = today if today.weekday() == 6 else today + timedelta(days=(5 - today.weekday()) % 7)
    elif "today" in text:
        day = today
    elif "now" in text:
        return {
            "hour": iso(now.replace(minute=0, second=0, microsecond=0)),
            "interpretation": "Current UTC hour",
        }
    if day is None:
        return {"hour": iso(selected), "interpretation": "Selected absolute forecast hour"}
    hour = (
        15 if "afternoon" in text else 18 if "evening" in text else 9 if "morning" in text else 12
    )
    clock = re.search(r"\b(\d{1,2})(?:\s*:?00)?\s*(am|pm)\b", text)
    if clock:
        digit = int(clock[1])
        if not 1 <= digit <= 12:
            raise APIError("invalid_local_hour", "Use a valid California clock hour", 422)
        hour = digit % 12 + (12 if clock[2] == "pm" else 0)
    if (
        day == today
        and not clock
        and not any(word in text for word in ("afternoon", "morning", "evening"))
    ):
        value = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
        return {"hour": iso(value), "interpretation": "Today/current weekend day: current UTC hour"}
    value = local_hour(day, hour)
    return {
        "hour": iso(value),
        "interpretation": (
            f"{day} {hour:02d}:00 America/Los_Angeles; unspecified time defaults to noon"
        ),
        "within_forecast": day >= today,
    }
