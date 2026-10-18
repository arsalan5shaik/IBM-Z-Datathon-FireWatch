"""Fail-closed paid endpoint controls, including shared process-safe SQLite quotas."""

import hashlib
import hmac
import ipaddress
import sqlite3
import time
from contextlib import closing
from urllib.parse import urlsplit
from uuid import uuid4

from app.errors import APIError


def loopback(host):
    try:
        return host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def authorize(request, settings):
    if settings.chat_access_mode == "trusted_proxy":
        expected = settings.chat_proxy_token
        provided = request.headers.get("x-firewatch-chat-auth", "")
        if (
            not expected
            or len(expected.get_secret_value()) < 32
            or not hmac.compare_digest(provided.encode(), expected.get_secret_value().encode())
        ):
            raise APIError(
                "chat_access_denied", "Chat requires an authenticated hosting gateway", 403
            )
    else:
        origin = request.headers.get("origin")
        if (
            not request.client
            or not loopback(request.client.host)
            or not loopback(request.url.hostname)
        ):
            raise APIError("chat_access_denied", "Chat is restricted to local development", 403)
        if origin and not loopback(urlsplit(origin).hostname):
            raise APIError(
                "chat_access_denied", "Public browser chat requires an authenticated gateway", 403
            )


class ChatLimits:
    def __init__(self, settings, clock=time.time):
        self.settings, self.clock = settings, clock
        self.path = settings.shared_data_dir / "provider-cache/chat-limits.sqlite3"

    def acquire(self, identity):
        now = self.clock()
        user = hashlib.sha256(identity.encode()).hexdigest()
        lease = uuid4().hex
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with closing(sqlite3.connect(self.path, timeout=2)) as db:
                db.execute("CREATE TABLE IF NOT EXISTS chat_calls (user TEXT, at REAL)")
                db.execute(
                    "CREATE TABLE IF NOT EXISTS chat_leases (id TEXT PRIMARY KEY, expires REAL)"
                )
                db.commit()
                db.execute("BEGIN IMMEDIATE")
                db.execute("DELETE FROM chat_calls WHERE at < ?", (now - 86400,))
                db.execute("DELETE FROM chat_leases WHERE expires <= ?", (now,))
                daily = db.execute("SELECT count(*) FROM chat_calls").fetchone()[0]
                recent = db.execute(
                    "SELECT count(*) FROM chat_calls WHERE user=? AND at>?", (user, now - 60)
                ).fetchone()[0]
                active = db.execute("SELECT count(*) FROM chat_leases").fetchone()[0]
                if (
                    daily >= self.settings.chat_daily_request_limit
                    or recent >= self.settings.chat_rate_limit_per_minute
                ):
                    raise APIError(
                        "chat_rate_limit", "Chat request budget reached; retry later", 429
                    )
                if active >= self.settings.chat_max_concurrent_requests:
                    raise APIError("chat_busy", "Chat is busy; retry shortly", 429)
                db.execute("INSERT INTO chat_calls VALUES (?,?)", (user, now))
                db.execute(
                    "INSERT INTO chat_leases VALUES (?,?)",
                    (lease, now + self.settings.chat_timeout_seconds + 30),
                )
                db.commit()
            return lease
        except (sqlite3.Error, OSError):
            raise APIError(
                "chat_limits_unavailable", "Chat budget enforcement is unavailable", 503
            ) from None

    def release(self, lease):
        try:
            with closing(sqlite3.connect(self.path, timeout=2)) as db, db:
                db.execute("DELETE FROM chat_leases WHERE id=?", (lease,))
        except sqlite3.Error:
            pass  # Expiring leases recover after crashes without bypassing quotas.
