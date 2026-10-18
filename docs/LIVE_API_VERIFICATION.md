# FireWatch live API verification and deployment readiness

Verified 2026-10-18 UTC, locally on Windows/Python 3.11.17 and Chrome.
Base: main `a409571`; branch: `JS_feat/live-api-verification`.
No Dockerfiles, deployment infrastructure, ML artifacts or teammate branches were changed.

## Decision

**NOT READY FOR DOCKER. NOT READY FOR LINUXONE DEPLOYMENT.**

| Gate | Result |
|---|---|
| NASA FIRMS ingestion and cached API | PASS |
| OpenAI credentials, billing access, gpt-5-mini and Responses connectivity | PASS |
| Live location/weather/detection chat in desktop/mobile Chrome | PASS after corrections |
| Complete chatbot live acceptance | FAIL / remaining verification BLOCKED by the test budget |
| Backend automated regression | PASS: 363 tests |
| Frontend tests, typecheck and production build | PASS: 62 tests |
| LinuxONE execution | NOT VERIFIED |

Do not merge this verification PR automatically. One elevated-risk question still
ended in a provider timeout, research corrections need live revalidation, and not
all requested questions could be executed within the initial paid-test limits.
Passing mocked tests does not close these live acceptance gaps.

## Environment and repository

Inspected README, FIRMS.md, CHATBOT.md, CHATBOT_VERIFICATION.md, both environment
examples, actual routers/services/schemas, locked dependencies and all three CI
workflows. Location, weather, rolling publication, FIRMS frontend and chatbot PRs
are present on the base. There were no overlapping open PRs at inspection.

The shared main checkout's unrelated `frontend/.gitignore` edit was preserved.
All work ran in an isolated worktree. Backend `.env` loading is absolute to that
checkout's backend directory, independent of launch cwd; process variables override
dotenv. The original developer `.env` was not overwritten. A private ignored copy
was used for the isolated checkout, then removed after its servers were stopped;
the original remained untouched. Canonical keys take precedence over legacy
`LLM_API_KEY` / `FIRMS_MAP_KEY`; the selected OpenAI key was checked without printing it.

| Setting | Verified effective value |
|---|---|
| OPENAI_API_KEY / NASA_FIRMS_MAP_KEY | Present; values never printed |
| OPENAI_MODEL | gpt-5-mini |
| WEATHER_PROVIDER | open-meteo |
| FORECAST_HOURS / GRID_RESOLUTION_M | 168 / 3000 |
| CHAT_ACCESS_MODE | local |
| JOB_ENABLED / ALLOW_FIXTURE_DATA | false / false |
| FIRMS products | VIIRS_NOAA20_NRT, VIIRS_NOAA21_NRT |
| FIRMS_REFRESH_MINUTES | 15 |

For the test servers only, CORS_ORIGINS was set in the process environment to
`["http://127.0.0.1:5178"]`; no dotenv file was edited. Git ignore checks passed
for `.env`, FIRMS/weather caches and quota SQLite. No provider secret was passed
to Vite, the browser or CI. Final byte scanning of 146 changed/built/evidence files found
none of the configured credentials. Production source paths contain no hardcoded
Windows drive paths. Test output and screenshots remain outside Git.

## NASA FIRMS

Exactly **one** live `python -m app.jobs.refresh_fires` refresh was run, without
`--force`. Both official NASA Area CSV products accepted the configured key.

| Product | Valid CA observations | Latest acquisition UTC | Invalid / duplicates | Excluded outside time/CA coverage |
|---|---:|---|---|---:|
| VIIRS_NOAA20_NRT | 292 | 2026-10-17T20:49:00Z | 0 / 0 | 28 |
| VIIRS_NOAA21_NRT | 347 | 2026-10-17T21:31:00Z | 0 / 0 | 65 |

Total: **639** observations in the retained 72-hour dataset. Product fetches
completed at `2026-10-18T00:40:09.032197Z` and `00:40:08.732858Z`, respectively.
The cache initially reported healthy/fresh with no provider errors. Its full-source
fetch timestamp is the older product timestamp. It naturally became stale after
15 minutes because the polling owner was intentionally stopped; later chat responses
identified this staleness correctly. No additional forced refresh was performed.

All retained coordinates, UTC timestamps, finite nonnegative FRP, positive brightness
where present, stable unique IDs and inclusion in the actual Census-derived California
boundary were checked. The expected ignored `shared/data/provider-cache/firms.json`
was read back through a new consumer. A cache fetch timestamp is not a satellite
acquisition timestamp. An empty valid dataset is distinct from a failed provider.

### Actual HTTP checks

| Request | HTTP | Returned / matched | Truncated |
|---|---:|---:|---|
| /health/ready | 200 | initialized | n/a |
| /api/v1/status | 200 | provider state present | n/a |
| /api/v1/fires/live | 200 | 191 / 191 | false |
| /api/v1/fires/live?hours=24&limit=500 | 200 | 191 / 191 | false |
| /api/v1/fires/live?hours=72&limit=500 | 200 | 500 / 639 | true |
| /api/v1/fires/live?bbox=-122.5,37,-121.5,38&hours=24&limit=500 | 200 | 10 / 10 | false |
| /api/v1/fires/live?hours=72&limit=1 | 200 | 1 / 639 | true |

GeoJSON FeatureCollection/Point shape, [longitude,latitude], actual product/satellite,
UTC timestamps, l/n/h confidence, FRP alias equality and MW units, bbox inclusion,
freshness, limits and pre-limit counts passed. No fixture observations were used.
Eight malformed hour/limit/bbox/since combinations returned structured 422 errors.
No cache reads or API startup triggered another NASA request.

The actual `--loop` CLI was started once immediately after refresh, reported
`not_due`, stayed alive waiting for its next cycle, and was terminated while idle.
No polling owner remains. A new deterministic job test checks two cycles at 900
seconds and that `--force` applies only to the first cycle. Existing tests cover
cross-process ownership, atomic writes, restart persistence, stale/partial fallback,
corrupt caches, empty/malformed CSV, bad credentials, timeout, 429 and 5xx responses.

## OpenAI chatbot

Actual Responses returned model snapshot **gpt-5-mini-2025-08-07** under configured
alias **gpt-5-mini**, official SDK 2.54.0. Successful requests establish usable key,
project/model access and paid API access; the exact account balance was not inspected.
No alternate model was used. Server tools consumed the real catalog, NASA cache and
Open-Meteo data. Model-initiated `get_weather` and `research_official_sources`
function calls also executed with validated arguments.

### Strict budget and expenditure

- 15 real chat HTTP requests, including diagnostics/retests: **8 HTTP 200**, **7 safe
  error responses**. A 200 was not automatically counted as an accurate answer.
- 20 real SDK Responses requests: 19 returned token usage; one timed out without
  usage. Verification disabled SDK retries; production retains its bounded retry.
- Two hosted research requests produced **three web_search_call output actions**.
  Every observed action was counted conservatively. Further research was blocked;
  no automatic paid retries were run after either limit was reached.
- Measured returned usage: **106,295 input tokens**, including **30,720 cached input**;
  **12,361 output tokens**, including reasoning. These are token counts, not an invoice.
- Estimated token component: approximately **$0.0444**, using $0.25/M input,
  $0.025/M cached input and $2/M output. Conservatively budgeting three $0.01 search
  actions gives approximately **$0.0744**, excluding any unreported timeout usage
  or separately billed search content. Actual total debit is UNKNOWN. Rates checked
  against [model pricing](https://developers.openai.com/api/docs/models/gpt-5-mini)
  and [tool pricing](https://developers.openai.com/api/docs/pricing).

The opt-in verification server persists counters outside Git, caps 15 chat requests
and 32 SDK attempts, and stops starting research after three observed actions.
Native search can emit multiple search/open/find actions despite max_tool_calls=1;
the client cannot cancel internal completed actions retrospectively. Never treat
that parameter as a guaranteed exact action count or an account spending limit.

### Requested questions and actual outcomes

| Question | Result / evidence |
|---|---|
| What is FireWatch? | PASS: HTTP 200, platform description; no claim that ML/SHAP data exists |
| Recent satellite detections in California? | Initial accuracy FAIL: retrieval time mislabeled as observation end. Corrected transport/validation; subsequent 200 used actual acquisition end and bounded counts |
| Latest detections near Sacramento? | Initial numeric-validation 502; final real-browser PASS with actual location/hour, one NOAA-20 observation, stale disclosure |
| What does fire radiative power mean? | BLOCKED/502 after research budget exhausted: no verified supporting sources, no unsourced definition released |
| Current weather in Stockton? | Initially rejected valid Fahrenheit conversion; corrected and real-browser PASS |
| How does wind affect wildfire spread? | BLOCKED: not executed after the paid-test budget was exhausted |
| Stockton risk over the next seven days? | PASS for unavailable-data behavior: 200 explicitly said forecast_not_ready; no invented risk score/probability |
| Why elevated predicted risk? | FAIL: first 502 numeric-grounding rejection; after context/list corrections, last live attempt timed out (504). Not signed off |
| Satellite hotspot versus confirmed wildfire? | BLOCKED: not executed within the remaining paid-test budget; distinction was correct in actual FIRMS answers |
| What if I receive an evacuation order? | BLOCKED: exact prompt not executed within budget; emergency/mock security cases passed. Related preparation prompt below was tested live |

Stockton's verified selected-hour forecast was `2026-10-18T00:00:00Z`: 31.2 C /
88.2 F, humidity 19%, precipitation 0.0 mm, wind 9.8 km/h FROM 328 degrees, gusts
17.3 km/h, sampled at 38.0,-121.5. The real provider refresh was
`2026-10-18T00:49:48.742910Z`. These are forecasts, not observed street-level conditions.

Sacramento's returned observation was independently cross-checked against the
backend cache: acquisition `2026-10-17T09:26:00Z`, FRP 20.75 MW, confidence n, one
match in the selected city bbox. It was not labeled a confirmed wildfire or proof
that other fires do not exist. The answer correctly separated observation and fetch
times and identified the aged cache as stale.

### External research and remaining failures

1. CAL FIRE evacuation preparation: real hosted retrieval succeeded and returned six
   domain-validated citations, including [Get Ready to Go](https://www.fire.ca.gov/prepare/get-ready-to-go).
   The old emergency guard replaced useful general advice with a current-orders
   disclaimer. It now distinguishes preparedness from current safety/active-order
   questions; the correction is regression-tested but not live-retested within budget.
2. Official California incident updates: a real model function call initiated a hosted
   retrieval with two completed actions. The old validator required exactly one and
   incorrectly rejected it, resulting in a final 502. The validator now accepts completed
   search/open actions while retaining URL/source/annotation checks. Mock regression
   PASS; fresh live verification is BLOCKED by the three-action budget.

Direct Python requests to the six CAL FIRE URLs returned 403 (access restriction),
so those requests do not establish full-page content verification. An independent
research-browser retrieval of the canonical CAL FIRE Get Ready to Go page succeeded,
confirmed its official title/content and preparation guidance. No page publication
time was supplied by the hosted tool; citations retain unknown publication times.
No invented current evacuation orders, incident names, acreage, containment, risk
scores or SHAP values were observed in successful released data answers.

Two remaining quality issues need review: numeric grounding is a conservative
text-based guard rather than proof of semantic correctness, and some generated
follow-up suggestions offered unsupported actions such as immediate FIRMS refresh,
radius queries or imagery. The actual tools are cache-only/bbox/hour consumers;
those offers are not verified capabilities. Do not add those features to conceal
this limitation. The original complete system prompt remains unchanged.

### Corrections and security

Scoped changes: compact detection transport, query-specific acquisition ranges,
explicit fetch/sample metadata and lookback/bbox, verified Fahrenheit conversion,
timestamp field validation, verified forecast/grid context, numbered-list handling,
preparedness distinction, and multiple completed research-action compatibility.
Nine added regressions/job tests raised the full backend total from 354 to 363.
Existing invented-score/weather/SHAP and prompt-injection rejection assertions remain.

Mock tests cover missing/invalid keys, OpenAI timeout/429, unavailable research,
missing NASA/weather/ML/SHAP, input/history/output/tool/research bounds, hostile
URLs/content, secret rejection, concurrency/leases, shared rate limits and disconnect
cancellation. Actual production-app remote-peer testing returned **403** before an
OpenAI SDK client was created. The local listener was never exposed publicly.
Rate limits/authentication are not replaced with permissive test settings.

## Automated and frontend verification

| Check | Final result |
|---|---|
| uv run --no-sync python -m pytest -q | PASS: 363 passed, 0 failed/skipped/errors |
| Ruff check / format --check | PASS; 87 Python files formatted |
| scripts/smoke.py and --fixtures | PASS, isolated real HTTP startup/shutdown |
| npm test | PASS: 62 tests, 10 files |
| npm run typecheck / npm run build | PASS |
| Real Chrome integration | PASS: five checks, zero JS errors, no CORS errors |
| Paid/research tests in normal CI | Not run; explicit opt-in scripts only |

The existing Starlette/httpx deprecation warning and Vite future native-config
import warning remain. Earlier development failures were corrected; their passing
regressions do not override the outstanding live acceptance failures above.

Real browser checks used actual FastAPI, OpenAI, FIRMS and Open-Meteo, with **no
mocked API responses**. MapLibre rendered actual backend observation IDs; the
48-hour frontend view loaded 459 records and 191 were rendered in the tested view.
The selected hotspot panel showed its actual UTC acquisition/confidence/FRP.
Stockton-to-Sacramento switching preserved selected UTC time and used the new ID;
loading, sources, stale labels and 390px mobile layout passed. Screenshots were
visually inspected. Expected unavailable integrations returned incidents 404 and
risk 503; these are not successful incident/model integrations. Prior mocked
tests cover outage, retry, late responses and XSS; they are not labeled live tests.

Evidence remains in the local temporary `firewatch-live-api-results` directory:
`budget.json`, `answers.json`, `firms-endpoints.json`, `source-urls.json`,
`browser.json`, `real-firms-desktop.png`, `real-chat-stockton.png`,
`real-chat-mobile.png`, plus earlier failure evidence. Do not commit/upload raw
paid output or credentials as CI artifacts.

## Reproducible commands

From backend with the locked Python environment (the local uv executable was
invoked through its existing installed Python module because uv was not on PATH):

```powershell
uv sync --locked --python 3.11
uv run --no-sync python -m pytest -q
uv run --no-sync python -m ruff check .
uv run --no-sync python -m ruff format --check .
uv run --no-sync python scripts/smoke.py
uv run --no-sync python scripts/smoke.py --fixtures
```

The one controlled NASA command and stopped loop check were:

```powershell
uv run --no-sync python -m app.jobs.refresh_fires
uv run --no-sync python -u -m app.jobs.refresh_fires --loop
# Stop the one loop owner after its not_due result; do not force another refresh.
```

Normal production-code local startup remains:

```powershell
uv run --no-sync uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

For a **newly authorized paid test run only**, the instrumented local server uses
the same real app/SDK and provides persistent usage/call counters. It disables SDK
retries to limit diagnostic cost; no response is mocked. The current run's saved
budget is exhausted: do not remove/reset it to evade the limits.

```powershell
$env:FIREWATCH_RUN_PAID_VERIFICATION='1'
$env:CORS_ORIGINS='["http://127.0.0.1:5178"]'
uv run --no-sync python scripts/live_verification_server.py
# In frontend, separate shell:
npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run build
npm run dev -- --host 127.0.0.1 --port 5178 --strictPort
# Separate frontend shell; exactly two submissions:
$env:FIREWATCH_RUN_PAID_VERIFICATION='1'
node scripts/verify-live-apis.mjs
```

Optional `FIREWATCH_VERIFY_CAPTURE_OUTPUT=1` records credential-screened model
output only in the private temporary budget file for diagnosis; leave it off for
routine use. Never run either paid script in normal CI. The older
scripts/chat_live_smoke.py was inspected but not separately executed: it would
consume more paid calls/searches and does not exercise the HTTP endpoint.

## Deployment readiness audit

| Item | Status | Evidence / requirement |
|---|---|---|
| FastAPI startup, liveness/readiness, shutdown | PASS | Both process/HTTP smoke modes |
| Readiness meaning | PASS | Initialization probe; provider/ML availability checked separately in status |
| Separate API and FIRMS owner | PASS | GETs cache-only; separate CLI/lock/loop; owner stopped |
| Persistent cache/SQLite paths | PASS locally | Configurable paths, atomic cache, leases, restart tests |
| Linux persistent-volume permissions/locking/fsync | NOT VERIFIED | Must test actual deployment filesystem and account |
| s390x dependency resolution | PASS as a dry-run only | Locked no-dev, no-build target resolution below |
| LinuxONE binary imports/runtime/TLS | NOT VERIFIED | No s390x host was available; Windows/x86 CI is not proof |
| Frontend build | PASS locally | Locked Node tooling/test/typecheck/build |
| Native frontend build on s390x | NOT VERIFIED | Prefer existing CI-built static assets; do not assume native build-tool support |
| California location/boundary assets | PASS in checkout | Mount/include frontend/public/data; backend wheel alone does not package these |
| Environment injection / secret separation | PASS locally | Canonical settings, ignored dotenv/cache, no frontend credentials |
| Hardcoded Windows production paths | PASS | None found in backend/app or frontend/src |
| Production CORS/HTTPS/authenticated gateway | BLOCKED | Local-only setup; no public authenticated backend deployed |
| Main Pages deployment trigger | PASS by inspection | All main pushes; no paths restriction; static frontend only |
| Predictions/SHAP | BLOCKED | Real artifact/service contracts unavailable; no substitutes |
| Chat end-to-end reliability | FAIL | Timeout, research revalidation and remaining question coverage unresolved |
| Image secret exclusion | NOT VERIFIED | No image or Dockerfile created; future build context must exclude dotenv/caches/QA evidence |

Resolution-only command (does not install or prove execution on s390x):

```powershell
uv sync --locked --no-dev --python-platform s390x-unknown-linux-gnu --no-build --dry-run
```

Next: authorize a separate small live verification budget to recheck corrected
research/preparedness and elevated-risk behavior, remaining science/emergency
questions and unsupported suggestions. Then verify LinuxONE Python/native imports,
provider egress, CA assets and persistent-directory ownership/locking. Decide
deployment mounts, single refresh-owner supervision, HTTPS/CORS/authenticated
gateway and secret injection before proceeding with Docker. No paid hosting or
container implementation is authorized by this verification report.
