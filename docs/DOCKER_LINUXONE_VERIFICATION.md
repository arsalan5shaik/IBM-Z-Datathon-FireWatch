# Docker / LinuxONE verification record

## October 18 repair: current main integration

PR #13 was synchronized by a normal merge of `origin/main` at
`08198b5216c15d98d9d8c6f89f212ed450c62ce3` (merge commit `97ac544`), including merged
PR #12 and PR #14. The feature worktree was clean first; the merge had no
conflicts. Chatbot production code matches main; no model/dependency/threshold
changes were introduced by this repair.

Confirmed causes and targeted changes:

- The two frontend failures reproduced after merging main (62 passed, 2 failed).
  The SHAP test assumed demo log-odds even with an API configured. API mode already
  correctly requires the model endpoint's declared output scale; the test now
  asserts that safeguard explicitly. A separate demo test preserves the synthetic
  model's existing log-odds explanation. No real ERC-G/SHAP contract was changed.
- The sample-provider test imposed an unjustified >40% Low distribution and read
  API-mode classification from its environment. It now explicitly selects demo
  mode and verifies finite normalized scores, 168-hour shape, fixture/sample and
  uncalibrated metadata, and illustrative demo category endpoints. Existing
  `risk.integration.test.ts` separately verifies API scores remain unclassified.
- Docker Desktop reproduced a separate sample-grid test timeout with default
  Vitest concurrency. The same complete suite passed with two concurrent workers.
  Only the frontend test-image command now bounds concurrency; no timeout,
  assertion, prediction value or production build behavior was weakened.
- The historical Windows failure was
  `test_client_disconnect_cancels_model_work_and_releases_shared_lease`
  (`39088105291`, 353 passed/1 failed). Its fixed 50 ms disconnect could happen
  during weather preflight, before the mock model's cancellation handler existed.
  Main's PR #14 already replaces that assumption with a model-start event and
  checks the sole concurrency lease is released. That fix was preserved. An
  additional event-driven regression disconnects during held provider preflight:
  provider cancellation and lease cleanup must succeed while model calls remain
  empty. No cancellation exception was suppressed and no sleep was added.
- Compose smoke now explicitly checks that healthy processes can coexist with
  FIRMS `unavailable`, `stale=true`, `credentials_missing`, and no success timestamp.
  Heartbeat health is not presented as ingestion freshness. Existing FIRMS tests
  also cover stale-cache retention after provider errors.
- The optional full local s390x suite exposed one further test-startup race:
  444 passed, but the spawned process-lock helper missed its 15-second readiness
  deadline while importing the entire FastAPI integration module under QEMU.
  The same lock/recovery test passed in isolation. Its helper now lives in a
  lightweight module importing only the real filesystem lock; readiness and
  recovery assertions, deadlines and production locking code remain unchanged.

Completed repair checks on the merged source:

| Check | Actual result |
|---|---|
| Frontend dependency installation, typecheck, production build | PASS locally; Docker uses the same lock |
| Frontend suite, host and Docker test image | 66 passed in each environment |
| Full backend suite, Windows Python 3.11 | 445 passed, one upstream deprecation warning |
| Full backend suite, amd64 Python 3.12 container | 445 passed, one identical warning |
| Windows cancellation stress | 20 independent pytest processes; both phase-specific tests passed each time (40 cases) |
| Backend Ruff lint and formatting | PASS on Windows and amd64; deployment helpers also pass |
| FastAPI subprocess smoke, unavailable and fixture modes | PASS on Windows and amd64 |
| Both runtime images, amd64 and s390x | Built successfully with the existing pinned bases and unchanged dependency locks |
| Emulated s390x Node dependency/typecheck/production build | PASS with the existing CSS-minification fallback |
| amd64 and QEMU s390x Compose lifecycle and provider-error/liveness distinction | PASS on both architectures |
| Browser against QEMU s390x frontend/backend | PASS; no JavaScript errors, status 200, unavailable fires 503 and chat denied 403 |
| Runtime image layers, both architectures | PASS; no dotenv, local state or embedded credential environment values |

The full s390x suite, Compose/browser rechecks and final CI outcomes are recorded
with execution evidence in
[PR #13](https://github.com/arsalan5shaik/IBM-Z-Datathon-FireWatch/pull/13).
The original record below is historical: its test failures, artifact identities
and archive describe the initial implementation and are not current release
results. Native IBM LinuxONE deployment remains unverified; all local s390x
execution uses QEMU. Paid public chat remains disabled by default.

## Historical initial verification (October 17)

Verified during October 17, 2026 America/Chicago (October 18 UTC). These results
describe actual local builds and execution; no IBM LinuxONE host was supplied.

## Scope and isolation

- Implementation baseline: `origin/main` at
  `a40957177368333ce360b4ee70046da3d4741625`.
- Dedicated branch: `JS_feat/docker-linuxone`, in its own Git worktree. Existing
  main/chatbot/ML worktrees and their uncommitted files were not modified.
- PR #12 was open during inspection. A tracked snapshot at
  `8d971b3a2d5d233d53c5e20d8d0a589bc20e6a7f` was exported with `git archive` to a
  separate temporary directory; Docker files were overlaid there for compatibility
  testing only. Both amd64 images built and its complete Compose lifecycle smoke
  passed. The chatbot branch continued changing; this result covers that exact
  snapshot, not uncommitted or future changes. No chatbot branch changes were
  incorporated into the implementation branch.
- Docker Desktop 28.4.0, Buildx 0.28.0, BuildKit 0.24.0 and Compose 2.39.4 on
  Windows/amd64. Linux engine reports `x86_64`; binfmt/QEMU provides s390x execution.

## Results

| Component | Status | Evidence and limits |
|---|---|---|
| Backend Docker image | PASS | Locked full runtime dependencies installed; non-root image built for both architectures |
| Frontend Docker image | PASS | Locked npm installation, TypeScript and Vite production build; target-architecture Nginx |
| Docker Compose | PASS | Configuration validation and actual three-service lifecycle |
| API container startup | PASS | `/health/ready` and proxied `/api/v1/status` respond successfully |
| FIRMS worker separation | PASS | Independent process, cache writes, disabled API scheduler; no provider key used |
| Persistent storage | PASS | Cross-service SQLite write/read and shared cache retained after container removal/recreation |
| Secrets isolation | PASS | Every runtime layer scanned, fake local dotenv canaries excluded; no real secrets used |
| `linux/amd64` build | PASS | Both runtime images built and loaded |
| `linux/s390x` build | PASS | Both runtime images built and loaded with s390x manifests and actual s390x native wheels |
| `linux/s390x` runtime | PASS (QEMU) | API reports `runtime_arch=s390x`; full Compose smoke passes under emulation |
| LinuxONE host deployment | BLOCKED | No host/context/SSH deployment target provided; native IBM Z execution remains unverified |
| Chatbot branch compatibility | PASS (snapshot) | amd64 build and Compose smoke of tracked `8d971b3`; no paid chat acceptance claim |
| ML integration compatibility | PENDING | Existing JSON reader/publisher contract preserved; no final model/artifacts/SHAP contract supplied |

Actual smoke output for each architecture:

```json
{"result":"PASS","platform":"linux/amd64","runtime_arch":"x86_64","providers":"no credentials; no paid/live calls","checks":"health, proxy, assets, SPA, chat denial, isolation, shared cache, SQLite, recreation persistence, graceful stop"}
{"result":"PASS","platform":"linux/s390x","runtime_arch":"s390x","providers":"no credentials; no paid/live calls","checks":"health, proxy, assets, SPA, chat denial, isolation, shared cache, SQLite, recreation persistence, graceful stop"}
```

These checks used missing-provider behavior, not fake live data. Provider caches
recorded `credentials_missing`, no success timestamp, and unavailable/stale state.
No NASA, OpenAI, hosted search or on-demand weather verification was requested.

A real headless Chrome browser loaded the UI served by the emulated s390x stack.
UI requests reached FastAPI through `/api/v1`: status 200, fires/forecasts 503 for
missing data, and chat 403. No browser JavaScript errors occurred. External tiles
and on-demand weather routes were blocked for this test, so it is not live map or
provider verification. The optional `deploy/browser-smoke.mjs` reproduces it.

## Dependency and test evidence

- Complete Python runtime: 26 locked packages installed with required hashes and
  binary-only mode on each target. Python 3.12.15, SQLite 3.46.1 and OpenSSL 3.5.7
  executed inside the s390x image. Imports of `jiter` and `pydantic_core` succeeded.
- Native wheels: `jiter==0.17.0` and `pydantic-core==2.50.1`, CPython 3.12,
  `manylinux_2_17_s390x`. No compiler or native ML/geospatial libraries were added.
- `uv==0.13.1` also installed and executed as `s390x-unknown-linux-gnu` under
  emulation; locked runtime/dev exports succeeded when forcing BUILDPLATFORM=s390x.
- Backend amd64 suite: **354 passed**, one existing Starlette/httpx deprecation
  warning. Network disabled for the test container; tests also block real HTTP
  provider transports. Ruff lint and format pass (73 existing backend Python files).
- Full backend s390x suite: **354 passed**, one identical deprecation warning,
  **491.12 seconds** under QEMU, with network disabled. This includes forecast
  publication/recovery, SQLite indexes, POSIX process locking, API contracts,
  provider mocks and chatbot unit tests; it is not live API acceptance.
- Backend process smoke: both normal missing-data mode and explicit fixture mode
  passed, including startup/readiness, errors, CORS, OpenAPI and graceful shutdown.
- Deployment Python helpers: Ruff lint and format pass using backend configuration.
- Frontend: **60 passed, 2 failed** out of 62 on unchanged main source. Failing
  assertions: `src/lib/assistant.test.ts:57` expects `log-odds` in SHAP prose while
  the implementation requires the model's declared scale;
  `src/mock/sampleProvider.test.ts:49` expects low-risk category counts while
  category thresholds are pending. These unrelated tests were not changed/skipped.
  The CI frontend-test job intentionally exposes these failures.
- Frontend TypeScript and production Vite build pass. Existing native-config
  extension warning and npm build-tool deprecation notices remain visible.
- Dockerfile Buildx checks and Compose validation pass.
- Layer audit scanned all layers of both architecture images: backend 10 layers,
  frontend 9 layers. Local dotenv files contained a non-secret
  `FIREWATCH_DOCKER_EXCLUSION_CANARY` during builds; the canary, dotenv files,
  provider caches, local virtualenvs and SQLite files were absent from every layer.
  This is an exclusion test, not an exhaustive secret detector or CVE scan.

An additional emulated native frontend build exposed a real build-time blocker:
locked `lightningcss==1.33.0` has no linux-s390x native module. The Docker-only Vite
configuration disables CSS minification on s390x builders (retaining PostCSS,
JavaScript minification and the complete lock). After the fix, s390x Node 24 ran
`npm ci`, TypeScript and the complete production Vite build successfully. CSS grew
from approximately 40.9 KB to 55.1 KB for the app bundle (gzip 9.6 KB to 10.8 KB).
Cross-building on amd64 keeps the normal minifier. This test ran actual s390x
tool binaries under QEMU; it does not establish native IBM hardware execution.

Image identities refer to the final runtime builds;
locally built test/compatibility images are not deployment releases.

## Local image handoff

| Local image | Image identity |
|---|---|
| `firewatch-backend:amd64` | `sha256:33d4c042155e1fd634a51660a385ebe4d1d0d2facb130d628489851c6c9e9e9e` |
| `firewatch-frontend:amd64` | `sha256:7d97212495fd3a533a5cb6713819a9c8c542dee04baec3ceef00c11d0dbf986f` |
| `firewatch-backend:s390x` | `sha256:c0ea1d557bcd62885f73e3d412d241f7da9cbcb81f403f31e7ac8ba51286ae44` |
| `firewatch-frontend:s390x` | `sha256:300aabad6eadb51f5a7a34bb00ae51572e00bfd62f7425e123c736f8402a0d28` |

The s390x identities are the platform manifests after archive reload. The build's
attestation index has a different digest; `save --platform` excludes that wrapper.

The final local s390x frontend was additionally built with
`--build-arg BUILDPLATFORM=linux/s390x`, so the handoff image contains the assets
produced by the verified emulated s390x Node toolchain (CSS-minification fallback).
Default cross-builds may have different provenance/image identities and minified
CSS, while still running the same target-architecture Nginx and application code.

Both s390x images were saved into an **88,678,912-byte** local Docker archive and
successfully loaded back using `docker image load --platform linux/s390x`:

```text
firewatch-s390x.tar
SHA256 a3804d22a30ab879c84208debb62f22dbff4060a75cdfd67b5a503131334c8cc
```

The archive and checksum are outside Git in the local task's temporary artifact
directory. Transfer them through an approved channel to the LinuxONE host and
verify the checksum before loading. No registry images were published.

## Remaining deployment gates

Native IBM LinuxONE execution, the target host filesystem/TLS/egress/capacity, and
real ML inference/artifact integration are unverified. Public paid chat is
deliberately blocked until a separately authenticated HTTPS gateway is supplied.
The frontend's two baseline test failures remain an integration/merge gate.
No images were published to any registry, no deployment was made to a remote
host, and no changes were merged into main or PR #12.

Build/start/test commands, environment rules, backup, rollback and native host
acceptance are in [DOCKER_LINUXONE.md](DOCKER_LINUXONE.md). CI execution links and
the final check status are recorded in the Docker pull request; CI configuration
alone is not counted as a passed run.
