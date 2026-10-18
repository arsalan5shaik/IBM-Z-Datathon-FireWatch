# Docker / LinuxONE verification record

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

The s390x backend suite and additional emulated frontend build-tool check are
recorded below when completed. Image identities refer to the final runtime builds;
locally built test/compatibility images are not deployment releases.

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
