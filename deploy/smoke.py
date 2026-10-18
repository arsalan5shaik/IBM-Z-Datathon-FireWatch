"""Exercise an isolated Compose stack without provider credentials (Python stdlib)."""

import argparse
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=["linux/amd64", "linux/s390x"], required=True)
    parser.add_argument("--tag", required=True, help="Tag of already built backend/frontend images")
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()
    env = dict(os.environ)
    env.update(
        FIREWATCH_PLATFORM=args.platform,
        IMAGE_TAG=args.tag,
        FIREWATCH_BIND_ADDRESS="127.0.0.1",
        FIREWATCH_PORT=str(args.port),
        NASA_FIRMS_MAP_KEY="",
        CHAT_PROXY_TOKEN="",
        OPENAI_API_KEY="",
        COMPOSE_PROFILES="",
    )
    project = "firewatch-smoke-" + args.platform.split("/")[1]
    base = [
        "docker",
        "compose",
        "--project-name",
        project,
        "--env-file",
        "deploy/.env.example",
    ]

    def command(argv):
        result = subprocess.run(
            argv, check=False, cwd=ROOT, env=env, text=True, capture_output=True
        )
        if result.returncode:
            raise RuntimeError(f"Command failed: {argv}\n{result.stdout}\n{result.stderr}")
        return result.stdout.strip()

    def compose(*argv):
        return command([*base, *argv])

    def request(path, expected=200, body=None):
        req = urllib.request.Request(f"http://127.0.0.1:{args.port}{path}", data=body)
        try:
            response = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            payload = response.read()
            assert response.status == expected, (path, response.status, payload[:300])
            return payload

    try:
        compose("config", "--quiet")
        compose("up", "--no-build", "--wait", "--wait-timeout", "240")
        html = request("/").decode()
        assert "<html" in html
        script = re.search(r'src="([^"]+\.js)"', html)
        assert script, "No bundled JS entry"
        js = request("/" + script[1].removeprefix("./")).decode()
        assert "/api/v1" in js and "http://backend:" not in js
        request("/data/ca-boundary.geojson")
        request("/assets/not-present.js", 404)
        request("/a/nested-client-route")
        status = json.loads(request("/api/v1/status"))
        arch = "s390x" if args.platform.endswith("s390x") else "x86_64"
        assert status["runtime_arch"] == arch, status["runtime_arch"]
        assert status["api"]["status"] == "healthy"
        assert not status["scheduler"]["enabled"]
        assert status["data_mode"] == "unavailable"
        assert status["providers"]["firms"]["status"] == "unavailable"
        firms = status["providers"]["firms"]
        assert firms["cache_status"] == "unavailable" and firms["stale"]
        assert firms["last_error"] == "credentials_missing"
        assert firms["last_success_at"] is None
        request("/api/v1/fires/live", 503)
        request("/api/v1/chat", 403, b"{}")
        request("/api/v1/chat/", 403, b"{}")
        request("/api/v1/CHAT", 403, b"{}")
        ids = compose("ps", "-q").splitlines()
        assert len(ids) == 3, ids
        for cid in ids:
            info = json.loads(command(["docker", "inspect", cid]))[0]
            assert info["State"]["Health"]["Status"] == "healthy"
            assert info["Config"]["User"] in ("10001:10001", "101:101")
            assert info["HostConfig"]["ReadonlyRootfs"]
            assert info["HostConfig"]["CapDrop"] == ["ALL"]
            published = info["HostConfig"]["PortBindings"] or {}
            assert not published or list(published) == ["8080/tcp"]
            injected = dict(item.split("=", 1) for item in info["Config"]["Env"])
            for secret in (
                "OPENAI_API_KEY",
                "LLM_API_KEY",
                "CHAT_PROXY_TOKEN",
                "NASA_FIRMS_MAP_KEY",
            ):
                assert not injected.get(secret), f"Unexpected smoke credential: {secret}"
        # Real SQLite writes, shared UID permissions and cross-process reads;
        # the marker has no application/provider data and remains in this test volume.
        compose(
            "exec",
            "-T",
            "backend",
            "python",
            "-c",
            "import sqlite3; "
            "db=sqlite3.connect('/data/deployment-smoke.sqlite3'); "
            "db.execute('CREATE TABLE IF NOT EXISTS marker (value TEXT)'); "
            "db.execute(\"INSERT INTO marker VALUES ('persistent')\"); db.commit()",
        )
        probe = (
            "import sqlite3; db=sqlite3.connect('/data/deployment-smoke.sqlite3'); "
            "assert db.execute('SELECT value FROM marker').fetchone()[0]=='persistent'"
        )
        compose("exec", "-T", "firms-worker", "python", "-c", probe)
        compose(
            "exec",
            "-T",
            "firms-worker",
            "python",
            "-c",
            "import json; from pathlib import Path; "
            "p=Path('/data/provider-cache/firms.json'); "
            "assert p.exists(); d=json.loads(p.read_text()); assert d['sources']",
        )
        # Recreate containers while retaining the named volume (stronger than restart).
        compose("down", "--timeout", "30")
        compose("up", "--no-build", "--wait", "--wait-timeout", "240")
        compose("exec", "-T", "backend", "python", "-c", probe)
        compose("exec", "-T", "firms-worker", "python", "-c", probe)
        request("/api/v1/status")
        started = time.monotonic()
        compose("stop", "--timeout", "30")
        assert time.monotonic() - started < 30, "Shutdown exhausted grace period"
        for service in ("backend", "firms-worker", "frontend"):
            cid = compose("ps", "--all", "-q", service)
            state = json.loads(command(["docker", "inspect", cid]))[0]["State"]
            # Uvicorn re-raises SIGTERM after completing lifespan shutdown.
            allowed = (0, 143) if service == "backend" else (0,)
            assert state["ExitCode"] in allowed and not state["OOMKilled"], (service, state)
            if service == "backend":
                assert "Application shutdown complete" in compose("logs", "--no-color", service)
        print(
            json.dumps(
                {
                    "result": "PASS",
                    "platform": args.platform,
                    "runtime_arch": arch,
                    "providers": "no credentials; no paid/live calls",
                    "checks": "health, proxy, assets, SPA, chat denial, isolation, "
                    "provider failure distinct from liveness, shared cache, SQLite, "
                    "recreation persistence, graceful stop",
                }
            )
        )
    except Exception:
        print(compose("logs", "--no-color", "--tail", "50"))
        raise
    finally:
        # Preserve even smoke volumes; operators may inspect or explicitly remove them.
        compose("down", "--timeout", "30")


if __name__ == "__main__":
    main()
