# FireWatch v4 — Paste-ready, coordinated coding prompts

**Every prompt assumes:** California only; LinuxONE s390x is the actual production runtime; no PostgreSQL/Redis/Docker/Kafka/microservices; local JSON/CSV/GeoJSON preferred; static React served from single Python backend; source/provenance timestamps; observed NASA hotspots distinctly separated from estimated 7-day hotspot-occurrence risk; the approximate influence layer is not actual burned area. Read `01_ARCHITECTURE.md`, `02_API_CONTRACT.md`, `03_UI_DESIGN.md` before generating code. Never invent measured or predicted metrics. Mark samples clearly as fixtures.

## Prompt A — Repo architect / tech lead (run first)
"You are the integration lead for FireWatch, a 24-hour IBM LinuxONE s390x California wildfire intelligence demo. Read the attached v4 architecture, frozen API contract, and UI spec in full. Scaffold exactly one repository with `frontend/`, `backend/`, `models/`, `data/`, and `tests/`. Generate readme setup, `.env.example`, `.gitignore`, type-safe mock API fixture responses, a `/api/v1/status` endpoint, and smoke tests. Every API response must match the v4 schema. Avoid unnecessary DBs, daemons and packages. Support a pure-Python mock mode so the frontend can ship before ML. Ask about server permissions before installing or provisioning. Output runnable files and exact start/test commands. Do not add features outside v4 spec."

## Prompt B — ML feature engineering (Ridwan / Eshann / Serena)
"Implement leakage-free training datasets for a seven-day California **grid-cell hotspot-occurrence risk** model. Historical NASA FIRMS detections provide positive labels if at least one qualified detection exists inside a cell during `(cutoff, cutoff+7 days]`. Use only fire history and historical/known-at-cutoff weather features as of cutoff; Open-Meteo archive vs forecast differences must be documented. Create consistent fixed grid, negative examples, geographic/temporal splits, class-imbalance handling and calibration assessment. Build deterministic feature-table CSV, named ordered schema `models/features.json`, and reproducible training script. Report sample counts, temporal holdout metrics (PR-AUC, recall at fixed FPR, calibration/Brier if feasible), data coverage/limitations, and any leakage risks. Start with sklearn RandomForest only if LinuxONE imports; prefer XGBoost when demonstrated functional. Do not label a probability unless calibrated. No deployment frameworks."

## Prompt C — ML inference + explainability
"Using the trained model and `features.json`, implement deterministic batch forecast for every California grid cell using weather forecasts and historical signals available at run time. Write `risk.geojson` and `metrics.json` conforming to the frozen API contract. XGBoost explanations: first try native `Booster.predict(DMatrix, pred_contribs=True)`, retaining feature order and explaining that contributions sum to raw margin/log-odds + bias, NOT percentage points. Optionally support SHAP library only after s390x verification. Give a model/version/feature-consistency check, fail safely on missing weather, publish snapshots atomically, and include unit tests for count, geometry, bounds, score range and metadata. Never forecast exact fires or map exact future burn area."

## Prompt D — Data ingestion + backend (app team)
"Build a single Python HTTP service compatible with LinuxONE s390x. Prefer FastAPI only if it installs; preserve routes with Flask or Python stdlib fallback if necessary. Create a separately executed `refresh_data.py` to request bounded California NASA FIRMS NOAA-20/21 CSV using `FIRMS_MAP_KEY` and bounded Open-Meteo weather with retries/timeouts, log UTC acquisition timestamps, normalize to GeoJSON, clip to California and atomically publish snapshots. Serve frozen endpoints `/api/v1/status`, `/fires`, `/coverage`, `/risk`, `/places`, `/locations/{id}`, `/chat`. Serve React static build same origin. `coverage` is conservative illustrative hotspot influence; NEVER burned-area estimate. Keep raw data and secrets outside public static directory. Generate fixture mode and empty-data fallback. Tests must run in an offline mode. No DB by default."

## Prompt E — React / MapLibre frontend (app team)
"Implement FireWatch v4 UI from the attached page spec with Vite React TypeScript + MapLibre GL JS. Full-window realistic California-only map, strong contrast between observed NASA hotspot dots/gradients and seven-day risk grid/gradients, left overlay/opacity/legend controls, CA place/ZIP search with debounced backend endpoint, right location detail inspector with ML factor contributions, collapsible LLM chat drawer, and clear source freshness. Build a persistent ONE map instance. At low zoom clustered glowing hotspots; above zoom 8 show an explicit labeled *illustrative hotspot influence overlay* (not actual fire boundaries) if supplied. Add 2D top-down / 3D terrain toggle using MapLibre DEM + camera pitch; layers continue seamlessly with preserved selection. Loading/error/empty states, mobile responsiveness and basemap attribution. Use `/api/v1/*` mock fixtures until backend ready. Do not hardcode NASA credentials or predicted scores into production UI."

## Prompt F — Grounded chatbot (app team)
"Add `POST /api/v1/chat` to the existing single backend. Take message and `location_id`, look up bounded allowlisted data from `fires`, `risk`, location forecast explanations and Open-Meteo metadata, format precise minimal context for externally hosted LLM API, and strictly ask model to answer only from this context. If data unavailable, it must say so. Require observation/forecast distinction and output source names plus as-of timestamps. No general emergency response advice, no arbitrary tool execution, no access to raw secrets, no client-side LLM key. API timeout+budget limits and fixture mode. Write adversarial tests for fabricated burns, score-as-probability confusion, prompt injection and nonexistent cities."

## Prompt G — Integration auditor (run at every merge)
"Act as a skeptical LinuxONE s390x integration tester. Compare all source files to `02_API_CONTRACT.md`. Test all endpoints with fixtures, model cell_id lookup, `features.json` column order, city/county/ZIP California-only search, browser observed/risk separation, legend and freshness, 2D/3D persistence, secret leak prevention, failed NASA API, stale file snapshots, LLM timeout, and response shape drift. List failures by severity with exact file/line and minimal fixes. Do not rewrite whole repo or add heavy dependencies. Produce commands for integration smoke test on the permitted LinuxONE runtime and record `uname -m`, package versions and evidence of actual on-box model inference."

## Six-person task allocation
| Owner | Workstream | First mergeable deliverable |
|---|---|---|
| Ridwan (ML) | training labels + evaluation design | reproducible historical train/validation split and metrics |
| Eshann (ML) | weather + fire feature table | schema-checked feature CSV builder |
| Serena (ML) | inference + explanation | `risk.geojson` fixture, native contributions, model handoff |
| App developer A | backend/API + LinuxONE setup | `/status`, `/risk`, `/fires` serving fixtures |
| App developer B | MapLibre/UI and search | California 2D map, zoom behavior and inspector |
| App developer C | ingestion, chat and 3D QA | NOAA/Open-Meteo update + chatbot fallback + terrain smoke test |

Rotate ownership if expertise differs. Pair ML/app on the risk output contract from the outset.

## Timeboxed handoffs (24h hackathon)
- **Hour 0–2:** confirm rules, environment and s390x; API freeze; mock endpoint + React map on LinuxONE.
- **Hour 2–6:** parallel ML feature builder + application geodata and panel UI; tests from fixtures.
- **Hour 6–10:** first valid XGBoost/RandomForest model, cached NASA snapshot, search and location inspector.
- **Hour 10–15:** inference/driver factors integrated, observed coverage graphics, 3D overlay QA.
- **Hour 15–19:** chatbot and real provider data; stale/offline fallback; metric review.
- **Hour 19–22:** rehearse judge flow and LinuxONE evidence, fix critical integration bugs.
- **Hour 22–24:** freeze dependencies, backup snapshots, demo rehearsal, presentation.

**Demo script:** show observed NASA detections and timestamps → search Stockton → turn on 7-day risk overlay → show model drivers → toggle 3D without changing data → ask chatbot what raises score → show `uname -m` and live LinuxONE inference/refresh. State model limits honestly.
