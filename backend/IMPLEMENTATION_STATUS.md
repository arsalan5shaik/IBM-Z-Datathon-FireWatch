# Backend implementation status

Updated: 2026-10-17. PR #1 merged as `72ceaa5`; remote main verified and post-merge
smoke passed. The requester explicitly authorized autonomous work and merges under
the existing check/review gates. Forecast contracts are implemented on
`JS_feat/forecast-contracts`; current feature details below supersede the original
foundation checkpoint retained for history.

## Repository inventory and prerequisites

- Read `FireWatch_Backend_Architecture.md` in full as the primary specification.
- `FireWatch_Frontend_Spec.md` is absent from the checkout, fetched main,
  fetched frontend branch, and locally available Git history for that path.
  Asked the requester for its location or permission to use `02_API_CONTRACT.md`
  and `03_UI_DESIGN.md` instead. After the requester said "continue", resumed with
  those existing documents and explicitly stated that interpretation. The missing
  file was not fabricated; discrepancies remain documented for team alignment.
- Read README and the four numbered handoff documents; inspected frontend
  package scripts, App, and FireMap from `origin/feature/firewatch-frontend`.
  The frontend branch currently displays a basemap without backend calls.
- Initial working tree was clean on main at `8f97f25`. Fetched remote changes
  and fast-forwarded main to `658dee116c9872173dd85b1a2c55fe7983cb382b`.
- Created `JS_feat/api-foundation` from that synchronized main. No teammate
  files were edited, staged, or discarded. Remote dataset changes were accepted
  by the fast-forward, not authored by this implementation.
- Main contains documentation, an HTML wireframe, and a combined historical
  CSV. No backend, ML implementation, shared schemas, test runner, CI workflow,
  CODEOWNERS, contribution policy, or AGENTS.md was found in the inspected tree.
- Remote `ES_feat` contains ML-owned enriched training/holdout CSVs. These are
  datasets, not hourly prediction artifacts. They will not be changed.
- GitHub authentication works outside the sandbox as `Jashan-tech`, with push
  permission and without admin/maintain permission. Main reports
  `protected=false`; the applicable branch-rules endpoint returned `[]`.
  Merge, squash, and rebase mechanisms are enabled. Planning commit `ca25177` and
  tested core commit `b1f137d` were pushed and verified with `git ls-remote`.
- No existing required checks/reviews were reported by the inspected branch
  rules. This does not waive the task's green-CI and merge-authorization gates.
- Initially detected Python 3.10.9. Installed uv 0.13.1 in a temporary bootstrap
  directory and managed Python 3.11.17; created ignored `backend/.venv` and a
  committed `backend/uv.lock`. No system Python was replaced. No LinuxONE host or
  s390x runtime has been supplied or verified.
- GitHub Actions policy inspection returned HTTP 403 for this account. Workflow
  execution/check results will be verified directly; no policy bypass requested.

## Contract differences requiring coordination

The primary backend specification takes precedence for new backend design.
Existing shared interfaces will not be silently rewritten.

| Topic | Existing numbered handoff | Primary backend specification / proposed handling |
| --- | --- | --- |
| Forecast | Whole-state seven-day risk snapshot, potentially coarse grid | 3,000 m EPSG:3310 grid and 168 hourly JSON slots; do not reinterpret seven-day model output as hourly output |
| Routes | `/risk`, `/fires`, `/places`, `/locations/{id}` under `/api/v1` | `/forecasts/risk`, `/fires/live`, `/places/search`, cell/explanation routes; publish migration proposal before frontend integration |
| Status | `status:ok`, snapshot timestamps, fixture/live mode | Per-subsystem availability, completeness and stale flags; propose explicit no-data state, null model/source timestamps, never fake freshness |
| ML handoff | `data/public/risk.geojson`, `models/features.json` | Versioned artifacts in configured `shared/data`; geometry stored once, stable cell IDs and version metadata |
| Scores | `uncalibrated_model_score`, seven-day hotspot occurrence target | `relative_risk` or justified `calibrated_probability` with explicit target; no automatic semantic conversion |
| Storage | No database by default | SQLite metadata when persistence is implemented; no database dependency needed for foundation |
| Runtime | FastAPI/Flask/stdlib fallback | Python 3.11+ FastAPI/Pydantic v2; verify native dependencies on s390x before deployment claims |
| Coverage | Illustrative hotspot-influence overlay | Optional official incident/perimeter feed; never represent illustrative buffers as official perimeters |

There is no existing `shared/` directory or checked-in schema owner declaration.
The backend specification assigns authoritative grid geometry, prediction
generation, version/score semantics, and explanations to ML. Backend will propose
schema/fixture files and validation, but must obtain agreement before changing an
existing teammate contract. No shared contracts have been created or changed.
Scheduler ownership remains unconfirmed: propose one external backend job calling
a documented ML entry point; until agreed, no generator invocation or automatic
startup scheduler. No real grid, hourly predictions, SHAP artifacts, or generator
entry point have been provided.

## Ordered implementation plan and gates

Each row requires a separate exact-named branch, incremental conventional commits,
verified pushes, full applicable tests/Ruff/smoke checks, a PR to current main,
green CI, authorized merge, remote merge verification, main synchronization and
post-merge smoke before the next row starts. A pending/blocked merge stops the
sequence. Tests use clearly labeled mocks and no live provider dependency.

| Order / branch | Concrete scope | Acceptance gate |
| --- | --- | --- |
| 1 `JS_feat/api-foundation` | App factory/lifespan, settings, versioned router, status/errors, CORS, request IDs, health probes, pytest/Ruff/CI, startup docs | Boot/shutdown; no-data status; readiness; invalid settings; CORS; structured errors/redaction; OpenAPI; HTTP smoke |
| 2 `JS_feat/forecast-contracts` | Proposed JSON schemas and mock examples; ML grid loader/index; hourly validation; bbox risk/cell endpoints; UTC/local-day semantics | Bad/missing/duplicate/NaN records; versions; bbox limits; GeoJSON; DST/partial days; representative performance smoke |
| 3 `JS_feat/rolling-window` | Manifest-last publication; atomic writes; external single-owner job; generation adapter; revision invalidation; last-known-good recovery | Bootstrap; 167+1; missed hours; duplicate job/lock; corrupt file; revisions; crash points; UTC/DST boundaries; no inference on GET |
| 4 `JS_feat/nasa-firms` | Official adapter, deduplication/normalization, persisted recent hotspot cache and GeoJSON; source freshness | Mock success/empty/429/timeout/5xx; acquisition vs ingestion timestamps; stale behavior; FRP units |
| 5 `JS_feat/weather-wind` | Batched sampling/provider adapter; cache/revisions; weather and wind routes; documented units/direction | Provider failures; units; UTC validity; bbox; cache reuse; missing values; revision changes |
| 6 `JS_feat/location-search` | Local/cached CA places and boundaries; stable IDs; ZIP/ZCTA caveats | Ambiguous names; case/limit validation; approximate ZIP; out-of-state rejection; boundary provenance |
| 7 `JS_feat/shap-api` | Read validated ML explanation artifacts; selected cell/hour transport and metadata | Missing artifact; model/feature mismatch; correct raw/log-odds scale; no invented factors |
| 8 `JS_feat/chatbot` | Bounded allowlisted backend retrieval, LLM tool orchestration, source/time citations, safe no-data handling | Mock LLM/tools; injection; invented-fact prevention; no key; timeout; invalid context; emergency limits |
| 9 `JS_feat/deployment-ci` | Reproducible runtime/runbook; s390x evidence; explicit scheduler ownership; deployment smoke/rollback | Verified startup/health/persistence/shutdown; CI; actual LinuxONE compatibility evidence or explicit environment blocker |

## Foundation file and test plan

Original foundation file plan (implemented below):

- `backend/pyproject.toml`: Python >=3.11, FastAPI/Pydantic settings/HTTPX/Uvicorn,
  pytest/Ruff dev tools, package discovery and test/lint configuration.
- `backend/app/__init__.py`, `main.py`: injectable app factory, lifespan state,
  versioned router wiring, restricted CORS and centralized errors/request IDs.
- `backend/app/config.py`: validated environment settings; explicit repo-root
  resolution independent of cwd; secret types; fixed 168 hours and 3,000 m;
  bounded timeout/cache parameters; jobs disabled by default.
- `backend/app/dependencies.py`: app-local settings/status dependencies.
- `backend/app/api/v1/status.py` and package initializers: `/api/v1/status`,
  `/health/live`, `/health/ready`; no model/provider calls during GET or startup.
- `backend/app/schemas/status.py`, `errors.py`: typed availability, nullable
  provenance, forecast completeness, and stable error envelope.
- `backend/app/errors.py`: structured HTTP/validation/unexpected errors without
  exception text, credentials, input bodies or sensitive URL/query logging.
- `backend/.env.example`, `backend/README.md`, root README backend setup link,
  `.gitignore`: setup, explicit CORS origins, no-data behavior, private runtime
  paths and artifact ignores. Preserve existing README content.
- `.github/workflows/backend-ci.yml`: supported Python matrix, install backend,
  pytest, Ruff check/format check and process smoke; no live provider calls.
- `backend/scripts/smoke.py`: loopback-only child server probe, bounded startup,
  verify status/liveness/readiness and clean shutdown.

Tests added alongside implementation units:

| Test file | Acceptance assertions |
| --- | --- |
| `backend/tests/unit/test_config.py` | Missing provider keys allowed; invalid origins/wildcards/URLs rejected; invalid fixed grid/horizon/timeouts rejected; configured paths independent of cwd; secrets excluded from repr |
| `backend/tests/integration/test_health.py` | Factory isolation and lifespan; live=200 after boot; readiness reflects actual initialization; no-data forecasts unavailable with 168 missing hours and null provenance; provider/key presence never implies live data |
| `backend/tests/integration/test_errors.py` | Stable 404/405/422/500 envelopes; bounded safe validation details; unexpected exception details/input/secrets absent; request ID present; logs redact request query/body |
| `backend/tests/integration/test_cors.py` | Explicit configured origin/preflight accepted; unknown origin denied; credentials disabled; error responses retain allowed-origin headers |
| `backend/tests/contracts/test_openapi.py` | Required paths and typed response/error schemas documented; no unimplemented forecast success claims; status response validates against declared schema |
| `backend/tests/conftest.py` | Isolated app/settings/client and temporary paths; no dependence on developer `.env` or provider credentials |

Validation commands from `backend/` using the Python 3.11.17 virtual environment:
`python -m pytest`, `python -m ruff check .`,
`python -m ruff format --check .`, `python scripts/smoke.py`.
Actual latest results: **46 passed**, Ruff check passed, Ruff format check passed
(20 Python files), and process smoke passed all eight checks including graceful
shutdown. Earlier core-only run: 42 tests passed. Tests emit one upstream
Starlette warning that HTTPX TestClient compatibility is deprecated; it is not
suppressed. No provider network requests or skipped tests.

## Current milestone

### Feature 2: forecast contracts

- Foundation: PR #1 merged, main synchronized, post-merge smoke passed. Autonomous
  authorization now established by the requester's explicit instruction.
- Branch: `JS_feat/forecast-contracts`, based on remote main `72ceaa5`.
- A concurrent checkout changed the shared working tree to main after branch
  creation. Own commit `78d6cf1` landed on local main only; remote main was never
  pushed. Preserved the commit unchanged by fast-forwarding the feature branch in
  an isolated worktree and confirmed its remote push. No reset/discard/force push.
  Work now runs in the dedicated `firewatch-backend-worktree` under the OS temp
  directory to avoid branch switches from other sessions. Use a normal merge for
  this feature so local main's preserved commit remains an ancestor of remote main.
- Implemented: strict hourly/manifest contracts, JSON schemas and labeled samples,
  geometry validation and bucket spatial index, bounded hourly cache, bbox risk
  GeoJSON and 168-slot cell history, UTC/California DST and partial-day semantics.
- Tests: 95 pytest tests passed, Ruff lint passed; formatting and both process
  smoke variants rerun before PR. Mock provider transports only; no live inference.
- Scale smoke: 47,000 synthetic index polygons, 12-cell query, build 8.765 s with
  tracemalloc enabled, peak Python allocation 63.64 MB, p50/p95 lookup 0.798/0.849 ms.
  This is a Windows index microbenchmark, not full API latency, a real CA land grid,
  or LinuxONE evidence. Fixture sample cells were generated as exact 3,000 m squares
  in EPSG:3310 using temporary developer-only pyproj; no runtime geospatial package.
- Contract additions are explicitly proposed in shared/README.md and the PR:
  data_mode on all artifacts, feature_version on manifest, optional immutable
  artifact references. No existing shared contract or frontend/ML code changed.
- Real ML artifacts and authoritative grid/CA boundary still absent; APIs fail
  closed with 503. Fixtures require explicit opt-in and always retain fixture labels.
- PR/CI/merge: pending final feature handoff; do not start rolling-window until
  green CI, normal merge, remote-main verification and post-merge smoke.

### Historical foundation checkpoint

- Feature: API foundation implemented; awaiting remote verification and merge gate.
- Branch: `JS_feat/api-foundation`, based on synchronized main `658dee1`.
- Completed: app factory/lifespan, validated environment configuration, restricted
  CORS, versioned status router, health probes, structured errors/request IDs,
  safe JSON request logs, pytest unit/integration/contract tests, locked dependencies,
  startup/environment docs, OpenAPI examples, process smoke and backend CI workflow.
- Status explicitly reports no available data, null source/model metadata and 168
  missing hours. Readiness covers API lifespan; data readiness is separate. No ML
  generation, provider ingestion, database writes or scheduler is enabled.
- Tests: 46 passed; lint/format/smoke passed locally. Both push and PR CI runs
  passed on Linux Python 3.11/3.12 and Windows Python 3.11 at `5f04918`:
  [push run](https://github.com/arsalan5shaik/IBM-Z-Datathon-FireWatch/actions/runs/39058928540),
  [PR run](https://github.com/arsalan5shaik/IBM-Z-Datathon-FireWatch/actions/runs/39058958915).
- Commit/push: `ca25177` planning, `b1f137d` core, and `5f04918` docs/CI are confirmed
  remote. This documentation-only checkpoint is recorded in Git history; its
  remote checks must also pass before merge.
- Latest main fetch: still `658dee1`; no concurrent changes to integrate.
- PR/merge: [PR #1](https://github.com/arsalan5shaik/IBM-Z-Datathon-FireWatch/pull/1)
  is open and was CLEAN/MERGEABLE with all checks green at `5f04918`. No merge
  attempted. GitHub reports no required reviews/checks or applicable rulesets,
  but technical push access alone does not establish team authorization for an
  autonomous merge. Following architecture section 11, request explicit merge
  authorization; then recheck current checks/rules/main, merge normally, verify
  remote main, synchronize and smoke-test before `JS_feat/forecast-contracts`.
- Integration contract changes: new operational routes/OpenAPI are implemented
  under the primary backend spec; status differs from the older frozen handoff as
  documented above. No existing shared JSON schemas or frontend/ML files changed.
  PR description will carry the migration notice for frontend/ML reviewers.
- Later integration prerequisites: authoritative ML grid/hourly artifacts and
  shared-contract agreement, single scheduler owner, and actual s390x environment.
