"""Rebuildable, backend-owned SQLite index beside each immutable JSON artifact.

JSON remains the ML interchange and source of truth. Only the scheduler writes
indexes, before publishing the manifest. Readers use read-only SQLite connections
and fall back to JSON if the source fingerprint or derived index is invalid.
"""

import json
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

from app.persistence.atomic import durable_replace
from app.schemas.forecast import HourArtifact


def fingerprint(path):
    info = path.stat()
    return [info.st_size, info.st_mtime_ns]


def index_path(path):
    return path.with_suffix(".sqlite3")


def build_index(path, artifact):
    target = index_path(path)
    fd, name = tempfile.mkstemp(prefix=".index-", suffix=".tmp", dir=path.parent)
    os.close(fd)
    try:
        with closing(sqlite3.connect(name)) as db, db:
            # This database is private staging, never a reader's active database.
            # One final fsync + atomic rename makes a rollback journal unnecessary.
            db.execute("PRAGMA journal_mode=OFF")
            db.execute("PRAGMA synchronous=OFF")
            db.execute("CREATE TABLE metadata (document TEXT NOT NULL)")
            db.execute("CREATE TABLE scores (cell_id TEXT PRIMARY KEY, score REAL NOT NULL)")
            db.execute(
                "INSERT INTO metadata VALUES (?)",
                (
                    json.dumps(
                        {
                            "format": 1,
                            "source": fingerprint(path),
                            "header": artifact.model_dump(mode="json", exclude={"predictions"}),
                            "cell_count": len(artifact.predictions),
                        }
                    ),
                ),
            )
            db.executemany(
                "INSERT INTO scores VALUES (?, ?)",
                ((p.cell_id, p.risk_score) for p in artifact.predictions),
            )
        with open(name, "r+b") as stream:
            os.fsync(stream.fileno())
        durable_replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)


def read_index(path, cells):
    """Return validated header, requested scores and total cells, or None."""
    target = index_path(path)
    if not target.exists():
        return None
    try:
        with closing(sqlite3.connect(target.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            document = json.loads(db.execute("SELECT document FROM metadata").fetchone()[0])
            if document["format"] != 1 or document["source"] != fingerprint(path):
                return None
            artifact = HourArtifact.model_validate(document["header"] | {"predictions": []})
            values = {}
            keys = list(cells)
            for offset in range(0, len(keys), 500):
                batch = keys[offset : offset + 500]
                marks = ",".join("?" for _ in batch)
                values.update(
                    db.execute(
                        f"SELECT cell_id, score FROM scores WHERE cell_id IN ({marks})", batch
                    )
                )
            if any(not 0 <= v <= 1 for v in values.values()):
                return None
            return artifact, values, document["cell_count"]
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError, IndexError):
        return None
