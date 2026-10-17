# FireWatch v4 — LinuxONE-first handoff pack

Backend implementation: see [`backend/README.md`](backend/README.md) for FastAPI
setup, health/status endpoints and verification, and
[`backend/IMPLEMENTATION_STATUS.md`](backend/IMPLEMENTATION_STATUS.md) for the
feature plan and differences between this older handoff and the primary backend
architecture. The API foundation reports unavailable data until ingestion and
validated ML artifacts are integrated.

For the IBM Datathon. California-only current NASA thermal anomaly monitoring + 7-day ML hotspot-occurrence **risk** estimates, illustrative coverage overlay, grounded chat and same-layer 2D/3D MapLibre map.

1. `01_ARCHITECTURE.md` — deployment graph, caching/update sequence, s390x constraints and LinuxONE judging evidence.
2. `02_API_CONTRACT.md` — frozen endpoint schemas and example fixtures for both teams.
3. `03_UI_DESIGN.md` — exact page layout, React component tree, map interaction logic and acceptance tests.
4. `04_HACKATHON_PROMPTS.md` — seven paste-ready coding/integration prompts and hour-by-hour plan.
5. `FireWatch_UI_Concept.html` — standalone clickable **UI wireframe**, not a working live satellite map. Toggle visible layers, search simulated places, switch 2D/3D presentation, open chat. It's a design aid with synthetic visuals only.

## Decision log
- **One LinuxONE VM, one Python backend, local snapshot files, static React build.** SQLite only after a measured need.
- Training data: historical fire observations + weather, with cutoff-aware features. Separate *observed* snapshot data from *forecast risk*.
- Current fire coverage overlay is only a stylized proximity/visual influence region, not actual acreage burned or an official fire perimeter.
- Production 3D requires compatible DEM tile source + real MapLibre GL JS browser rendering; 3D is not implemented in the standalone concept.
- ML packages inside IBM JupyterLab need not be installed in the SSH host Python. Check deployment runtime after obtaining permission.
- Don't share NASA FIRMS or LLM API keys in Git.

**References:** https://firms.modaps.eosdis.nasa.gov/api/area/ , https://open-meteo.com/en/docs/historical-weather-api , https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/ , https://www.firemap.live/
