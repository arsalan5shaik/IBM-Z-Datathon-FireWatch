"""Run an isolated, loopback-only server and verify startup, HTTP and graceful exit."""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx

from app.config import Settings


def serve(port: int) -> None:
    import uvicorn

    from app.main import create_app

    server = uvicorn.Server(
        uvicorn.Config(
            create_app(Settings(_env_file=None)),
            host="127.0.0.1",
            port=port,
            access_log=False,
            log_level="warning",
        )
    )

    def stop_on_stdin() -> None:
        sys.stdin.readline()
        server.should_exit = True

    threading.Thread(target=stop_on_stdin, daemon=True).start()
    server.run()


def smoke(fixtures=False) -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    env = os.environ.copy()
    for key in list(env):
        if key.lower() in Settings.model_fields:
            del env[key]
    env["LOG_LEVEL"] = "WARNING"
    env["CORS_ORIGINS"] = '["http://localhost:5173"]'
    script = Path(__file__).resolve()
    with tempfile.TemporaryDirectory(prefix="firewatch-smoke-") as directory:
        if fixtures:
            source = script.parents[2] / "shared/examples"
            data = Path(directory) / "data"
            (data / "predictions").mkdir(parents=True)
            for src, dest in (
                ("grid.mock.geojson", "grid.geojson"),
                ("forecast-hour.example.json", "predictions/20260308T0800Z.json"),
                ("forecast-manifest.example.json", "predictions/manifest.json"),
            ):
                shutil.copyfile(source / src, data / dest)
            env["SHARED_DATA_DIR"] = str(data)
            env["ALLOW_FIXTURE_DATA"] = "true"
        with tempfile.TemporaryFile() as logs:
            process = subprocess.Popen(
                [sys.executable, str(script), "--serve", str(port)],
                cwd=directory,
                env=env,
                stdin=subprocess.PIPE,
                stdout=logs,
                stderr=logs,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            try:
                deadline = time.monotonic() + 20
                with httpx.Client(
                    base_url=f"http://127.0.0.1:{port}", timeout=2, trust_env=False
                ) as client:
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError("Smoke server exited during startup")
                        try:
                            ready = client.get("/health/ready")
                            if ready.status_code == 200:
                                break
                        except httpx.TransportError:
                            pass
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Smoke server startup timed out")
                        time.sleep(0.1)
                    assert client.get("/health/live").json() == {"status": "alive"}
                    status = client.get("/api/v1/status")
                    assert status.status_code == 200
                    data = status.json()
                    assert data["data_mode"] == "unavailable"
                    assert data["forecast"]["missing_hour_count"] == 168
                    assert data["forecast"]["model_version"] is None
                    assert status.headers["x-request-id"]
                    assert client.get("/not-found").json()["error"]["code"] == "not_found"
                    cors = client.get("/api/v1/status", headers={"Origin": "http://localhost:5173"})
                    assert cors.headers["access-control-allow-origin"] == "http://localhost:5173"
                    assert client.get("/openapi.json").status_code == 200
                    if fixtures:
                        response = client.get(
                            "/api/v1/forecasts/risk",
                            params={
                                "hour": "2026-03-08T08:00:00Z",
                                "bbox": "-120,36.22,-119.98,36.24",
                            },
                        )
                        assert response.status_code == 200, response.text
                        result = response.json()
                        assert result["metadata"]["data_mode"] == "fixture"
                        assert result["features"][0]["properties"]["risk_score"] == 0.72
                        history = client.get("/api/v1/forecasts/cell/MOCK_CA_000").json()
                        assert len(history["hours"]) == 168
                process.stdin.write(b"stop\n")
                process.stdin.flush()
                assert process.wait(timeout=10) == 0, "Server did not exit gracefully"
            except BaseException:
                logs.seek(0)
                sys.stderr.write(logs.read().decode("utf-8", errors="replace"))
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                process.stdin.close()
    print(
        json.dumps(
            {
                "smoke": "passed",
                "fixture_forecasts": fixtures,
                "checks": [
                    "startup",
                    "live",
                    "ready",
                    "unavailable-data",
                    "structured-errors",
                    "cors",
                    "openapi",
                    "graceful-shutdown",
                ],
            }
        )
    )


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--serve":
        serve(int(sys.argv[2]))
    else:
        smoke(fixtures="--fixtures" in sys.argv)
