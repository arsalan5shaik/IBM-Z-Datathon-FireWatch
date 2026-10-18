# FireWatch AI assistant

## Setup (backend credentials only)

Install the locked environment from `backend/`: `uv sync --locked`. Copy
`.env.example` to `.env` locally, then set `OPENAI_API_KEY` in that file or the
server environment. Never commit it, put it in a Vite variable, browser storage,
URL or frontend request. `LLM_API_KEY` remains a compatibility fallback.

Default model: **gpt-5-mini**, official Python SDK **2.54.0**, **Responses API**.
The exact supplied instructions are version controlled in
`app/prompts/firewatch_system.py`. They are passed unchanged on every model call,
with additional transport instructions. No model is silently substituted.

| Environment variable | Default | Purpose |
|---|---|---|
| OPENAI_API_KEY | unset | Backend-only key; missing => explicit 503 |
| OPENAI_MODEL | gpt-5-mini | Configurable Responses model |
| OPENAI_TIMEOUT_SECONDS | 25 | Timeout per SDK attempt |
| OPENAI_MAX_OUTPUT_TOKENS | 2500 | Per-response visible + reasoning token cap |
| CHAT_MAX_HISTORY_MESSAGES | 10 | Untrusted conversation context, never evidence |
| CHAT_MAX_MESSAGE_LENGTH | 2000 | Current message character limit |
| CHAT_MAX_TOOL_CALLS | 8 | Total server tool executions including preflight |
| CHAT_MAX_RESEARCH_CALLS | 1 | Bounded hosted research attempts |
| CHAT_TIMEOUT_SECONDS | 90 | Whole request deadline |
| CHAT_RATE_LIMIT_PER_MINUTE | 6 | Per-client rolling-minute requests |
| CHAT_DAILY_REQUEST_LIMIT | 100 | Global rolling-24-hour requests on this host |
| CHAT_MAX_CONCURRENT_REQUESTS | 2 | Shared active leases |
| CHAT_ACCESS_MODE | local | local or trusted_proxy |
| CHAT_PROXY_TOKEN | unset | 32+ character server/edge secret in proxy mode |

The SDK uses one retry and low reasoning effort. Research additionally caps
built-in tool calls at one per Responses request. Retry attempts may incur cost;
request quotas are not dollar budgets. Failed requests still consume a quota.

Local startup:

```bash
cd backend
uv run --no-sync uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
# Separate terminal:
cd frontend
npm ci
npm run dev
```

Set backend `CORS_ORIGINS=["http://localhost:5173"]` and open
`http://localhost:5173/?api=http://127.0.0.1:8000/api/v1`. Open the launcher or a
location panel's existing “Ask AI about this area” action. No risk model is needed
to use weather, location lookup or historical research. API errors never silently
become offline answers. With no backend URL, clearly labeled demo/offline mode
continues to use the existing loaded-data helper and performs no online research.

## API and orchestration

`POST /api/v1/chat` accepts:

```json
{
  "message": "What is the wind in Stockton tomorrow afternoon?",
  "location_id": "place-ca-stockton",
  "selected_hour": "2026-10-17T23:00:00Z",
  "history": []
}
```

Use a current aligned UTC selected hour when running that illustrative request.
History contains only `{role:user|assistant, content}`. Legacy architecture
`context:{place_id,cell_id,hour,incident_id}` is accepted, with contradictory
context rejected. Internal reasoning and credentials are never returned.

The typed response contains `answer`, `sources`, `tools_used`, `location`,
`requested_time`, `data_freshness`, `limitations`, `suggested_questions`, `model`,
`mode`, and compatible `grounding`. Sources distinguish FireWatch from external
research and preserve real URLs, titles, provider, retrieval time, available
valid/observation/generation/fetch times, freshness, scope and weather sample.
Publication times are explicitly unknown if the search provider does not supply
them. They are never inferred from a page title or model memory.

`chat_service.py` runs a bounded Responses function-call loop. Server preflight
retrieves relevant FireWatch data before asking for synthesis. Functions use
`LocationStore`, `WeatherCache`, `FireCache` and `ForecastStore` directly; no
duplicate loopback HTTP, model training, inference or forecast publication.
Strict Pydantic arguments reject unknown fields/functions, duplicate JSON keys,
nonfinite values, invented IDs and unaligned/out-of-horizon times. Tool output
is capped at 60,000 characters, history at 20,000 characters, returned JSON at
64 KB and the UI at 40 messages. Risk queries cap matching cells and report
coverage; large areas must be narrowed. No statewide grid parsing is introduced.

Supported tools: `search_locations`, `resolve_time`, `get_weather`, `get_wind`,
`get_detections`, `get_risk`, `get_shap`, `research_official_sources`.
SHAP is an explicit unavailable capability until a real contract/service exists.
Risk consumption is for the selected hourly artifact; it does not manufacture a
complete seven-day summary when artifacts are missing. Display geography is
not used as a fabricated prediction grid.

Time rules: absolute UTC on the wire; California local expressions use
America/Los_Angeles. Tomorrow without a clock means noon, afternoon 15:00,
morning 09:00, evening 18:00; interpretations are supplied to the model. Today
without a clock means the current hour. This weekend selects the upcoming
Saturday or current weekend day. Named repeated/nonexistent DST hours require
clarification. Explicit offsets are accepted as UTC hours. Follow-ups retain
prior user time intent; explicit new times override it. Historical research is
kept separate from the live forecast horizon. Forecasts never extrapolate past
current plus 168 future hours or fill provider gaps with invented values.

## Research and grounding

Uses Responses `web_search`, `external_web_access=true`, `tool_choice=required`,
`max_tool_calls=1`, and `include=["web_search_call.action.sources"]`. No custom
URL fetcher, browser key or arbitrary network tool exists. Domains are explicitly
allowlisted (CAL FIRE/California government, NWS/NOAA, NIFC/NASA/USGS/USFS,
AirNow/EPA, PubMed and selected official county emergency sites). This list is
deliberately bounded; other counties/journals may require a reviewed addition.

A research citation is accepted only if the response contains a completed actual
web-search call, its URL occurs in returned source records and in a URL citation
annotation, and it passes HTTPS/domain/credential/port/IP validation. No sources
are generated from model text alone. Source IDs are registered by the server and
validated in the final answer. Known unverified numeric claims and claims about
missing model/fire data are rejected; these checks and the prompt are defenses,
not a proof that every natural-language synthesis is correct. Source conflicts
remain available and the model is instructed to explain them.

Fresh FireWatch weather suppresses unnecessary research. Confirmed incidents,
official warnings, historical facts and safety questions require research rather
than treating FIRMS detections as official incident reports. Emergency domains
prioritize government and selected responsible county sources. Since provider
publication times are not verified, the server never asserts a current evacuation
order: it states the limitation, links retrieved official sources and directs
immediate danger to 911. Missing alerts never imply safety.

Official documentation checked during implementation:

- https://developers.openai.com/api/docs/models/gpt-5-mini
- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/api/docs/guides/tools-web-search

Responses/function calling/structured-output support is documented. Hosted search
uses the supported Responses controls with low reasoning, not minimal reasoning.
Local gpt-5-mini/search access was verified on 2026-10-18 with real credentials;
the complete live acceptance gate remains open. See the
[live verification report](../docs/LIVE_API_VERIFICATION.md). If
the configured model/tool is rejected, the API returns
`chat_model_or_tool_unsupported`; it does not switch models or fake research.

## Abuse controls and hosting

Default local mode requires a loopback peer, loopback Host and a loopback Origin
when supplied. Bind the local server to 127.0.0.1. CORS is an allowlist, not paid
API authentication. Do not expose this development mode behind a public proxy.

Public deployment requires `CHAT_ACCESS_MODE=trusted_proxy` and a separately
authenticated edge/gateway. Set the same strong `CHAT_PROXY_TOKEN` on the edge
and backend; after authenticating/authorizing the user, the edge must strip any
client-supplied `X-FireWatch-Chat-Auth` and inject its own matching header. Never
give this shared token to the browser. Block direct access to FastAPI; configure
trusted forwarded-header sources and a 64 KB request body limit at the edge.
No new accounts or paid hosting are provisioned by this feature.

Atomic SQLite quotas and expiring concurrency leases live in the existing
provider-cache directory. All Uvicorn workers must share this local persistent
filesystem. There is no Redis dependency. Multiple independent hosts need a
shared trusted gateway quota; per-host SQLite is not a distributed global budget.
Only hashed client identity and timestamps are stored; no conversations persist
in the quota DB. The SDK sends `store=false`. Complete user conversations and
provider error bodies are not logged by default. Avoid enabling SDK debug logs
in production. Client disconnection, clear, location/hour changes and deadlines
cancel work; already processed API calls may still be billed.

Set a small project spend limit and alerts in OpenAI Platform Settings/Limits
before entering a production key. Where available, configure a **hard spend
limit**, not just a notification budget, and monitor the Usage dashboard. Review
https://developers.openai.com/api/docs/guides/production-best-practices and the
linked spend-limit guide. FireWatch's request/output/research caps supplement
that account-level control. Provider 429 errors can mean quota or rate limits;
check the account limits and wait before retrying. Never retry indefinitely.

Pages remains a static build on every push to main, without path filters.
`VITE_API_BASE_URL` / runtime `?api=` and explicit `?demo=1` are preserved. Pages
cannot host FastAPI or the API key. No configured public HTTPS backend/gateway is
available, so the public AI remains BLOCKED/offline demo until that hosting exists.

## Integration status and verification

| Capability | Actual state |
|---|---|
| California locations | Available: authoritative catalog, boundaries, real IDs |
| Weather/wind | Available: real Open-Meteo cache used directly by tools |
| NASA FIRMS | Real two-product ingestion and cached chat reads verified locally |
| ML risk | Validated live-artifact consumer; real artifacts unavailable |
| SHAP | Unavailable; no authoritative service/contract connected |
| OpenAI Responses | Live gpt-5-mini verified; broader reliability acceptance FAIL |
| Hosted external research | Live retrieval verified; corrected multi-action path requires live revalidation |
| Public hosted chatbot | BLOCKED: HTTPS backend + authenticated gateway absent |

Unit tests mock OpenAI and never incur paid calls. Real browser tests use the
normal backend for missing-key behavior and an explicitly named test-only
`tests.browser_app` entry point for model-stub synthesis over **real** weather.
That harness never calls OpenAI and visibly labels its model as MOCK. Do not use
it for deployment. `frontend/scripts/verify-chat.mjs` exercises those two servers,
Stockton/Sacramento, source display, keyboard, unavailable data, outage recovery
and mobile UI. A mocked model is not live OpenAI or research verification.

Explicit optional paid smoke: `uv run --no-sync python scripts/chat_live_smoke.py`.
It prints BLOCKED with no key. With a configured key, it performs bounded Stockton
weather and Camp Fire research requests plus a no-cost scope refusal. It verifies
actual Responses results and citation metadata. It is never run in CI.

The 2026-10-18 live verification reached its 15-chat/three-action budget. Do not
run more paid tests under that authorization. The opt-in
`scripts/live_verification_server.py` and `frontend/scripts/verify-live-apis.mjs`
provide real-provider verification and private usage counters, not mock responses.
Native search may return multiple completed search/open/find actions despite the
requested `max_tool_calls=1`. The validator accepts completed actions and still
requires citations to match retrieved URLs and native annotations. Research-call
settings cap retrieval requests, not a guaranteed exact native action count.

## LinuxONE / s390x

No containers, model runtime or new geospatial dependency are introduced. The
official SDK is pure Python, but its `jiter` dependency and existing
`pydantic-core` are native Rust extensions. A binary-only download check succeeded
for Python 3.11 `manylinux_2_17_s390x` wheels: openai 2.54.0, jiter 0.17.0,
pydantic-core 2.50.1. Files were downloaded outside the repository. This checks
wheel availability only, not ABI behavior or the entire dependency tree.
Run `uv sync --locked`, imports, the full backend suite and a bounded real-key
smoke on the actual LinuxONE host; verify glibc, TLS/egress, writable shared cache,
SQLite locking and gateway access there. Runtime compatibility remains UNVERIFIED.
