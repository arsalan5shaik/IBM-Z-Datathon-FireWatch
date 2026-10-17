/** Keeps the single MapLibre instance in sync with the store. Never recreates the map or its sources. */
import type { FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { TERRAIN_EXAGGERATION, VIEW_3D_PITCH, VIEW_TRANSITION_MS, WEATHER_CITIES } from '../config';
import { loadCaBoundary } from '../api/static';
import { distanceKm, type LngLat } from '../lib/geo';
import { formatTempShort } from '../lib/format';
import { HOUR_MS } from '../lib/time';
import { nearestWeatherPoint, riskFrame, weatherAtIndex, weatherFrame, windAt } from '../state/lookups';
import { requestRiskView } from '../state/data';
import { getState, setState, useStore, validTimeOf, type AppState } from '../state/store';
import type { LayerKey, WeatherGrid } from '../types';
import { LAYER_GROUPS, SRC, riskFillOpacity, riskGlowOpacity, setVisible } from './layers';
import { FireMarkers } from './markers';
import { TERRAIN_PAINT } from './style';

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** World-minus-California polygon used to dim everything outside the state. */
function maskFrom(fc: FeatureCollection<MultiPolygon>): FeatureCollection<Polygon> {
  const holes: Position[][] = [];
  for (const f of fc.features) for (const poly of f.geometry.coordinates) holes.push(poly[0]);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[[-179, -85], [179, -85], [179, 85], [-179, 85], [-179, -85]], ...holes] },
      },
    ],
  };
}

/** Thin wind points into 3 density levels (≈100 km, ≈50 km, all). */
const windLevels = new WeakMap<WeatherGrid, Uint8Array>();
function levelsOf(g: WeatherGrid): Uint8Array {
  let lv = windLevels.get(g);
  if (lv) return lv;
  lv = new Uint8Array(g.points.length).fill(2);
  for (const [level, km] of [[0, 95], [1, 45]] as const) {
    const kept: LngLat[] = [];
    g.points.forEach((p, i) => {
      if (lv![i] < level) return;
      if (kept.every((k) => Math.abs(k[1] - p[1]) * 110 > km * 0.98 || distanceKm(k, p) >= km * 0.98)) {
        kept.push(p);
        lv![i] = Math.min(lv![i], level);
      }
    });
  }
  windLevels.set(g, lv);
  return lv;
}

export function startSync(map: MapLibreMap, markers: FireMarkers): () => void {
  const unsubs: (() => void)[] = [];
  const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;
  function sub<T>(selector: (s: AppState) => T, fn: (v: T) => void, equalityFn: (a: T, b: T) => boolean = Object.is) {
    unsubs.push(useStore.subscribe(selector, fn, { equalityFn, fireImmediately: true }));
  }
  const shallowArr = <T extends readonly unknown[]>(a: T, b: T) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  void loadCaBoundary()
    .then((fc) => {
      src(SRC.border)?.setData(fc);
      src(SRC.mask)?.setData(maskFrom(fc));
    })
    .catch(() => undefined);

  const dirty = { wind: true, weather: true };

  // ---- basemap: Default ↔ Terrain ------------------------------------------------
  const defaults = new Map<string, unknown>();
  for (const [layer, prop] of TERRAIN_PAINT)
    if (map.getLayer(layer)) defaults.set(`${layer}|${prop}`, map.getPaintProperty(layer, prop as never));
  sub(
    (s) => s.basemap,
    (b) => {
      const terrain = b === 'terrain';
      setVisible(map, ['fw-relief', 'fw-hillshade'], terrain);
      for (const [layer, prop, value] of TERRAIN_PAINT) {
        if (!map.getLayer(layer)) continue;
        map.setPaintProperty(layer, prop as never, (terrain ? value : defaults.get(`${layer}|${prop}`)) as never);
      }
    },
  );

  // ---- camera: 2D ↔ subtle 3D ------------------------------------------------------
  let firstView = true;
  sub(
    (s) => s.view,
    (v) => {
      const duration = firstView || reduceMotion() ? 0 : VIEW_TRANSITION_MS;
      firstView = false;
      if (v === '3d') {
        map.setMaxPitch(70);
        try {
          map.setTerrain({ source: 'fw-terrain-dem', exaggeration: TERRAIN_EXAGGERATION });
        } catch {
          setState((s) => ({ map: { ...s.map, terrainError: true } }));
        }
        try {
          map.setSky({
            'sky-color': '#a9cbf5',
            'horizon-color': '#e8f1fb',
            'fog-color': '#f2f5f8',
            'sky-horizon-blend': 0.6,
            'horizon-fog-blend': 0.7,
            'fog-ground-blend': 0.9,
          });
        } catch {
          /* sky is cosmetic */
        }
        setVisible(map, ['building-3d'], true);
        map.easeTo({ pitch: map.getPitch() > 5 ? map.getPitch() : VIEW_3D_PITCH, duration, essential: true });
      } else {
        setVisible(map, ['building-3d'], false);
        const finish = () => {
          if (getState().view !== '2d') return;
          map.setTerrain(null);
          map.setMaxPitch(0);
        };
        if (duration && map.getPitch() > 0) {
          map.easeTo({ pitch: 0, duration, essential: true });
          map.once('moveend', finish);
        } else {
          map.setPitch(0);
          finish();
        }
      }
    },
  );

  sub(
    (s) => s.riskOpacity,
    (f) => {
      map.setPaintProperty('fw-risk-fill', 'fill-opacity', riskFillOpacity(f));
      map.setPaintProperty('fw-risk-glow', 'line-opacity', riskGlowOpacity(f));
    },
  );

  // ---- risk grid + hourly frame ---------------------------------------------------
  let lastGrid: AppState['risk']['data'] = null;
  let lastFrame = -1;
  function applyRisk() {
    const s = getState();
    const grid = s.risk.data;
    if (!grid) return;
    if (grid !== lastGrid) {
      if (lastGrid) map.removeFeatureState({ source: SRC.cells });
      src(SRC.cells)?.setData({ type: 'FeatureCollection', features: grid.cells });
      lastGrid = grid;
      lastFrame = -1;
    }
    const f = riskFrame(grid, validTimeOf(s));
    if (f === lastFrame) return;
    lastFrame = f;
    const n = grid.cells.length;
    const base = f * n;
    for (let i = 0; i < n; i++) {
      const v = grid.scores[base + i];
      map.setFeatureState({ source: SRC.cells, id: grid.cells[i].properties.cell_id }, { s: Number.isFinite(v) ? v : -1 });
    }
  }
  sub((s) => [s.risk.data, validTimeOf(s)] as const, applyRisk, shallowArr);

  // Backend mode: load the forecast tiles for what's on screen at the selected hour.
  const requestView = () => {
    const s = getState();
    if (!s.layers.risk && !s.selection) return;
    const b = map.getBounds();
    requestRiskView([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], validTimeOf(s));
  };
  map.on('moveend', requestView);
  unsubs.push(() => map.off('moveend', requestView));
  sub((s) => [validTimeOf(s), s.risk.origin, s.layers.risk] as const, requestView, shallowArr);

  // ---- wind + weather labels -------------------------------------------------------
  let lastW: { g: WeatherGrid | null; f: number; units: string } = { g: null, f: -1, units: '' };
  function applyWeather(force = false) {
    const s = getState();
    const g = s.weather.data;
    if (!g) return;
    const t = validTimeOf(s);
    const f = weatherFrame(g, t);
    const changed = g !== lastW.g || f !== lastW.f || s.units !== lastW.units;
    if (!changed && !force) return;
    if (changed) {
      dirty.wind = dirty.weather = true;
      lastW = { g, f, units: s.units };
    }
    const m = g.points.length;
    if (s.layers.wind && dirty.wind) {
      const lv = levelsOf(g);
      src(SRC.wind)?.setData({
        type: 'FeatureCollection',
        features: g.points.map((p, i) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: p },
          properties: { s: g.wind_speed_kmh[f * m + i], d: (g.wind_direction_deg[f * m + i] + 180) % 360, lvl: lv[i], i },
        })),
      });
      dirty.wind = false;
    }
    if (s.layers.weather && dirty.weather) {
      src(SRC.weather)?.setData({
        type: 'FeatureCollection',
        features: WEATHER_CITIES.flatMap((c) => {
          const i = nearestWeatherPoint(g, [c.lon, c.lat]);
          if (i < 0) return [];
          const w = weatherAtIndex(g, i, t);
          return [
            {
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
              properties: { name: c.name, rank: c.rank, t: formatTempShort(w.temperature_c, s.units), rh: `${Math.round(w.relative_humidity_pct)}%` },
            },
          ];
        }),
      });
      dirty.weather = false;
    }
  }
  sub((s) => [s.weather.data, validTimeOf(s), s.units] as const, () => applyWeather(), shallowArr);

  // Dense, interpolated arrows when zoomed in past the forecast grid spacing.
  let localShown = false;
  function applyLocalWind() {
    const s = getState();
    const g = s.weather.data;
    if (!g || !s.layers.wind || map.getZoom() < 8.6) {
      if (localShown) src(SRC.windLocal)?.setData({ type: 'FeatureCollection', features: [] });
      localShown = false;
      return;
    }
    const t = validTimeOf(s);
    const { clientWidth: w, clientHeight: h } = map.getCanvas();
    const step = 96;
    const features: GeoJSON.Feature[] = [];
    for (let y = step / 2; y < h; y += step)
      for (let x = step / 2 + ((y / step) % 2 ? step / 2 : 0); x < w; x += step) {
        const ll = map.unproject([x, y]);
        const v = windAt(g, [ll.lng, ll.lat], t);
        if (v) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] }, properties: { s: v.speed, d: (v.dir + 180) % 360, lvl: 3 } });
      }
    src(SRC.windLocal)?.setData({ type: 'FeatureCollection', features });
    localShown = true;
  }
  map.on('moveend', applyLocalWind);
  unsubs.push(() => map.off('moveend', applyLocalWind));
  sub((s) => [s.weather.data, validTimeOf(s), s.layers.wind] as const, applyLocalWind, shallowArr);

  // ---- fires, influence shapes, perimeters, flame markers ----------------------------
  function applyFires() {
    const s = getState();
    const { detections, groups, coverage } = s.derived;
    src(SRC.fires)?.setData({
      type: 'FeatureCollection',
      features: detections.map((d) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
        properties: { id: d.id, age: (s.now - Date.parse(d.acquired_at)) / HOUR_MS, frp: d.frp_mw ?? 1, inc: d.incident_id ?? '' },
      })),
    });
    src(SRC.coverage)?.setData(coverage);
    const sel = s.selection;
    const selectedId = sel?.kind === 'group' ? sel.groupId : sel?.kind === 'incident' ? sel.incidentId : null;
    markers.update(groups, s.incidents.data?.incidents ?? [], s.now, s.layers.fires, selectedId);
  }
  sub((s) => [s.derived, s.now, s.selection] as const, applyFires, shallowArr);

  sub(
    (s) => s.incidents.data,
    (data) => {
      src(SRC.perimeters)?.setData({
        type: 'FeatureCollection',
        features: (data?.incidents ?? [])
          .filter((i) => i.geometry)
          .map((i) => ({ type: 'Feature', id: i.id, geometry: i.geometry!, properties: { id: i.id, name: i.name } })),
      });
    },
  );

  // ---- layer visibility --------------------------------------------------------------
  sub(
    (s) => s.layers,
    (layers) => {
      for (const key of Object.keys(LAYER_GROUPS) as LayerKey[]) setVisible(map, LAYER_GROUPS[key], layers[key]);
      if (layers.wind || layers.weather) applyWeather(true);
      applyFires();
    },
  );
  // ---- selection + highlights ------------------------------------------------------------
  let selectedPerimeter: string | null = null;
  sub(
    (s) => s.selection,
    (sel) => {
      const cellId = sel?.kind === 'cell' ? sel.cellId : '';
      map.setFilter('fw-risk-selected', ['==', ['get', 'cell_id'], cellId]);
      map.setFilter('fw-risk-selected-halo', ['==', ['get', 'cell_id'], cellId]);
      map.setFilter('fw-hotspot-selected', ['==', ['get', 'id'], sel?.kind === 'hotspot' ? sel.detectionId : '']);
      if (selectedPerimeter) map.setFeatureState({ source: SRC.perimeters, id: selectedPerimeter }, { selected: false });
      selectedPerimeter = sel?.kind === 'incident' ? sel.incidentId : null;
      if (selectedPerimeter) map.setFeatureState({ source: SRC.perimeters, id: selectedPerimeter }, { selected: true });
    },
  );
  sub(
    (s) => s.highlight,
    (h) => src(SRC.highlight)?.setData({ type: 'FeatureCollection', features: h?.boundary ? [h.boundary] : [] }),
  );
  sub(
    (s) => s.userLocation,
    (u) =>
      src(SRC.user)?.setData({
        type: 'FeatureCollection',
        features: u ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: u.lngLat }, properties: { acc: u.accuracy } }] : [],
      }),
  );

  // ---- camera → store (compass, weather chip, zoom-dependent CSS) ----------------------
  let raf = 0;
  const container = map.getContainer();
  const onMove = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const c = map.getCenter();
      const zoom = map.getZoom();
      container.classList.toggle('fw-zoom-hi', zoom >= 10.5);
      container.classList.toggle('fw-zoom-lo', zoom < 6.6);
      setState((s) => ({ map: { ...s.map, zoom, bearing: map.getBearing(), pitch: map.getPitch(), center: [c.lng, c.lat] } }));
    });
  };
  map.on('move', onMove);
  onMove();

  return () => {
    unsubs.forEach((u) => u());
    map.off('move', onMove);
    cancelAnimationFrame(raf);
  };
}
