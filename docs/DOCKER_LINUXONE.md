# FireWatch Docker and IBM LinuxONE

This deployment packages the real application from `main`. It provides a static
frontend/reverse proxy, a FastAPI API, and exactly one independent FIRMS refresh
owner. It does not train models, invent predictions, or enable public paid chat.
Run commands from the repository root unless stated otherwise.

## Architecture and boundaries

```text
browser -> 127.0.0.1:8080 -> frontend (Nginx, UID 101)
                              /        static Vite build
                              /api/*   backend:8000 (UID 10001)
                              /api/v1/chat* blocked with HTTP 403
                                             |
                           named runtime-data volume mounted at /data
                                             |
                              firms-worker (UID 10001) -> NASA
```

Only the frontend publishes a host port, bound to loopback by default. The backend
and worker have outbound connectivity for their providers. Neither is privileged;
all services drop capabilities, forbid privilege escalation and have read-only
root filesystems with a temporary `/tmp`. No Docker socket or host source tree is
mounted. `init: true` reaps children and forwards signals. Logs rotate at 3 x 10 MB
per container. Restart policy is `unless-stopped`; an unhealthy probe alone does
not trigger a Docker restart. Monitor health and disk capacity externally.

The API starts `app.main:create_app --factory` on `0.0.0.0:8000` without access
logs or trusted forwarded headers. Startup does not install dependencies or run
jobs. `JOB_ENABLED=false`, `SCHEDULER_OWNER=unassigned`, and
`ALLOW_FIXTURE_DATA=false` are enforced in Compose. FIRMS uses the existing
`FireCache.refresh()` via `deploy/worker.py`, with cooperative SIGTERM cancellation,
one polling loop, a persistent refresh throttle and the existing process lock.
Do not scale `firms-worker` or run another cron/CLI polling owner against this store.

## Prerequisites and reproducible builds

Use Docker Engine/Desktop with Linux containers, Compose v2 supporting `up --wait`,
Buildx with `--check` support, Git, and Python 3.11+ for host smoke/audit scripts
(stdlib only). Build/test downloads need access to Docker Hub, PyPI and npm. Normal
startup requires none of those registries. Keep sufficient Docker disk space for
both architectures and test images. Host Python is unnecessary for normal startup.

The Dockerfiles pin multi-platform base manifest digests. Python 3.12 uses Debian
Trixie; Node 24 uses Trixie for the build; production static serving uses Debian
Nginx 1.30 on Trixie. The inspected Bookworm Python 3.11/3.12 and Node 22/24 slim manifests did
**not** contain s390x. The selected Python/Node Trixie and Nginx manifests do.
Reinspect manifests when changing pins; do not infer architecture from a tag name.
Security updates require a reviewed digest refresh and rerunning the tests.

Backend builds run pinned `uv==0.13.1` on `BUILDPLATFORM` to export `uv.lock` with
`--locked`, preserving hashes. Target-platform pip installs the complete runtime
set with `--require-hashes --only-binary=:all: --no-deps`. Missing target wheels
fail the build; no dependency is silently removed or compiled. No compiler, uv,
development environment, tests or provider cache is copied into the runtime.
The test target adds only the locked development dependencies and repository tests.

Node tooling runs on `BUILDPLATFORM`; only architecture-independent HTML/CSS/JS
and geodata enter the target Nginx image. This supports cross-building on x86 and
native building on LinuxONE. `npm ci` uses `package-lock.json`, Playwright browser
downloads are disabled, and Vite is built with `VITE_API_BASE_URL=/api/v1` and
the Docker-specific `vite.docker.config.ts` (base `/`). Lightning CSS's locked
package has no s390x native binary: this configuration disables **CSS minification
only on s390x builders**, using the existing PostCSS pipeline while retaining
JavaScript minification. Native LinuxONE builds therefore emit somewhat larger
CSS; cross-builds on x86 retain the default CSS minifier. No dependency is removed
or substituted. The image is designed to be served from the site root. Browser code
never uses Docker service names. Missing assets return 404; other routes get SPA
fallback with absolute asset URLs. No frontend secret build arguments exist.

PowerShell or Linux shell (same build commands):

```sh
docker buildx build --platform linux/amd64 --target runtime --load -f backend/Dockerfile -t firewatch-backend:amd64 .
docker buildx build --platform linux/amd64 --target runtime --load -f frontend/Dockerfile -t firewatch-frontend:amd64 .
docker buildx build --platform linux/s390x --target runtime --load -f backend/Dockerfile -t firewatch-backend:s390x .
docker buildx build --platform linux/s390x --target runtime --load -f frontend/Dockerfile -t firewatch-frontend:s390x .
```

These commands load local images only; they do not publish a registry image.
Always specify `--target runtime`: the backend Dockerfile also has a test target.

## Configure and start

PowerShell:

```powershell
Copy-Item deploy/.env.example deploy/.env
# Edit deploy/.env: choose platform, IMAGE_TAG and optionally your NASA key.
# Example for the s390x images built above:
$env:FIREWATCH_PLATFORM='linux/s390x'
$env:IMAGE_TAG='s390x'
docker compose --env-file deploy/.env config --quiet
docker compose --env-file deploy/.env up -d --no-build --wait --wait-timeout 240
docker compose --env-file deploy/.env ps
Invoke-RestMethod http://127.0.0.1:8080/api/v1/status
```

Linux shell, including on an actual LinuxONE host:

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
# Edit deploy/.env: FIREWATCH_PLATFORM=linux/s390x and IMAGE_TAG=s390x on LinuxONE.
docker compose --env-file deploy/.env config --quiet
docker compose --env-file deploy/.env up -d --no-build --wait --wait-timeout 240
docker compose --env-file deploy/.env ps
curl --fail http://127.0.0.1:8080/api/v1/status
```

For a local native x86 build with default `IMAGE_TAG=local`, run
`docker compose --env-file deploy/.env build` before `up`. Compose defaults to
`linux/amd64`; set `FIREWATCH_PLATFORM=linux/s390x` explicitly on LinuxONE.
Shell environment overrides the env file, so remove stale overrides when switching
tags/platforms. Use a unique project name (`--project-name`) for independent stacks.

Frontend: `http://127.0.0.1:8080/`; API status through the same origin:
`http://127.0.0.1:8080/api/v1/status`. Backend readiness is internal
`http://backend:8000/health/ready`; it is not a browser address. Port 8000 is not
published. Public exposure requires an operator-supplied HTTPS edge/firewall and
a deliberate bind-address change. No hostname, SSH access or hosting is provisioned.

### Environment and credentials

`deploy/.env` is ignored by Git and excluded from the build context. Compose
interpolates only explicitly listed deployment variables; it does not inject an
entire developer `.env`. Do not copy `backend/.env` into an image. Avoid printing
expanded `docker compose config` or container inspection in shared logs with real
keys; those can reveal runtime environment values. Use `config --quiet` instead.
Protect dotenv files with host ACLs on Windows and mode 600 on Linux. Docker
administrators can read runtime environment; this is not a secret vault.

| Setting | Deployment behavior |
|---|---|
| `FIREWATCH_PLATFORM` | `linux/amd64` default; explicitly select `linux/s390x` |
| `IMAGE_TAG` | `local` default; choose the tag used for both images |
| `FIREWATCH_BIND_ADDRESS` / `FIREWATCH_PORT` | `127.0.0.1:8080` default |
| `NASA_FIRMS_MAP_KEY` | Injected only into the FIRMS worker; optional |
| `FIRMS_REFRESH_MINUTES` | 15 default; settings validate 10..1440 |
| `FIRMS_SOURCES` | Both NOAA-20 and NOAA-21, explicit JSON in Compose |
| `SHARED_DATA_DIR` / `SQLITE_PATH` | `/data` / `/data/firewatch.sqlite3` |
| `OPENAI_API_KEY`, `CHAT_PROXY_TOKEN` | Empty by default (chat blocked); set both to enable chat |
| `LLM_API_KEY` | Explicitly empty in this deployment |
| `CHAT_ACCESS_MODE` | `trusted_proxy`; without a token nginx and the backend fail closed |
| `CORS_ORIGINS` | `[]`; same-origin proxy routing |

Settings do not currently implement `_FILE` secrets. Docker secrets cannot simply
be mapped to `OPENAI_API_KEY_FILE` or `NASA_FIRMS_MAP_KEY_FILE` without additional
reviewed application/entrypoint support.

The chatbot only accepts requests carrying the server-only proxy token. By default
`CHAT_PROXY_TOKEN` is empty, nginx answers 403 for every chat path and no paid API
key is injected. To enable chat, set in `deploy/.env`:

```bash
CHAT_PROXY_TOKEN=<output of: openssl rand -hex 32>   # 32+ chars of [A-Za-z0-9_-]
OPENAI_API_KEY=<backend-only key>
```

At startup `deploy/nginx-entrypoint.sh` then renders an exact `/api/v1/chat`
route that overwrites `X-FireWatch-Chat-Auth` with the token, so a browser can
neither read nor forge it. An invalid token stops the frontend container instead
of silently disabling chat. Other chat path variants stay blocked, and the backend
port remains unpublished.

Nginx is the trusted gateway, **not user authentication**: anyone who can reach
port 8080 can use chat, bounded only by the backend quotas. Before exposing it
(e.g. a Cloudflare tunnel), put an access-controlled HTTPS edge in front, such as
Cloudflare Access on a named tunnel; quick `trycloudflare.com` tunnels cannot
enforce access. Behind nginx every caller shares one client address, so the
per-client rate limit acts as a shared one. CORS does not authenticate users.
Never put the token or an OpenAI key in Vite variables.

## Data, health and provider failures

| Path in image/container | Kind and lifecycle |
|---|---|
| `/app/frontend/public/data` | Immutable packaged California/catalog/display assets; available to backend |
| `/usr/share/nginx/html/data` | Packaged browser assets; no runtime volume over this directory |
| `/data/provider-cache/firms.json`, `firms.lock` | Shared persistent FIRMS snapshot and lock |
| `/data/provider-cache/weather*` | Persistent weather snapshots/locks, generated on demand |
| `/data/provider-cache/chat-limits.sqlite3` | Existing quota database if chat is enabled in a future reviewed deployment |
| `/data/firewatch.sqlite3` | Scheduler metadata SQLite, created by publication when used |
| `/data/predictions`, `/data/grids`, indexes, manifests | Future validated forecast publication and derived indexes |
| `/data/grid.geojson`, `/data/california.geojson` | Future ML grid and authoritative forecast boundary inputs |
| `/data/explanations` | Reserved runtime artifacts; SHAP service/contract not yet connected |
| `/tmp` | Ephemeral request/temp files and worker heartbeat; not backed up |

The named volume `<project>_runtime-data` starts empty and copies `/data` ownership
from the image (UID/GID 10001). It does not obscure packaged geodata. Both backend
processes can write the volume without root. No developer SQLite/cache/ML datasets
are baked into an image. For an existing bind mount, provision ownership 10001:10001
and host SELinux labels as required; test locking/fsync on the actual filesystem.
Use a local filesystem. NFS/distributed locks and multi-host writers are unverified.

The FIRMS filtering boundary is the existing immutable
`/app/frontend/public/data/ca-boundary.geojson`. The future forecast live grid
requires its separate ML-authoritative `/data/california.geojson` contract; do not
substitute display geometry or an empty volume for that input.

Missing NASA credentials produce safe `credentials_missing` state and an unavailable
snapshot without contacting NASA. The API still becomes ready. The API receives
no NASA credential: its `configured` flag describes its own settings and remains
false, while freshness/status can still describe usable worker-produced snapshots.
Temporary NASA failures preserve previous observations and expose stale/partial
metadata. Readiness means the API initialized, **not** that providers or ML data
are ready. Query `/api/v1/status` for individual data availability. Missing real
forecasts stay unavailable rather than switching to fixtures.

API health checks `/health/ready`; frontend health checks its local `/healthz`.
Worker health checks a heartbeat written only after a refresh attempt completes;
NASA failure does not fail liveness, while a stalled/dead loop eventually does.
Maximum heartbeat age is refresh interval + 120 seconds. Docker health checks
report, rather than repair, a permanently unhealthy process. Restart/network/egress
alerts and TLS certificates remain operator responsibilities.

## Verification commands

```sh
docker compose --env-file deploy/.env.example config --quiet
docker buildx build --check --platform linux/s390x -f backend/Dockerfile .
docker buildx build --check --platform linux/s390x -f frontend/Dockerfile .
python deploy/smoke.py --platform linux/amd64 --tag amd64
python deploy/smoke.py --platform linux/s390x --tag s390x
python deploy/audit_image.py firewatch-backend:s390x
python deploy/audit_image.py firewatch-frontend:s390x
docker buildx build --platform linux/s390x --target test --load -f backend/Dockerfile -t firewatch-backend-test:s390x .
docker run --rm --platform linux/s390x --network none firewatch-backend-test:s390x
docker buildx build --platform linux/amd64 --target test --load -f backend/Dockerfile -t firewatch-backend-test:amd64 .
docker run --rm --network none firewatch-backend-test:amd64 python -m ruff check --no-cache .
docker run --rm --network none firewatch-backend-test:amd64 python -m ruff format --no-cache --check .
docker run --rm firewatch-backend-test:amd64 python scripts/smoke.py
docker run --rm firewatch-backend-test:amd64 python scripts/smoke.py --fixtures
docker buildx build --target test --load -f frontend/Dockerfile -t firewatch-frontend-test:local .
docker run --rm --network none firewatch-frontend-test:local
```

Use `python3` in place of `python` where appropriate on Linux. The Compose smoke
uses isolated `firewatch-smoke-amd64`/`firewatch-smoke-s390x` projects and host port
18080 (`--port` overrides it). It clears NASA credentials and never calls OpenAI,
NASA or weather endpoints. It checks target architecture via the running API,
health, static assets, SPA fallback, same-origin API routing, unavailable data,
chat denial, non-root/read-only/port constraints, shared-cache writes, SQLite
reads across services, container recreation persistence and clean exit codes.
Uvicorn may return 143 after SIGTERM; the smoke also requires its explicit
`Application shutdown complete` lifecycle log. Worker/Nginx must exit zero.
Containers/networks are removed in `finally`; test volumes remain for inspection.
The layer audit checks every image layer, including files deleted by later layers,
for dotenv files, local virtualenvs, provider caches and SQLite databases. It can
also scan for a non-secret exclusion canary using `--canary`.

Optional real Chrome check against an already running stack (PowerShell; use
`export NAME=value` on Linux). Install the frontend's locked npm dependencies and
a Playwright-supported Chrome first:

```powershell
$env:FIREWATCH_BROWSER_URL='http://127.0.0.1:8080'
node deploy/browser-smoke.mjs
```

It verifies real UI-initiated same-origin status traffic and browser chat denial,
while blocking external tiles and on-demand weather to avoid provider polling.
Use `FIREWATCH_BROWSER_CHANNEL=chromium` with a Playwright-managed Chromium if
Chrome is unavailable. It does not validate live maps or provider integration.

## LinuxONE build and runtime acceptance

An x86 machine needs working s390x QEMU/binfmt support; check
`docker buildx inspect --bootstrap` for `linux/s390x`. Docker Desktop here already
provided it. For a Linux builder without it, configure binfmt using the documented
[Docker multi-platform workflow](https://docs.docker.com/build/building/multi-platform/)
or use a native LinuxONE Docker context. Installing binfmt changes the builder
host and requires administrator privileges. Compose itself needs no privileges.

On the provided LinuxONE machine (after an operator supplies access):

```sh
uname -m  # must be s390x on the host, not just an image label
docker info --format '{{.Architecture}}'
docker buildx inspect --bootstrap
docker buildx build --platform linux/s390x --target runtime --load -f backend/Dockerfile -t firewatch-backend:s390x .
docker buildx build --platform linux/s390x --target runtime --load -f frontend/Dockerfile -t firewatch-frontend:s390x .
docker image inspect firewatch-backend:s390x --format '{{.Os}}/{{.Architecture}}'
docker image inspect firewatch-frontend:s390x --format '{{.Os}}/{{.Architecture}}'
docker run --rm --platform linux/s390x firewatch-backend:s390x python -c 'import platform, sqlite3, ssl, jiter, pydantic_core; print(platform.machine(), sqlite3.sqlite_version, ssl.OPENSSL_VERSION); assert platform.machine() == "s390x"'
python3 deploy/smoke.py --platform linux/s390x --tag s390x
```

Then start the real deployment with the earlier env-file instructions and inspect
provider freshness, host filesystem permissions/locking, TLS/egress and capacity.
Only enable the NASA key when intentionally starting ingestion. Paid OpenAI
acceptance belongs to the chatbot workstream and is not part of these tests.

To transfer images without publishing a registry image:

```sh
docker image save -o firewatch-s390x.tar firewatch-backend:s390x firewatch-frontend:s390x
# Transfer the tar using your approved channel; verify its checksum at both ends.
# On LinuxONE:
docker image load -i firewatch-s390x.tar
```

Do not set `platform: linux/s390x` on an amd64 image and call it compatible. A
manifest check, an image build, emulated execution, and native IBM LinuxONE
deployment are separate milestones. Native deployment still requires a host;
none was supplied in this task.

## Native dependencies and future ML

The complete locked runtime set installs as 26 packages on Python 3.12 Linux.
`pydantic-core==2.50.1` and `jiter==0.17.0` are native Rust extensions with selected
CPython 3.12 `manylinux_2_17_s390x` wheels. No Rust toolchain is needed for these
pins. OpenAI 2.54.0 itself is Python. Geometry code is pure Python; SQLite, TLS and
timezone support use the Python/system runtime and locked tzdata. No x86 binary
URLs or architecture-specific application assumptions were found in `backend/app`.

NumPy, SciPy, SHAP, XGBoost, LightGBM, scikit-learn and geospatial native packages
are **not current runtime dependencies**. Their absence does not prove they will
work on s390x. Do not add an unselected ML runtime just to make an image look ready.
The current image can consume versioned, validated ML JSON publications under
`/data`; no inference process is automatically launched. The actual model,
artifact/SHAP contracts and production runtime remain pending the ML team.

When a model is selected, add its exact dependencies to `backend/pyproject.toml`,
update `uv.lock`, and rerun both architecture builds, imports and model-specific
numerical parity tests using real artifacts. Keep model artifacts versioned and
read-only or publish them atomically into the shared store. Preserve exactly one
forecast publisher and the existing `CLIAdapter`/`roll_window` contract. Extend the
build-context allowlist explicitly for reviewed model code/artifacts; never copy
an entire developer checkout/cache.

If target wheels are absent, the current binary-only build fails deliberately.
Investigate the selected version's source build in an isolated builder: XGBoost
and LightGBM use C++/CMake and OpenMP; numerical stacks can additionally need
Fortran, BLAS/LAPACK, Meson/Ninja/pkg-config; Rust-backed packages need supported
Rust/maturin. Copy only required shared runtimes into the final image, regenerate
locked wheel hashes for a controlled wheelhouse, and measure actual predictions
on LinuxONE before accepting the build. These are investigation requirements,
not a claim that any unselected library has been built here. See upstream
[XGBoost builds](https://xgboost.readthedocs.io/en/stable/build.html),
[LightGBM builds](https://lightgbm.readthedocs.io/en/stable/Installation-Guide.html),
and [SciPy builds](https://docs.scipy.org/doc/scipy/building/index.html).

If the chosen inference/SHAP stack cannot run on IBM Z, a viable existing
architecture is to generate predictions/explanations on an approved supported
machine and publish validated, versioned artifacts for the LinuxONE API to serve.
This requires ML/backend contract agreement (especially SHAP, currently unavailable)
and does not substitute fake scores or introduce an unverified model service.

## Operations, backup and rollback

```sh
docker compose --env-file deploy/.env logs --tail 50 backend firms-worker frontend
docker compose --env-file deploy/.env restart
docker compose --env-file deploy/.env stop --timeout 30
docker compose --env-file deploy/.env start --wait
docker compose --env-file deploy/.env down --timeout 30
```

`down` preserves the named volume. **Do not use `down --volumes` or volume prune**
on a real deployment. Stop writers/API briefly for a consistent filesystem-level
backup of the volume, or use SQLite's backup API plus a coherent forecast manifest
snapshot. Preserve all manifest-referenced data and the previous manifest. Test
restoration before relying on a backup; do not copy a live SQLite DB without its
transaction state. Record the Compose project name because it determines the volume.

Before upgrading, save/tag the current image pair with a release identifier and
back up `/data`. Deploy both new tags together and run health/API checks. To roll
back, stop the FIRMS owner and any separately managed forecast publisher, restore
the prior reviewed Dockerfiles/config or select the prior `IMAGE_TAG`, and run
`up -d --no-build --wait`. Keep the existing project/volume. Verify reader/schema
compatibility before reverting a forecast reader; an old strict reader can reject
new artifact fields. Restore data only as a deliberate coordinated recovery.

Troubleshooting:

- `no matching manifest`: verify the pinned base includes s390x; never switch to an
  arbitrary amd64 binary. `exec format error`: builder/runtime binfmt is missing;
  use native LinuxONE or configure emulation.
- `No matching distribution`: inspect the exact locked package and Python/ABI;
  retain the failure and investigate source builds instead of unpinning silently.
- Volume permission errors: verify UID 10001 and ownership/SELinux labels. Named
  volume initialization and permissions were tested; arbitrary host mounts differ.
- Worker unhealthy: check safe worker logs, `/tmp/firms-heartbeat`, cache ownership,
  configured interval and disk space. Missing NASA key is data unavailability,
  not API failure. Stale observations remain labeled; inspect provider status.
- Frontend 502: check backend health and Docker DNS. Nginx re-resolves the backend
  service after replacement; only same-origin `/api/v1` is compiled into JS.
- Chat 403 is intentional until an authenticated gateway is deployed. OpenAI/NASA
  keys must never be added to frontend variables to resolve it.

## CI and recorded evidence

`.github/workflows/docker-linuxone.yml` validates Dockerfiles/Compose, builds both
runtime architectures, runs isolated Compose smoke checks, installs the locked
backend test environment and executes the full backend suite on amd64 plus unit
and contract tests on s390x. Full s390x integration tests and an emulated native
s390x frontend-tooling build run on manual dispatch: forecast publication tests
perform many fsync operations and are substantially slower under QEMU.
Frontend tests are a separate job; failures are not hidden by packaging success.
The frontend test image limits Vitest to two concurrent workers to avoid CPU
contention on Docker builders reporting many host CPUs. Test timeouts and
assertions are unchanged. Tests explicitly separate demo behavior from API-mode
classification/explanation safeguards.
Changes touching runtime code trigger it on pull requests; manual dispatch is
available. Read-only GitHub permissions, no provider credentials, no registry
push, no `pull_request_target`, and a 20-minute container job limit keep the scope
bounded. Existing backend/frontend workflows remain unchanged.

Actual results and exact limitations for this change are recorded in
[DOCKER_LINUXONE_VERIFICATION.md](DOCKER_LINUXONE_VERIFICATION.md).
