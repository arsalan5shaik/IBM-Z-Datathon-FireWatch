from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

CALIFORNIA = ZoneInfo("America/Los_Angeles")


def utc_hour(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Timestamp must be timezone-aware")
    value = value.astimezone(UTC)
    if value.minute or value.second or value.microsecond:
        raise ValueError("Timestamp must align to an hour")
    return value


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def next_hour(now: datetime) -> datetime:
    if now.tzinfo is None:
        raise ValueError("UTC-aware timestamp required")
    return now.astimezone(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)


def day_hours(day: date) -> list[datetime]:
    start = datetime.combine(day, time.min, CALIFORNIA).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time.min, CALIFORNIA).astimezone(UTC)
    return [start + timedelta(hours=i) for i in range(int((end - start).total_seconds() / 3600))]
