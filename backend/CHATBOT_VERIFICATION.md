# AI assistant verification

Verification performed in the isolated `JS_feat/ai-chatbot` worktree, incorporating
main `4d8d3f0` and preserving the FIRMS frontend integration. No real API key,
production prediction artifacts or SHAP artifacts were available.

## Local checks

Commands below run from `backend/`, using its locked virtual environment. The CI
equivalent is `uv run --no-sync python` in place of the Python executable.

```powershell
./.venv/Scripts/python.exe -m pytest
./.venv/Scripts/python.exe -m ruff check .
./.venv/Scripts/python.exe -m ruff format --check .
./.venv/Scripts/python.exe scripts/smoke.py
./.venv/Scripts/python.exe scripts/smoke.py --fixtures
./.venv/Scripts/python.exe scripts/chat_live_smoke.py
```

- PASS: 354 backend tests, including 69 chatbot tests. One existing upstream
  Starlette/httpx deprecation warning; no failed or skipped tests.
- PASS: Ruff lint and formatting (84 Python files).
- PASS: both subprocess/HTTP smoke modes, including startup, readiness, CORS,
  unavailable data, structured errors and graceful shutdown.
- BLOCKED: optional live smoke explicitly reports no `OPENAI_API_KEY` configured.
  Mocked SDK HTTP tests verify the Responses transport, not paid connectivity.

Commands from `frontend/`:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
node scripts/verify-chat.mjs
```

- PASS: 62 frontend tests; TypeScript; production Vite build.
- Existing Vite warning about a future native-config import extension remains;
  it does not fail the current build.
- Browser harness runs Chrome against actual local servers without intercepting
  FireWatch location/weather/wind requests. It explicitly distinguishes normal
  missing-key behavior from test-only, visibly labeled mock-model synthesis.
  It does not verify actual OpenAI generation or hosted research.
- PASS: all ten browser scenarios, with zero browser JavaScript errors. They cover
  missing-key refusal/retry, real Stockton and Sacramento weather via the labeled
  model stub, missing model/SHAP/FIRMS, unavailable research, simulated provider
  timeout/rate limit, backend outage/recovery, clear/close/keyboard and mobile UI.

## Reproducing the browser check

In two separate PowerShell sessions, from `backend/`, set:

```powershell
$env:SHARED_DATA_DIR=Join-Path $env:TEMP 'firewatch-chat-live-data'
$env:SQLITE_PATH=Join-Path $env:SHARED_DATA_DIR 'jobs.sqlite3'
$env:JOB_ENABLED='false'
$env:ALLOW_FIXTURE_DATA='false'
$env:CORS_ORIGINS='["http://127.0.0.1:5177"]'
```

Run the actual backend in the first session:

```powershell
./.venv/Scripts/python.exe -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8003 --no-access-log
```

Run the **test-only** model stub in the second session:

```powershell
./.venv/Scripts/python.exe -m uvicorn tests.browser_app:create_browser_app --factory --host 127.0.0.1 --port 8004 --no-access-log
```

From `frontend/`, in a third session:

```powershell
npm.cmd run dev -- --host 127.0.0.1 --port 5177 --strictPort
```

Run `node scripts/verify-chat.mjs` from another frontend shell. Real Open-Meteo
access is needed for a cold cache; an unexpired provider cache is also valid.
The test factory is excluded from the application package and must never be
deployed as a live AI service. It deliberately simulates timeout/rate-limit
responses and reports research unavailable rather than fabricating retrieved
sources. Browser artifacts are written outside Git to
`$env:TEMP/firewatch-chat-verification/`: `results.json`,
`key-missing-desktop.png`, `stockton-real-weather-mock-model.png`, `mobile-chat.png`.

## Remaining live verification

- BLOCKED: real `gpt-5-mini` synthesis/tool use and hosted `web_search` citations
  require a backend OpenAI key with model/tool access and a small spending limit.
  Run the optional smoke after setting that server-side key. No alternate model
  is silently used if model/tool access fails.
- BLOCKED: public live AI needs a reachable HTTPS FastAPI backend and an
  authenticated gateway. Pages only hosts static files and retains its demo UI.
- BLOCKED: real model risk, SHAP and local FIRMS data were unavailable. Their
  missing-data responses are tested; no real-data claims are made.
- UNVERIFIED: LinuxONE runtime. Python 3.11 s390x binary wheels for the new SDK's
  native dependencies were successfully downloaded outside Git; this is not an
  execution or complete dependency-tree compatibility test.

See CHATBOT.md for setup, auth/abuse controls, provider limitations and architecture.
