import type { ExpressionSpecification, GeoJSONSourceSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { API_BASE, MODEL_SCORE_COLORS, FUEL_CLASSES, HOTSPOT_AGE_COLORS, RISK_RAMP, WIND_RAMP } from '../config';
import type { LayerKey } from '../types';
import { FONTS } from './style';

export const SRC = {
  cells: 'fw-cells',
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
} as const;

export const LAYER_GROUPS: Record<LayerKey, string[]> = {
  vegetation: ['fw-veg-fill'],
  risk: ['fw-risk-fill', 'fw-risk-glow', 'fw-risk-edge', 'fw-risk-hover', 'fw-risk-selected-halo', 'fw-risk-selected'],
  perimeters: ['fw-perimeter-fill', 'fw-perimeter-line'],
  fires: ['fw-coverage-glow', 'fw-coverage-fill', 'fw-coverage-line', 'fw-hotspot-halo', 'fw-hotspot', 'fw-hotspot-selected'],
  wind: ['fw-wind-0', 'fw-wind-1', 'fw-wind-2', 'fw-wind-3'],
  weather: ['fw-weather'],
};

/** Layers that respond to hover / click, in priority order. */
export const INTERACTIVE = ['fw-hotspot', 'fw-weather', 'fw-perimeter-fill', 'fw-coverage-fill', 'fw-wind-0', 'fw-wind-1', 'fw-wind-2', 'fw-wind-3', 'fw-risk-fill'];

const S: ExpressionSpecification = ['coalesce', ['feature-state', 's'], -1];
const ramp = (stops: [number, string][], input: ExpressionSpecification): ExpressionSpecification =>
  ['interpolate', ['linear'], input, ...stops.flat()] as ExpressionSpecification;

export const riskColor = (): ExpressionSpecification => API_BASE ? ['interpolate', ['linear'], S, 0, MODEL_SCORE_COLORS[0], 1, MODEL_SCORE_COLORS[1]] : ramp(RISK_RAMP, S);

export function riskFillOpacity(f: number): ExpressionSpecification {
  if (API_BASE) return ['case', ['>=', S, 0], 0.4 * f, 0];
  const at = (k: number): ExpressionSpecification =>
    ['interpolate', ['linear'], S, 0.1999, 0, 0.2, 0.3 * k * f, 0.4, 0.44 * k * f, 0.6, 0.54 * k * f, 0.8, 0.62 * k * f, 1, 0.68 * k * f];
  return ['interpolate', ['linear'], ['zoom'], 5, at(1), 10, at(0.9), 13, at(0.72)];
}
export const riskGlowOpacity = (f: number): ExpressionSpecification => API_BASE ? ['literal', 0] : ['interpolate', ['linear'], S, 0.55, 0, 0.7, 0.28 * f, 1, 0.45 * f];

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });
const geojson = (extra: Partial<GeoJSONSourceSpecification> = {}): GeoJSONSourceSpecification => ({ type: 'geojson', data: empty(), ...extra });

export function addOverlays(map: MapLibreMap, opacity: number) {
  const layers = map.getStyle().layers ?? [];
  const firstRoad = layers.find((l) => 'source-layer' in l && l['source-layer'] === 'transportation')?.id;
  let lastNonSymbol = -1;
  layers.forEach((l, i) => {
    if (l.type !== 'symbol') lastNonSymbol = i;
  });
  const beforeLabels = layers[lastNonSymbol + 1]?.id;
  const beforeRoads = firstRoad ?? beforeLabels;

  map.addSource(SRC.cells, geojson({ promoteId: 'cell_id', tolerance: 0.2 }));
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

  // --- under roads: vegetation + risk -------------------------------------------
  map.addLayer(
    {
      id: 'fw-veg-fill',
      type: 'fill',
      source: SRC.cells,
      layout: { visibility: 'none' },
      paint: {
        'fill-color': ['match', ['get', 'fuel'], ...Object.entries(FUEL_CLASSES).flatMap(([k, v]) => [k, v.color]), 'rgba(0,0,0,0)'] as unknown as ExpressionSpecification,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.42, 11, 0.28],
        'fill-antialias': false,
      },
    },
    beforeRoads,
  );
  map.addLayer(
    {
      id: 'fw-risk-fill',
      type: 'fill',
      source: SRC.cells,
      paint: { 'fill-color': riskColor(), 'fill-opacity': riskFillOpacity(opacity), 'fill-antialias': false },
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
        'line-color': riskColor(),
        'line-opacity': riskGlowOpacity(opacity),
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 9, 7, 13, 12],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 5, 3, 9, 6, 13, 10],
      },
    },
    beforeRoads,
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
        'line-color': ['case', ['>=', S, 0.2], '#ffffff', '#64748b'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.2],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10, ['case', ['>=', S, 0.2], 0.5, 0.14]],
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
        'line-color': '#111827',
        'line-width': 1.6,
        'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.7, 0],
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
      paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.95 },
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
      paint: { 'line-color': '#111827', 'line-width': 2 },
    },
    beforeLabels,
  );

  // Official perimeters: solid dark red. Illustrative influence: dashed orange glow.
  map.addLayer(
    {
      id: 'fw-perimeter-fill',
      type: 'fill',
      source: SRC.perimeters,
      paint: { 'fill-color': '#9f1d12', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.12, 12, 0.08] },
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
        'line-color': '#9f1d12',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.2, 12, 2.6],
        'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0.85],
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
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8.5, 0.4],
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
        'fill-color': '#ff7a1a',
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8.5, ['*', 0.28, ['+', 0.5, ['get', 'visual_intensity']]], 13, 0.2],
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
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8.5, 0.9],
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
          'icon-color': ramp(WIND_RAMP, ['get', 's']),
          'icon-opacity': ['interpolate', ['linear'], ['get', 's'], 0, 0.7, 10, 0.85, 30, 0.95],
          'icon-halo-color': 'rgba(255,255,255,0.85)',
          'icon-halo-width': 1.5,
        },
      },
      beforeLabels,
    );
  windLayer('fw-wind-0', 0, 0, 6.4);
  windLayer('fw-wind-1', 1, 6.4, 7.7);
  windLayer('fw-wind-2', 2, 7.7, 8.6);
  // City zoom: arrows interpolated on a screen-space grid (see sync.ts).
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
  const radius = radiusExpr();
  const ageColor: ExpressionSpecification = [
    'step', ['get', 'age'],
    HOTSPOT_AGE_COLORS[0].color,
    HOTSPOT_AGE_COLORS[0].maxHours, HOTSPOT_AGE_COLORS[1].color,
    HOTSPOT_AGE_COLORS[1].maxHours, HOTSPOT_AGE_COLORS[2].color,
    HOTSPOT_AGE_COLORS[2].maxHours, HOTSPOT_AGE_COLORS[3].color,
  ];
  map.addLayer(
    {
      id: 'fw-hotspot-halo',
      type: 'circle',
      source: SRC.fires,
      minzoom: 5,
      paint: {
        'circle-radius': radiusExpr(2.4),
        'circle-color': ageColor,
        'circle-blur': 1,
        'circle-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 0.55, 12, 0.3, 48, 0.12],
        'circle-pitch-alignment': 'map',
      },
    },
    beforeLabels,
  );
  map.addLayer(
    {
      id: 'fw-hotspot',
      type: 'circle',
      source: SRC.fires,
      paint: {
        'circle-radius': radius,
        'circle-color': ageColor,
        'circle-stroke-color': '#7a2e05',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 12, 1.4],
        'circle-stroke-opacity': 0.9,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.75, 7, 0.95],
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
        'circle-pitch-alignment': 'map',
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
    paint: { 'text-color': '#1d1d1f' },
  });
}

export const setVisible = (map: MapLibreMap, ids: string[], on: boolean) => {
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
};
