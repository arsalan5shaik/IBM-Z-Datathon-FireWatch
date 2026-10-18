import type { ExpressionSpecification, GeoJSONSourceSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { API_BASE, MODEL_SCORE_COLORS, FUEL_CLASSES, HOTSPOT_AGE_COLORS, WIND_RAMP } from '../config';
import { PALETTES, RISK_ALPHA, hexToRgb, rampRgb, rgba, type PaletteKey } from '../lib/palette';
import type { LayerKey } from '../types';
import { FONTS } from './style';

export const SRC = {
  cells: 'fw-cells',
  surface: 'fw-surface',
  surfaceB: 'fw-surface-b',
  coarse: 'fw-coarse',
  mask: 'fw-mask',
  border: 'fw-border',
  highlight: 'fw-highlight',
  perimeters: 'fw-perimeters',
  coverage: 'fw-coverage',
  fires: 'fw-fires',
  wind: 'fw-wind',
  windLocal: 'fw-wind-local',
  weather: 'fw-weather',
  user: 'fw-user',
  night: 'fw-night',
} as const;

/**
 * Layers toggled together by each overlay switch. Visibility changes fade (see fade.ts), so every
 * layer listed here has an entry in OPACITY.
 */
export const LAYER_GROUPS: Record<LayerKey, string[]> = {
  vegetation: ['fw-veg-fill'],
  risk: ['fw-risk-surface', 'fw-risk-surface-b', 'fw-risk-coarse', 'fw-risk-fill', 'fw-risk-glow', 'fw-risk-edge', 'fw-risk-hover', 'fw-risk-selected-halo', 'fw-risk-selected'],
  perimeters: ['fw-perimeter-fill', 'fw-perimeter-line'],
  fires: ['fw-coverage-glow', 'fw-coverage-fill', 'fw-coverage-line', 'fw-hotspot-halo', 'fw-hotspot-pulse', 'fw-hotspot', 'fw-hotspot-selected'],
  wind: ['fw-wind-0', 'fw-wind-1', 'fw-wind-2', 'fw-wind-3'],
  weather: ['fw-weather'],
};
/** Layers with their own switches outside LAYER_GROUPS. */
export const EXTRA_GROUPS = {
  skyline: ['fw-risk-skyline'],
  night: ['fw-night'],
} as const;

/** Layers that respond to hover / click, in priority order. */
export const INTERACTIVE = ['fw-hotspot', 'fw-weather', 'fw-perimeter-fill', 'fw-coverage-fill', 'fw-wind-0', 'fw-wind-1', 'fw-wind-2', 'fw-wind-3', 'fw-risk-fill'];

/** Score (feature-state `s`; −1 = none) and alpha factor (`a`: appear / held fade). */
const S: ExpressionSpecification = ['coalesce', ['feature-state', 's'], -1];
const A: ExpressionSpecification = ['coalesce', ['feature-state', 'a'], 1];

/** Explicitly typed colour: inside `let` bindings MapLibre would otherwise infer a plain string. */
const col = (c: string): ExpressionSpecification => ['to-color', c] as ExpressionSpecification;
const ramp = (stops: [number, string | ExpressionSpecification][], input: ExpressionSpecification): ExpressionSpecification =>
  ['interpolate', ['linear'], input, ...stops.flatMap(([v, c]) => [v, typeof c === 'string' ? col(c) : c])] as ExpressionSpecification;

/** Multiply the alpha of a colour expression by `alpha` (both may be data-driven). */
function withAlpha(color: ExpressionSpecification, alpha: ExpressionSpecification): ExpressionSpecification {
  const c: ExpressionSpecification = ['to-rgba', ['var', 'c']];
  return ['let', 'c', color, ['rgba', ['at', 0, c], ['at', 1, c], ['at', 2, c], ['*', ['at', 3, c], alpha]]] as ExpressionSpecification;
}

/** Risk fill colour with the score-dependent alpha baked in (so fill-opacity can fade natively). */
export function riskFillColor(palette: PaletteKey = 'default', input: ExpressionSpecification = S, appear: ExpressionSpecification | null = A): ExpressionSpecification {
  let color: ExpressionSpecification;
  if (API_BASE) {
    const a = hexToRgb(MODEL_SCORE_COLORS[0]), b = hexToRgb(MODEL_SCORE_COLORS[1]);
    color = ['case', ['<', input, 0], col('rgba(0, 0, 0, 0)'), ['interpolate', ['linear'], input, 0, col(rgba(a, 0.4)), 1, col(rgba(b, 0.4))]] as ExpressionSpecification;
  } else {
    const stops = PALETTES[palette];
    const first = rampRgb(stops, stops[0][0]);
    color = ramp([[stops[0][0] - 0.0001, rgba(first, 0)], ...RISK_ALPHA.map(([v, alpha]) => [v, rgba(rampRgb(stops, v), alpha)] as [number, string])], input);
  }
  return appear ? withAlpha(color, appear) : color;
}
/** Opaque ramp colour (3D skyline, legend chips). */
export function riskSolidColor(palette: PaletteKey = 'default'): ExpressionSpecification {
  if (API_BASE) return ['interpolate', ['linear'], S, 0, MODEL_SCORE_COLORS[0], 1, MODEL_SCORE_COLORS[1]];
  return ramp(PALETTES[palette], S);
}
function riskGlowColor(palette: PaletteKey): ExpressionSpecification {
  if (API_BASE) return 'rgba(0, 0, 0, 0)' as unknown as ExpressionSpecification;
  const stops = PALETTES[palette];
  return withAlpha(
    ramp(
      [
        [0.55, rgba(rampRgb(stops, 0.55), 0)],
        [0.7, rgba(rampRgb(stops, 0.7), 0.28)],
        [1, rgba(rampRgb(stops, 1), 0.45)],
      ],
      S,
    ),
    A,
  );
}

// ---- opacity registry ----------------------------------------------------------------
export type StatewideView = 'surface' | 'coarse' | 'cells';
export interface OpacityCtx {
  riskOpacity: number;
  lod: StatewideView;
  /** Which of the two double-buffered surface layers is showing. */
  surfaceActive?: 0 | 1;
}
type OpacitySpec = { prop: string; value: (fade: number, ctx: OpacityCtx) => unknown };

/** Zoom ladder for detailed cells; with a statewide LOD layer the cells fade in from z5.8. */
function cellsOpacity(f: number, lod: StatewideView, ladder: [number, number][]): unknown {
  if (API_BASE || lod === 'cells') return ['interpolate', ['linear'], ['zoom'], ...ladder.flatMap(([z, k]) => [z, k * f])];
  return ['interpolate', ['linear'], ['zoom'], 5.8, 0, 6.8, ladder[0][1] * f * 0.98, ...ladder.filter(([z]) => z > 6.8).flatMap(([z, k]) => [z, k * f])];
}
const lodOpacity = (f: number) => ['interpolate', ['linear'], ['zoom'], 5.8, f, 6.8, 0];

/**
 * Non-data-driven opacity of each overlay layer as a function of a fade factor (0 hidden → 1 shown).
 * Keeping these free of feature data lets MapLibre transition them on the GPU side.
 */
export const OPACITY: Record<string, OpacitySpec[]> = {
  'fw-veg-fill': [{ prop: 'fill-opacity', value: (f) => ['interpolate', ['linear'], ['zoom'], 5, 0.42 * f, 11, 0.28 * f] }],
  'fw-risk-surface': [{ prop: 'fill-opacity', value: (f, c) => (c.lod === 'surface' && !API_BASE && (c.surfaceActive ?? 0) === 0 ? lodOpacity(f * c.riskOpacity) : 0) }],
  'fw-risk-surface-b': [{ prop: 'fill-opacity', value: (f, c) => (c.lod === 'surface' && !API_BASE && c.surfaceActive === 1 ? lodOpacity(f * c.riskOpacity) : 0) }],
  'fw-risk-coarse': [{ prop: 'fill-opacity', value: (f, c) => (c.lod === 'coarse' && !API_BASE ? lodOpacity(f * c.riskOpacity) : 0) }],
  'fw-risk-fill': [{ prop: 'fill-opacity', value: (f, c) => (API_BASE ? f * c.riskOpacity : cellsOpacity(f * c.riskOpacity, c.lod, [[5, 1], [10, 0.9], [13, 0.72]])) }],
  'fw-risk-glow': [{ prop: 'line-opacity', value: (f, c) => (API_BASE ? 0 : cellsOpacity(f * c.riskOpacity, c.lod, [[5, 1], [13, 1]])) }],
  'fw-risk-edge': [{ prop: 'line-opacity', value: (f) => ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10, f] }],
  'fw-risk-hover': [{ prop: 'line-opacity', value: (f) => f }],
  'fw-risk-selected-halo': [{ prop: 'line-opacity', value: (f) => 0.95 * f }],
  'fw-risk-selected': [{ prop: 'line-opacity', value: (f) => f }],
  'fw-risk-skyline': [{ prop: 'fill-extrusion-opacity', value: (f, c) => 0.86 * f * Math.max(0.4, c.riskOpacity) }],
  'fw-perimeter-fill': [{ prop: 'fill-opacity', value: (f) => ['interpolate', ['linear'], ['zoom'], 6, 0.12 * f, 12, 0.08 * f] }],
  'fw-perimeter-line': [{ prop: 'line-opacity', value: (f) => f }],
  'fw-coverage-glow': [{ prop: 'line-opacity', value: (f) => ['interpolate', ['linear'], ['zoom'], 7, 0, 8.5, 0.4 * f] }],
  'fw-coverage-fill': [{ prop: 'fill-opacity', value: (f) => ['interpolate', ['linear'], ['zoom'], 7, 0, 8.5, f, 13, 0.72 * f] }],
  'fw-coverage-line': [{ prop: 'line-opacity', value: (f) => ['interpolate', ['linear'], ['zoom'], 7, 0, 8.5, 0.9 * f] }],
  'fw-hotspot-halo': [{ prop: 'circle-opacity', value: (f) => f }],
  'fw-hotspot-pulse': [{ prop: 'icon-opacity', value: (f) => 0.9 * f }],
  'fw-hotspot': [
    { prop: 'circle-opacity', value: (f) => ['interpolate', ['linear'], ['zoom'], 4, 0.75 * f, 7, 0.95 * f] },
    { prop: 'circle-stroke-opacity', value: (f) => 0.9 * f },
  ],
  'fw-hotspot-selected': [{ prop: 'circle-stroke-opacity', value: (f) => f }],
  'fw-wind-0': [{ prop: 'icon-opacity', value: (f) => f }],
  'fw-wind-1': [{ prop: 'icon-opacity', value: (f) => f }],
  'fw-wind-2': [{ prop: 'icon-opacity', value: (f) => f }],
  'fw-wind-3': [{ prop: 'icon-opacity', value: (f) => f }],
  'fw-weather': [
    { prop: 'text-opacity', value: (f) => f },
    { prop: 'icon-opacity', value: (f) => f },
  ],
  'fw-night': [{ prop: 'fill-opacity', value: (f) => 0.22 * f }],
};

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });
const geojson = (extra: Partial<GeoJSONSourceSpecification> = {}): GeoJSONSourceSpecification => ({ type: 'geojson', data: empty(), ...extra });

const ageRgb = HOTSPOT_AGE_COLORS.map((a) => hexToRgb(a.color));
/** Step colour by detection age with an alpha expression (per-step rgba). */
function ageColor(alpha: ExpressionSpecification | number): ExpressionSpecification {
  const c = (i: number): ExpressionSpecification => ['rgba', ageRgb[i][0], ageRgb[i][1], ageRgb[i][2], alpha] as ExpressionSpecification;
  return [
    'step', ['get', 'age'],
    c(0),
    HOTSPOT_AGE_COLORS[0].maxHours, c(1),
    HOTSPOT_AGE_COLORS[1].maxHours, c(2),
    HOTSPOT_AGE_COLORS[2].maxHours, c(3),
  ] as ExpressionSpecification;
}

/** Wind colour by speed with the old speed-dependent opacity baked into the alpha. */
function windColor(): ExpressionSpecification {
  const alphaAt = (s: number) => (s <= 0 ? 0.7 : s <= 10 ? 0.7 + (0.15 * s) / 10 : s <= 30 ? 0.85 + (0.1 * (s - 10)) / 20 : 0.95);
  return ramp(WIND_RAMP.map(([s, hex]) => [s, rgba(hexToRgb(hex), alphaAt(s))] as [number, string]), ['get', 's']);
}

export function addOverlays(map: MapLibreMap, ctx: OpacityCtx, palette: PaletteKey) {
  const layers = map.getStyle().layers ?? [];
  const firstRoad = layers.find((l) => 'source-layer' in l && l['source-layer'] === 'transportation')?.id;
  let lastNonSymbol = -1;
  layers.forEach((l, i) => {
    if (l.type !== 'symbol') lastNonSymbol = i;
  });
  const beforeLabels = layers[lastNonSymbol + 1]?.id;
  const beforeRoads = firstRoad ?? beforeLabels;
  const op = (id: string) => Object.fromEntries((OPACITY[id] ?? []).map((spec) => [spec.prop, spec.value(1, ctx)]));

  map.addSource(SRC.cells, geojson({ promoteId: 'cell_id', tolerance: 0.2 }));
  map.addSource(SRC.surface, geojson({ tolerance: 0.3 }));
  map.addSource(SRC.surfaceB, geojson({ tolerance: 0.3 }));
  map.addSource(SRC.coarse, geojson({ promoteId: 'id', tolerance: 0.3 }));
  map.addSource(SRC.mask, geojson());
  map.addSource(SRC.border, geojson());
  map.addSource(SRC.highlight, geojson());
  map.addSource(SRC.perimeters, geojson({ promoteId: 'id' }));
  map.addSource(SRC.coverage, geojson({ promoteId: 'group_id' }));
  map.addSource(SRC.fires, geojson({ promoteId: 'id' }));
  map.addSource(SRC.wind, geojson());
  map.addSource(SRC.windLocal, geojson());
  map.addSource(SRC.weather, geojson());
  map.addSource(SRC.user, geojson());
  map.addSource(SRC.night, geojson());

  // --- under roads: vegetation + risk -------------------------------------------
  map.addLayer(
    {
      id: 'fw-veg-fill',
      type: 'fill',
      source: SRC.cells,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': ['match', ['get', 'fuel'], ...Object.entries(FUEL_CLASSES).flatMap(([k, v]) => [k, v.color]), 'rgba(0,0,0,0)'] as unknown as ExpressionSpecification,
        ...op('fw-veg-fill'),
        'fill-antialias': false,
      },
    },
    beforeRoads,
  );
  // Statewide level of detail: a smoothed surface (contours) or coarse cells, cross-fading to the
  // model cells between z5.8 and z6.8.
  for (const [id, source] of [['fw-risk-surface', SRC.surface], ['fw-risk-surface-b', SRC.surfaceB]] as const)
    map.addLayer(
      {
        id,
        type: 'fill',
        source,
        // Bands are stacked low → high; each carries its own pre-composited rgba (surface.ts).
        layout: { 'fill-sort-key': ['get', 'v'] },
        paint: { 'fill-color': ['to-color', ['get', 'fill'], 'rgba(0, 0, 0, 0)'], ...op(id), 'fill-antialias': true },
      },
      beforeRoads,
    );
  map.addLayer(
    {
      id: 'fw-risk-coarse',
      type: 'fill',
      source: SRC.coarse,
      paint: { 'fill-color': riskFillColor(palette), ...op('fw-risk-coarse'), 'fill-antialias': false },
    },
    beforeRoads,
  );
  map.addLayer(
    {
      id: 'fw-risk-fill',
      type: 'fill',
      source: SRC.cells,
      paint: { 'fill-color': riskFillColor(palette), ...op('fw-risk-fill'), 'fill-antialias': false },
    },
    beforeRoads,
  );
  map.addLayer(
    {
      id: 'fw-risk-glow',
      type: 'line',
      source: SRC.cells,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': riskGlowColor(palette),
        ...op('fw-risk-glow'),
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 9, 7, 13, 12],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 5, 3, 9, 6, 13, 10],
      },
    },
    beforeRoads,
  );

  // --- day / night ---------------------------------------------------------------
  map.addLayer(
    { id: 'fw-night', type: 'fill', source: SRC.night, layout: { visibility: 'none' }, paint: { 'fill-color': '#0b1736', ...op('fw-night'), 'fill-antialias': false } },
    beforeLabels,
  );

  // --- above roads, below labels ---------------------------------------------
  map.addLayer(
    { id: 'fw-mask', type: 'fill', source: SRC.mask, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.42 } },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-border',
      type: 'line',
      source: SRC.border,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#4b5563', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 10, 1.8], 'line-opacity': 0.55 },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-risk-edge',
      type: 'line',
      source: SRC.cells,
      minzoom: 8.5,
      paint: {
        'line-color': ['case', ['>=', S, 0.2], 'rgba(255, 255, 255, 0.5)', 'rgba(100, 116, 139, 0.14)'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.2],
        ...op('fw-risk-edge'),
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-highlight-fill',
      type: 'fill',
      source: SRC.highlight,
      paint: { 'fill-color': '#0a84ff', 'fill-opacity': 0.06 },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-highlight-glow',
      type: 'line',
      source: SRC.highlight,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#0a84ff', 'line-width': 9, 'line-blur': 7, 'line-opacity': 0.35 },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-highlight-line',
      type: 'line',
      source: SRC.highlight,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#0a84ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 12, 2.6] },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-risk-hover',
      type: 'line',
      source: SRC.cells,
      paint: {
        // `h` animates 0 → 1 so the hover outline fades instead of blinking.
        'line-color': ['rgba', 17, 24, 39, ['*', 0.7, ['coalesce', ['feature-state', 'h'], 0]]],
        'line-width': 1.6,
        ...op('fw-risk-hover'),
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-risk-selected-halo',
      type: 'line',
      source: SRC.cells,
      filter: ['==', ['get', 'cell_id'], ''],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 5, ...op('fw-risk-selected-halo') },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-risk-selected',
      type: 'line',
      source: SRC.cells,
      filter: ['==', ['get', 'cell_id'], ''],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#111827', 'line-width': 2, ...op('fw-risk-selected') },
    },
    beforeLabels,
  );

  // Official perimeters: solid dark red. Illustrative influence: dashed orange glow.
  map.addLayer(
    {
      id: 'fw-perimeter-fill',
      type: 'fill',
      source: SRC.perimeters,
      paint: { 'fill-color': '#9f1d12', ...op('fw-perimeter-fill') },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-perimeter-line',
      type: 'line',
      source: SRC.perimeters,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], 'rgba(159, 29, 18, 1)', 'rgba(159, 29, 18, 0.85)'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 12, 2.6],
        ...op('fw-perimeter-line'),
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-coverage-glow',
      type: 'line',
      source: SRC.coverage,
      minzoom: 7,
      paint: {
        'line-color': '#ff5a00',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 13, 14],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 5, 13, 10],
        ...op('fw-coverage-glow'),
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-coverage-fill',
      type: 'fill',
      source: SRC.coverage,
      minzoom: 7,
      paint: {
        'fill-color': ['rgba', 255, 122, 26, ['*', 0.28, ['+', 0.5, ['get', 'visual_intensity']]]],
        ...op('fw-coverage-fill'),
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-coverage-line',
      type: 'line',
      source: SRC.coverage,
      minzoom: 7,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': '#d9480f',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.1, 13, 2],
        'line-dasharray': [2, 1.5],
        ...op('fw-coverage-line'),
      },
    },
    beforeLabels,
  );

  // Wind arrows at three densities.
  const windLayer = (id: string, level: number, minzoom: number, maxzoom: number, source: string = SRC.wind) =>
    map.addLayer(
      {
        id,
        type: 'symbol',
        source,
        minzoom,
        maxzoom,
        filter: ['<=', ['get', 'lvl'], level],
        layout: {
          visibility: 'none',
          'icon-image': 'fw-arrow',
          'icon-rotate': ['get', 'd'],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': ['interpolate', ['linear'], ['get', 's'], 0, 0.8, 20, 1.0, 45, 1.25, 70, 1.5],
        },
        paint: {
          'icon-color': windColor(),
          ...op(id),
          'icon-halo-color': 'rgba(255,255,255,0.85)',
          'icon-halo-width': 1.5,
        },
      },
      beforeLabels,
    );
  windLayer('fw-wind-0', 0, 0, 6.4);
  windLayer('fw-wind-1', 1, 6.4, 7.7);
  windLayer('fw-wind-2', 2, 7.7, 8.6);
  // City zoom: arrows on a geographic lattice that moves with the map (see windGrid.ts).
  windLayer('fw-wind-3', 3, 8.6, 24, SRC.windLocal);

  // Satellite hotspots: flat on the ground in 3D, size ~ FRP, colour ~ age.
  const size: ExpressionSpecification = ['interpolate', ['linear'], ['sqrt', ['coalesce', ['get', 'frp'], 1]], 0, 1, 2, 1.25, 5, 1.7, 12, 2.4];
  // Zoom must be the top-level interpolation input, so scaled variants are generated rather than wrapped.
  const radiusExpr = (k = 1, add = 0): ExpressionSpecification => [
    'interpolate', ['exponential', 1.7], ['zoom'],
    4, ['+', add, ['*', 1.2 * k, size]],
    8, ['+', add, ['*', 2.2 * k, size]],
    12, ['+', add, ['*', 3.6 * k, size]],
    16, ['+', add, ['*', 11 * k, size]],
  ];
  map.addLayer(
    {
      id: 'fw-hotspot-halo',
      type: 'circle',
      source: SRC.fires,
      minzoom: 5,
      paint: {
        'circle-radius': radiusExpr(2.4),
        'circle-color': ageColor(['*', A, ['interpolate', ['linear'], ['get', 'age'], 0, 0.55, 12, 0.3, 48, 0.12]] as ExpressionSpecification),
        'circle-blur': 1,
        ...op('fw-hotspot-halo'),
        'circle-pitch-alignment': 'map',
      },
    },
    beforeLabels,
  );
  // Fresh (< 3 h) detections get an animated ring (canvas icon, see icons.ts).
  map.addLayer(
    {
      id: 'fw-hotspot-pulse',
      type: 'symbol',
      source: SRC.fires,
      minzoom: 5,
      filter: ['<', ['get', 'age'], 3],
      layout: {
        'icon-image': 'fw-pulse',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-pitch-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 9, 0.6, 13, 1],
      },
      paint: { ...op('fw-hotspot-pulse') },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-hotspot',
      type: 'circle',
      source: SRC.fires,
      paint: {
        'circle-radius': radiusExpr(),
        'circle-color': ageColor(A),
        'circle-stroke-color': '#7a2e05',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 12, 1.4],
        ...op('fw-hotspot'),
        'circle-pitch-alignment': 'map',
        'circle-pitch-scale': 'map',
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-hotspot-selected',
      type: 'circle',
      source: SRC.fires,
      filter: ['==', ['get', 'id'], ''],
      paint: {
        'circle-radius': radiusExpr(1, 5),
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#111827',
        'circle-stroke-width': 2.5,
        ...op('fw-hotspot-selected'),
        'circle-pitch-alignment': 'map',
      },
    },
    beforeLabels,
  );

  // 3D "risk skyline": cells raised by score (feature-state, so heights morph with the hour).
  const h: ExpressionSpecification = ['max', 0, ['-', S, 0.15]];
  map.addLayer(
    {
      id: 'fw-risk-skyline',
      type: 'fill-extrusion',
      source: SRC.cells,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': riskSolidColor(palette),
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 5, ['*', h, 42000], 8, ['*', h, 14000], 12, ['*', h, 2500]],
        'fill-extrusion-base': 0,
        ...op('fw-risk-skyline'),
        'fill-extrusion-vertical-gradient': true,
      },
    },
    beforeLabels,
  );

  // User location
  map.addLayer({
    id: 'fw-user-accuracy',
    type: 'circle',
    source: SRC.user,
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, 0, 20, ['/', ['get', 'acc'], 0.119]],
      'circle-color': '#0a84ff',
      'circle-opacity': 0.12,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: 'fw-user-dot',
    type: 'circle',
    source: SRC.user,
    paint: { 'circle-radius': 7, 'circle-color': '#0a84ff', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
  });

  // Weather labels on top.
  map.addLayer({
    id: 'fw-weather',
    type: 'symbol',
    source: SRC.weather,
    layout: {
      visibility: 'none',
      'symbol-sort-key': ['get', 'rank'],
      'text-field': ['format', ['get', 't'], { 'font-scale': 1 }, '  ', {}, ['get', 'rh'], { 'font-scale': 0.82, 'text-color': '#2563eb' }],
      'text-font': FONTS.bold,
      'text-size': 12.5,
      'text-offset': [0, -1.6],
      'icon-image': 'fw-pill',
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [3, 7, 3, 7],
      'text-padding': 6,
    },
    paint: { 'text-color': '#1d1d1f', ...op('fw-weather') },
  });
}

/** Re-colour the risk layers after a palette change (data-driven: one relayout, not per frame). */
export function applyPalette(map: MapLibreMap, palette: PaletteKey) {
  if (map.getLayer('fw-risk-fill')) map.setPaintProperty('fw-risk-fill', 'fill-color', riskFillColor(palette));
  if (map.getLayer('fw-risk-coarse')) map.setPaintProperty('fw-risk-coarse', 'fill-color', riskFillColor(palette));
  if (map.getLayer('fw-risk-glow')) map.setPaintProperty('fw-risk-glow', 'line-color', riskGlowColor(palette));
  if (map.getLayer('fw-risk-skyline')) map.setPaintProperty('fw-risk-skyline', 'fill-extrusion-color', riskSolidColor(palette));
}

export const setVisible = (map: MapLibreMap, ids: readonly string[], on: boolean) => {
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
};
