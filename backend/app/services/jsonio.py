import json
from pathlib import Path


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError("Non-finite JSON number")


def read_json(path: Path, max_bytes: int = 32_000_000):
    with path.open("rb") as stream:
        data = stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError("Artifact exceeds size limit")
    return json.loads(data, object_pairs_hook=unique_pairs, parse_constant=reject_constant)
