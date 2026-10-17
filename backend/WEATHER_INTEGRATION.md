# Weather integration decisions

This feature is JS_feat/weather-inference, based on merged rolling-window PR #3.
It leaves the model, prediction publisher, and NASA FIRMS implementation intact.

The existing frontend uses MapLibre (not Mapbox), one risk timeline, a statewide
one-hour GET /wind client, weather conditions and wind layers. Reuse these. Fix
out-of-hour frame clamping, unbounded-age client caching, request races, and
fallback preventing subsequent hourly refresh. Preserve existing sample labels.

Open-Meteo official forecast documentation: https://open-meteo.com/en/docs .
Use batched coordinates, GMT/Unix timestamps, Celsius, mm and km/h. Request 169
hours from the current hour; verify each required absolute timestamp rather than
assuming default seven calendar days cover the publisher's next 168 hours. Null
or absent hours are gaps; never extrapolate. Provider issue time is not exposed
by this API; fetched_at is retrieval time, not issue time. Precipitation is the
preceding-hour amount; other selected variables are instantaneous hourly values.

Main has no authoritative statewide grid or model-specific inference contract.
RG_feat's weather/elevation proposal documents historical daily aggregates in
Celsius/mm/m/s and an anchor mapping; those are not an hourly inference contract.
Do not substitute these normalized forecasts for trained-model features.

Display sampling uses a stable 0.5-degree lattice (roughly 40–56 km spacing),
nearest sample for panels and existing client wind interpolation. It is not the
3 km risk grid or a claim about provider native resolution; Best Match uses
multiple model resolutions and elevation downscaling. The California bounding
extent includes neighboring/ocean points and is not an authoritative boundary.
Inference uses only an explicit ML-owned anchor/cell mapping validated against
the real grid. Production inference remains blocked until those artifacts and
exact model feature requirements are supplied.

Weather revisions hash normalized values per anchor/hour, excluding fetched_at.
Expose changed partitions; do not automatically overwrite the publisher's global
input_revision on every fetch or sliding horizon. Its current contract safely
invalidates a whole window, not individual input partitions. A proposed weather
handoff is separate from that authoritative prediction contract.

Milestones: provider and tests; cache/sampling/revisions; endpoints; existing UI
integration and tests; proposed inference handoff; full verification and PR.

Browser contract smoke: start `npm run dev -- --host 127.0.0.1 --port 5174` in
frontend/, then `node scripts/smoke-weather.mjs` in another terminal. It uses the
installed Chrome channel (or FIREWATCH_BROWSER_PATH), the existing UI, and mock
API/style responses. It checks location and hour changes, stale labels, wind
orientation/source updates, and outage clearing. It does not claim live-model or
live-weather browser verification. No new browser download is required if Chrome
is installed. FIREWATCH_SMOKE_URL can select another existing Vite server.
