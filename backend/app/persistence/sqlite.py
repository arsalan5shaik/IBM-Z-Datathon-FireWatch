import sqlite3
from contextlib import closing
from pathlib import Path


def record_job(
    path: Path, name: str, attempted_at: str, next_run_at: str, success: bool, error: str | None
):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=5)) as connection, connection:
        connection.execute("""CREATE TABLE IF NOT EXISTS jobs (
            name TEXT PRIMARY KEY, attempted_at TEXT, last_success_at TEXT,
            next_run_at TEXT, last_error TEXT)""")
        connection.execute(
            """INSERT INTO jobs VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET attempted_at=excluded.attempted_at,
            last_success_at=COALESCE(excluded.last_success_at,jobs.last_success_at),
            next_run_at=excluded.next_run_at,last_error=excluded.last_error""",
            (name, attempted_at, attempted_at if success else None, next_run_at, error),
        )


def read_job(path: Path, name="forecast"):
    if not path.exists():
        return {}
    try:
        with closing(
            sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
        ) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute("SELECT * FROM jobs WHERE name=?", (name,)).fetchone()
            return dict(row) if row else {}
    except sqlite3.Error:
        return {"last_error": "job_metadata_unavailable"}
