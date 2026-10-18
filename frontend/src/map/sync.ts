/** Keeps the single MapLibre instance in sync with the store. Never recreates the map or its sources. */
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon, Position } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { TERRAIN_EXAGGERATION, VIEW_3D_PITCH, VIEW_TRANSITION_MS, WEATHER_CITIES } from '../config';
import { loadCaBoundary } from '../api/static';
import { formatTempShort } from '../lib/format';
import { compute } from '../lib/compute';
import { PALETTES } from '../lib/palette';
import { skyPhase } from '../lib/solar';
import { HOUR_MS } from '../lib/time';
import { blendWind, lattice, latticeValid, type Lattice } from '../lib/windGrid';
import { windLevels } from '../lib/windLevels';
import { nearestWeatherPoint, riskFrame, riskIndex, weatherAtIndex, weatherFrame, windAt } from '../state/lookups';
import { requestRiskView } from '../state/data';
import { getState, playbackTickMs, setState, useStore, validTimeOf, type AppState } from '../state/store';
import type { LayerKey, RiskGrid, WeatherGrid } from '../types';
import { LayerFader } from './fade';
import { EXTRA_GROUPS, LAYER_GROUPS, SRC, applyPalette } from './layers';
import { FireMarkers } from './markers';
import { ensureVisible } from './mapRef';
import { MOTION, motionOn, tween } from './motion';
import { RiskAnimator } from './riskAnimator';
import { windFeatures } from './weatherFeatures';
import { WindFlow } from './windFlow';
import type { WindField } from '../lib/windField';
import { TERRAIN_PAINT } from './style';

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

const levelsCache = new WeakMap<WeatherGrid, Uint8Array>();
const levelsOf = (g: WeatherGrid) => {
  let lv = levelsCache.get(g);
  if (!lv) levelsCache.set(g, (lv = windLevels(g.points)));
  return lv;
};

type WindFeature = Feature<Point, { s: number; d: number; lvl: number; i?: number }>;
/** Interpolate two arrow sets that share the same points (index-aligned). */
function blendArrows(a: WindFeature[], b: WindFeature[], k: number): WindFeature[] {
  return b.map((f, i) => {
    const p = a[i];
    if (!p) return f;
    const w = blendWind(p.properties.s, (p.properties.d + 180) % 360, f.properties.s, (f.properties.d + 180) % 360, k);
    return { ...f, properties: { ...f.properties, s: w.speed, d: (w.from + 180) % 360 } };
  });
}
const samePoints = (a: WindFeature[], b: WindFeature[]) =>
  a.length === b.length && a.length > 0 && a.every((f, i) => f.geometry.coordinates[0] === b[i].geometry.coordinates[0] && f.geometry.coordinates[1] === b[i].geometry.coordinates[1]);

export function startSync(map: MapLibreMap, markers: FireMarkers): () => void {
  const unsubs: (() => void)[] = [];
  const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;
  function sub<T>(selector: (s: AppState) => T, fn: (v: T, prev: T) => void, equalityFn: (a: T, b: T) => boolean = Object.is) {
    unsubs.push(useStore.subscribe(selector, fn, { equalityFn, fireImmediately: true }));
  }
  const shallowArr = <T extends readonly unknown[]>(a: T, b: T) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const on = (type: string, fn: () => void) => {
    map.on(type as never, fn);
    unsubs.push(() => map.off(type as never, fn));
  };

  const init = getState();
  const fader = new LayerFader(map, { riskOpacity: init.riskOpacity, lod: init.statewideView });
  const cellAnim = new RiskAnimator((id, st) => map.setFeatureState({ source: SRC.cells, id }, st));
  const coarseAnim = new RiskAnimator((id, st) => map.setFeatureState({ source: SRC.coarse, id }, st));
  if (import.meta.env.DEV) Object.assign(window as object, { __fwRiskAnimator: cellAnim, __fwFader: fader });

  void loadCaBoundary()
    .then((fc) => {
      src(SRC.border)?.setData(fc);
      src(SRC.mask)?.setData(maskFrom(fc));
    })
    .catch(() => undefined);

  // ---- basemap: Default ↔ Terrain ------------------------------------------------
  const defaults = new Map<string, unknown>();
  for (const [layer, prop] of TERRAIN_PAINT)
    if (map.getLayer(layer)) defaults.set(`${layer}|${prop}`, map.getPaintProperty(layer, prop as never));
  sub(
    (s) => s.basemap,
    (b) => {
      const terrain = b === 'terrain';
      fader.set(['fw-relief', 'fw-hillshade'], terrain, { immediate: true });
      for (const [layer, prop, value] of TERRAIN_PAINT) {
        if (!map.getLayer(layer)) continue;
        map.setPaintProperty(layer, prop as never, (terrain ? value : defaults.get(`${layer}|${prop}`)) as never);
      }
    },
  );

  // ---- sky follows the selected hour (3D only) -------------------------------------
  const SKY = {
    day: { 'sky-color': '#a9cbf5', 'horizon-color': '#e8f1fb', 'fog-color': '#f2f5f8' },
    twilight: { 'sky-color': '#5d6fa8', 'horizon-color': '#f3b88a', 'fog-color': '#e9dcd3' },
    night: { 'sky-color': '#0b1736', 'horizon-color': '#26355e', 'fog-color': '#1c2540' },
  } as const;
  let skyKey = '';
  function applySky() {
    const s = getState();
    if (s.view !== '3d') return;
    const c = map.getCenter();
    const phase = skyPhase(c.lng, c.lat, validTimeOf(s));
    if (phase === skyKey) return;
    skyKey = phase;
    try {
      map.setSky({ ...SKY[phase], 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.9 });
    } catch {
      /* sky is cosmetic */
    }
  }

  // ---- camera: 2D ↔ subtle 3D (terrain eases in) ------------------------------------
  let firstView = true;
  let terrainTween: () => void = () => undefined;
  sub(
    (s) => s.view,
    (v) => {
      const animate = !firstView && motionOn();
      const duration = animate ? VIEW_TRANSITION_MS : 0;
      firstView = false;
      terrainTween();
      if (v === '3d') {
        map.setMaxPitch(70);
        const setTerrain = (exaggeration: number) => {
          try {
            map.setTerrain({ source: 'fw-terrain-dem', exaggeration });
          } catch {
            setState((s) => ({ map: { ...s.map, terrainError: true } }));
          }
        };
        if (animate) {
          // Terrain is recreated per call, so step it rather than per frame.
          let lastStep = -1;
          terrainTween = tween(duration, (k) => {
            const step = Math.round(k * 6);
            if (step === lastStep) return;
            lastStep = step;
            setTerrain(Math.max(0.05, (TERRAIN_EXAGGERATION * step) / 6));
          });
        } else setTerrain(TERRAIN_EXAGGERATION);
        skyKey = '';
        applySky();
        fader.set(['building-3d'], true, { immediate: !animate });
        map.easeTo({ pitch: map.getPitch() > 5 ? map.getPitch() : VIEW_3D_PITCH, duration, essential: true });
      } else {
        fader.set(['building-3d'], false, { immediate: true });
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

  const riskLayerIds = [...LAYER_GROUPS.risk, ...EXTRA_GROUPS.skyline];
  sub(
    (s) => s.riskOpacity,
    (riskOpacity) => fader.update({ riskOpacity }, riskLayerIds, MOTION.fast),
  );
  // ---- statewide level of detail (sample grid only) -----------------------------------
  let lodKey = '';
  let lodValues: Float32Array | null = null;
  let surfaceSeq = 0;
  let surfaceActive: 0 | 1 = 0;
  const lodNeeded = () => map.getZoom() < 7.4 && getState().layers.risk;
  async function prepareLod(grid: RiskGrid) {
    const key = `${grid.metadata.forecast_start}|${grid.metadata.model_version}|${grid.cells.length}`;
    if (key === lodKey || grid.metadata.sparse) return;
    lodKey = key;
    const { centers } = riskIndex(grid);
    const flat = new Float32Array(centers.length * 2);
    centers.forEach(([x, y], i) => {
      flat[2 * i] = x;
      flat[2 * i + 1] = y;
    });
    try {
      await compute({ op: 'prepareSurface', key, centers: flat.slice() });
      const fc = await compute<FeatureCollection<Polygon, { id: number }>>({ op: 'prepareCoarse', key, centers: flat });
      if (lodKey !== key) return;
      await src(SRC.coarse)?.setData(fc);
      coarseAnim.setCells(fc.features.map((f) => f.properties.id));
      updateLod(true);
    } catch {
      lodKey = '';
    }
  }
  function updateLod(force = false, duration = 0) {
    const s = getState();
    if (!lodKey || !lodValues || !lodNeeded()) return;
    const values = lodValues;
    if (s.statewideView === 'surface') {
      const seq = ++surfaceSeq;
      const key = lodKey;
      void compute<FeatureCollection>({ op: 'surface', key, values: values.slice(), stops: PALETTES[s.palette] })
        .then(async (fc) => {
          if (seq !== surfaceSeq || key !== lodKey) return;
          // Double-buffered: draw the new surface into the hidden source, then cross-fade.
          const next: 0 | 1 = surfaceActive ? 0 : 1;
          await src(next ? SRC.surface + '-b' : SRC.surface)?.setData(fc);
          if (seq !== surfaceSeq) return;
          surfaceActive = next;
          fader.update({ surfaceActive: next }, ['fw-risk-surface', 'fw-risk-surface-b'], force ? 0 : Math.max(duration, MOTION.base));
        })
        .catch(() => undefined);
    } else if (s.statewideView === 'coarse') {
      void compute<Float32Array>({ op: 'coarse', key: lodKey, values: values.slice() })
        .then((v) => coarseAnim.show(v, { duration: force ? 0 : duration }))
        .catch(() => undefined);
    }
  }
  on('zoomend', () => updateLod(true));

  sub(
    (s) => s.palette,
    (palette, prev) => {
      if (palette === prev) return;
      applyPalette(map, palette);
      updateLod(true);
    },
  );
  sub(
    (s) => s.statewideView,
    (lod) => {
      fader.update({ lod }, riskLayerIds);
      updateLod(true);
    },
  );


  // ---- risk grid + hourly frame ---------------------------------------------------
  let lastGrid: RiskGrid | null = null;
  function applyRisk() {
    const s = getState();
    const grid = s.risk.data;
    if (!grid) return;
    if (grid !== lastGrid) {
      const ids = grid.cells.map((c) => c.properties.cell_id);
      const prefix = !!lastGrid && grid.cells.length >= lastGrid.cells.length && lastGrid.cells.every((c, i) => grid.cells[i].properties.cell_id === c.properties.cell_id);
      const source = src(SRC.cells);
      if (prefix && lastGrid) {
        // Backend tiles append cells: add only the new ones and keep every existing cell's state.
        if (grid.cells.length > lastGrid.cells.length) void source?.updateData({ add: grid.cells.slice(lastGrid.cells.length) });
      } else {
        if (lastGrid) map.removeFeatureState({ source: SRC.cells });
        source?.setData({ type: 'FeatureCollection', features: grid.cells });
      }
      cellAnim.setCells(ids, { preserve: prefix });
      lastGrid = grid;
      void prepareLod(grid);
    }
    const n = grid.cells.length;
    const f = riskFrame(grid, validTimeOf(s));
    const values = grid.scores.subarray(f * n, (f + 1) * n);
    const duration = s.playing ? Math.min(playbackTickMs(s.speed) * 0.9, MOTION.slow) : MOTION.slow;
    // Backend mode: while the next hour's tiles load, keep the previous colours (dimmed).
    cellAnim.show(values, { duration, hold: !!grid.metadata.sparse });
    lodValues = grid.metadata.sparse ? null : values;
    updateLod(false, duration);
  }
  sub((s) => [s.risk.data, validTimeOf(s)] as const, applyRisk, shallowArr);

  // Backend mode: load the forecast tiles for what's on screen (plus a margin) at the selected hour.
  const requestView = () => {
    const s = getState();
    if (!s.layers.risk && !s.selection) return;
    const b = map.getBounds();
    requestRiskView([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], validTimeOf(s));
  };
  on('moveend', requestView);
  sub((s) => [validTimeOf(s), s.risk.origin, s.layers.risk] as const, requestView, shallowArr);

  // ---- wind + weather labels -------------------------------------------------------
  let lastW: { g: WeatherGrid | null; f: number; units: string } = { g: null, f: -1, units: '' };
  let shownWind: WindFeature[] = [];
  let windTween: () => void = () => undefined;
  const dirty = { wind: true, weather: true };
  function setWind(next: WindFeature[], duration: number) {
    windTween();
    const from = shownWind;
    if (duration > 0 && motionOn() && samePoints(from, next)) {
      let lastStep = -1;
      windTween = tween(duration, (k) => {
        const step = Math.round(k * 6);
        if (step === lastStep) return;
        lastStep = step;
        shownWind = step >= 6 ? next : blendArrows(from, next, step / 6);
        src(SRC.wind)?.setData({ type: 'FeatureCollection', features: shownWind });
      });
    } else {
      shownWind = next;
      src(SRC.wind)?.setData({ type: 'FeatureCollection', features: next });
    }
  }
  function applyWeather(force = false) {
    const s = getState();
    const g = s.weather.data;
    if (!g || weatherFrame(g, validTimeOf(s)) < 0) {
      for (const source of [SRC.wind, SRC.windLocal, SRC.weather]) src(source)?.setData({ type: 'FeatureCollection', features: [] });
      shownWind = [];
      dirty.wind = dirty.weather = true;
      lastW = { g: null, f: -1, units: '' };
      return;
    }
    const t = validTimeOf(s);
    const f = weatherFrame(g, t);
    const changed = g !== lastW.g || f !== lastW.f || s.units !== lastW.units;
    if (!changed && !force) return;
    if (changed) {
      dirty.wind = dirty.weather = true;
      lastW = { g, f, units: s.units };
    }
    if (s.layers.wind && dirty.wind) {
      setWind(windFeatures(g, t, levelsOf(g)) as WindFeature[], s.playing ? Math.min(playbackTickMs(s.speed) * 0.85, MOTION.slow) : MOTION.slow);
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

  // ---- animated wind flow (streaks travelling downwind) --------------------------------
  const flow = new WindFlow(map, motionOn);
  let flowKey = '';
  let flowSeq = 0;
  sub(
    (s) => [s.weather.data, validTimeOf(s), s.layers.wind, s.windFlow, s.smoothMotion] as const,
    ([g, t, windOn, flowOn]) => {
      const visible = windOn && flowOn && motionOn();
      flow.setVisible(visible);
      if (!visible) return;
      const f = g ? weatherFrame(g, t) : -1;
      if (!g || f < 0) {
        flowKey = '';
        flow.setField(null);
        return;
      }
      const key = `${g.metadata.generated_at}|${g.points.length}|${g.metadata.forecast_start}|${f}`;
      if (key === flowKey) return;
      flowKey = key;
      const m = g.points.length;
      const seq = ++flowSeq;
      const s = getState();
      void compute<WindField>({
        op: 'windField',
        points: g.points,
        speed: g.wind_speed_kmh.slice(f * m, (f + 1) * m),
        from: g.wind_direction_deg.slice(f * m, (f + 1) * m),
      })
        .then((field) => seq === flowSeq && flow.setField(field, s.playing ? playbackTickMs(s.speed) : 800))
        .catch(() => undefined);
    },
    shallowArr,
  );

  // City zoom: arrows on a geographic lattice — pinned to the ground while panning.
  let windLattice: Lattice | null = null;
  let localShown: WindFeature[] = [];
  let localKey = '';
  let localTween: () => void = () => undefined;
  function applyLocalWind() {
    const s = getState();
    const g = s.weather.data;
    if (!g || !s.layers.wind || map.getZoom() < 8.6) {
      if (localShown.length) src(SRC.windLocal)?.setData({ type: 'FeatureCollection', features: [] });
      localShown = [];
      windLattice = null;
      return;
    }
    const b = map.getBounds();
    const view: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const t = validTimeOf(s);
    const relaid = !latticeValid(windLattice, view, map.getZoom());
    if (relaid) windLattice = lattice(view, map.getZoom());
    const key = `${t}|${windLattice!.covers.join(',')}`;
    if (!relaid && key === localKey) return;
    const sameLattice = !relaid;
    localKey = key;
    const next: WindFeature[] = [];
    for (const p of windLattice!.points) {
      const v = windAt(g, p, t);
      next.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { s: v?.speed ?? 0, d: ((v?.dir ?? 0) + 180) % 360, lvl: v ? 3 : 99 } });
    }
    localTween();
    const from = localShown;
    if (sameLattice && motionOn() && samePoints(from, next)) {
      let lastStep = -1;
      localTween = tween(s.playing ? Math.min(playbackTickMs(s.speed) * 0.85, MOTION.slow) : MOTION.slow, (k) => {
        const step = Math.round(k * 6);
        if (step === lastStep) return;
        lastStep = step;
        localShown = step >= 6 ? next : blendArrows(from, next, step / 6);
        src(SRC.windLocal)?.setData({ type: 'FeatureCollection', features: localShown });
      });
    } else {
      localShown = next;
      src(SRC.windLocal)?.setData({ type: 'FeatureCollection', features: next });
    }
  }
  on('moveend', applyLocalWind);
  sub((s) => [s.weather.data, validTimeOf(s), s.layers.wind] as const, applyLocalWind, shallowArr);

  // ---- fires, influence shapes, perimeters, flame markers ----------------------------
  let knownIds: Set<string> | null = null;
  function applyFires() {
    const s = getState();
    const replay = s.replay;
    const all = s.fires.data?.detections ?? [];
    const clock = replay ? replay.at : s.now;
    const detections = replay ? all.filter((d) => {
      const t = Date.parse(d.acquired_at);
      return t >= replay.from && t <= replay.at;
    }) : s.derived.detections;
    // Newly arrived detections fade in (state is set before the data so they never flash).
    const fresh: string[] = [];
    if (knownIds && !replay && motionOn()) for (const d of detections) if (!knownIds.has(d.id)) fresh.push(d.id);
    for (const id of fresh) map.setFeatureState({ source: SRC.fires, id }, { a: 0 });
    void src(SRC.fires)
      ?.setData({
        type: 'FeatureCollection',
        features: detections.map((d) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
          properties: { id: d.id, age: (clock - Date.parse(d.acquired_at)) / HOUR_MS, frp: d.frp_mw ?? 1, inc: d.incident_id ?? '' },
        })),
      })
      .then(() => {
        if (fresh.length) tween(900, (k) => fresh.forEach((id) => map.setFeatureState({ source: SRC.fires, id }, { a: k })));
      });
    if (!replay) knownIds = new Set(all.map((d) => d.id));
    src(SRC.coverage)?.setData(replay ? { type: 'FeatureCollection', features: [] } : s.derived.coverage);
    const sel = s.selection;
    const selectedId = sel?.kind === 'group' ? sel.groupId : sel?.kind === 'incident' ? sel.incidentId : null;
    markers.update(replay ? [] : s.derived.groups, s.incidents.data?.incidents ?? [], s.now, s.layers.fires && !replay, selectedId);
  }
  sub((s) => [s.derived, s.now, s.selection, s.replay] as const, applyFires, shallowArr);
  on('zoom', () => markers.setZoom(map.getZoom()));

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

  // ---- layer visibility (fading) --------------------------------------------------------
  let firstLayers = true;
  sub(
    (s) => s.layers,
    (layers) => {
      for (const key of Object.keys(LAYER_GROUPS) as LayerKey[]) fader.set(LAYER_GROUPS[key], layers[key], { immediate: firstLayers });
      firstLayers = false;
      if (layers.wind || layers.weather) applyWeather(true);
      applyLocalWind();
      applyFires();
      updateLod(true);
    },
  );
  sub(
    (s) => [s.skyline, s.view, s.layers.risk] as const,
    ([skyline, view, risk]) => fader.set(EXTRA_GROUPS.skyline, skyline && view === '3d' && risk),
    shallowArr,
  );

  // ---- day / night -------------------------------------------------------------------
  let nightSeq = 0;
  let nightTween: () => void = () => undefined;
  let nightShownAt = 0;
  function setNight(t: number) {
    const seq = ++nightSeq;
    void compute<FeatureCollection>({ op: 'night', t }).then((fc) => {
      if (seq === nightSeq) src(SRC.night)?.setData(fc);
    });
    nightShownAt = t;
  }
  sub(
    (s) => [s.dayNight, validTimeOf(s)] as const,
    ([enabled, t]) => {
      fader.set(EXTRA_GROUPS.night, enabled);
      applySky();
      if (!enabled) return;
      nightTween();
      const s = getState();
      const from = nightShownAt;
      // Sweep the terminator through the intermediate times instead of jumping 15° per hour.
      if (from && Math.abs(t - from) <= 3 * HOUR_MS && motionOn()) {
        let lastStep = -1;
        nightTween = tween(s.playing ? playbackTickMs(s.speed) * 0.85 : MOTION.slow, (k) => {
          const step = Math.round(k * 4);
          if (step === lastStep) return;
          lastStep = step;
          setNight(from + ((t - from) * step) / 4);
        });
      } else setNight(t);
    },
    shallowArr,
  );

  // ---- selection + highlights ------------------------------------------------------------
  let selectedPerimeter: string | null = null;
  const drawIn = (layer: string, prop: string, from: number, to: number) => {
    if (!map.getLayer(layer)) return;
    if (!motionOn()) return map.setPaintProperty(layer, prop as never, to as never);
    map.setPaintProperty(layer, `${prop}-transition` as never, { duration: 0, delay: 0 } as never);
    map.setPaintProperty(layer, prop as never, from as never);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        map.setPaintProperty(layer, `${prop}-transition` as never, { duration: MOTION.slow, delay: 0 } as never);
        map.setPaintProperty(layer, prop as never, to as never);
      }),
    );
  };
  sub(
    (s) => s.selection,
    (sel) => {
      const cellId = sel?.kind === 'cell' ? sel.cellId : '';
      map.setFilter('fw-risk-selected', ['==', ['get', 'cell_id'], cellId]);
      map.setFilter('fw-risk-selected-halo', ['==', ['get', 'cell_id'], cellId]);
      map.setFilter('fw-hotspot-selected', ['==', ['get', 'id'], sel?.kind === 'hotspot' ? sel.detectionId : '']);
      if (cellId) {
        drawIn('fw-risk-selected-halo', 'line-width', 16, 5);
        drawIn('fw-risk-selected', 'line-width', 6, 2);
      }
      if (sel?.kind === 'hotspot') drawIn('fw-hotspot-selected', 'circle-stroke-width', 10, 2.5);
      if (selectedPerimeter) map.setFeatureState({ source: SRC.perimeters, id: selectedPerimeter }, { selected: false });
      selectedPerimeter = sel?.kind === 'incident' ? sel.incidentId : null;
      if (selectedPerimeter) map.setFeatureState({ source: SRC.perimeters, id: selectedPerimeter }, { selected: true });
      // Slide the selection clear of the details panel / bottom sheet.
      const s = getState();
      const at: [number, number] | null =
        sel?.kind === 'cell'
          ? sel.lngLat
          : sel?.kind === 'hotspot'
            ? ((d) => (d ? [d.lon, d.lat] as [number, number] : null))(s.fires.data?.detections.find((d) => d.id === sel.detectionId))
            : sel?.kind === 'group'
              ? (s.derived.groups.find((g) => g.id === sel.groupId)?.center ?? null)
              : sel?.kind === 'incident'
                ? (s.incidents.data?.incidents.find((i) => i.id === sel.incidentId)?.center ?? null)
                : null;
      if (at) requestAnimationFrame(() => ensureVisible(at));
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
  on('moveend', applySky);

  return () => {
    unsubs.forEach((u) => u());
    map.off('move', onMove);
    cancelAnimationFrame(raf);
    cellAnim.cancel();
    coarseAnim.cancel();
    flow.destroy();
    windTween();
    localTween();
    nightTween();
    terrainTween();
  };
}
