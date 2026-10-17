import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { BASEMAP_STYLE_URL, TERRAIN_ATTRIBUTION, TERRAIN_TILES } from '../config';
import { fetchJson } from '../api/http';

export const FONTS = { regular: ['Noto Sans Regular'], bold: ['Noto Sans Bold'] };

const demSource = () => ({
  type: 'raster-dem' as const,
  tiles: [TERRAIN_TILES],
  encoding: 'terrarium' as const,
  tileSize: 256,
  maxzoom: 15,
  attribution: TERRAIN_ATTRIBUTION,
});

/** Terrain-mode relief: hypsometric tint + hillshade, inserted under water and roads. */
const reliefLayers = (): LayerSpecification[] => [
  {
    id: 'fw-relief',
    type: 'color-relief',
    source: 'fw-hillshade-dem',
    layout: { visibility: 'none' },
    paint: {
      'color-relief-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 10, 0.45, 14, 0.25],
      'color-relief-color': [
        'interpolate',
        ['linear'],
        ['elevation'],
        -20, '#cfe3c1',
        0, '#cfe3c1',
        200, '#d7e6bd',
        600, '#e3e2b4',
        1200, '#e6d7a9',
        1800, '#dcc59c',
        2500, '#cdb698',
        3200, '#e4ded6',
        4200, '#ffffff',
      ],
    } as never,
  },
  {
    id: 'fw-hillshade',
    type: 'hillshade',
    source: 'fw-hillshade-dem',
    layout: { visibility: 'none' },
    paint: {
      'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 9, 0.42, 14, 0.3],
      'hillshade-shadow-color': '#4a3e2a',
      'hillshade-highlight-color': '#ffffff',
      'hillshade-accent-color': '#5d4d33',
      'hillshade-illumination-direction': 315,
    },
  },
];

function patchLiberty(base: StyleSpecification): StyleSpecification {
  const style = structuredClone(base);
  style.sources['fw-terrain-dem'] = demSource();
  style.sources['fw-hillshade-dem'] = demSource();
  const at = style.layers.findIndex((l) => l.id === 'waterway_tunnel' || l.id === 'water');
  style.layers.splice(at < 0 ? 1 : at, 0, ...reliefLayers());

  // Gentle Apple-Maps-like tuning of the Liberty palette.
  for (const l of style.layers) {
    const paint = (l as { paint?: Record<string, unknown> }).paint;
    if (!paint) continue;
    if (l.id === 'background') paint['background-color'] = '#f5f3ee';
    if (l.id === 'water') paint['fill-color'] = '#a9cdf2';
    if (l.id.startsWith('waterway') && l.type === 'line') paint['line-color'] = '#9cc4ee';
    if (l.id === 'park') {
      paint['fill-color'] = '#d9e9cb';
      paint['fill-outline-color'] = 'rgba(120, 170, 110, 0.35)';
    }
    if (l.id === 'park_outline') paint['line-opacity'] = 0.4;
  }
  const b3d = style.layers.find((l) => l.id === 'building-3d');
  if (b3d) (b3d.layout ??= {} as never).visibility = 'none';
  return style;
}

/** Raster fallback used if the vector basemap cannot be reached. */
function fallbackStyle(): StyleSpecification {
  const sub = ['a', 'b', 'c', 'd'];
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      carto: {
        type: 'raster',
        tiles: sub.map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png`),
        tileSize: 256,
        maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      },
      'fw-terrain-dem': demSource(),
      'fw-hillshade-dem': demSource(),
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f2efe9' } },
      { id: 'carto', type: 'raster', source: 'carto' },
      ...reliefLayers(),
    ],
  };
}

export async function buildStyle(): Promise<{ style: StyleSpecification; fallback: boolean }> {
  try {
    const base = await fetchJson<StyleSpecification>(BASEMAP_STYLE_URL, { timeoutMs: 12_000 });
    return { style: patchLiberty(base), fallback: false };
  } catch {
    FONTS.regular = ['Open Sans Regular'];
    FONTS.bold = ['Open Sans Semibold'];
    return { style: fallbackStyle(), fallback: true };
  }
}

/** Paint overrides that turn the standard map into a terrain map (and back). */
export const TERRAIN_PAINT: [string, string, unknown][] = [
  ['background', 'background-color', '#eeece2'],
  ['natural_earth', 'raster-opacity', ['interpolate', ['exponential', 1.5], ['zoom'], 0, 0.85, 6, 0.6, 8, 0.2]],
  ['landcover_wood', 'fill-opacity', 0.5],
  ['landcover_grass', 'fill-opacity', 0.35],
  ['park', 'fill-opacity', 0.35],
  ['landuse_residential', 'fill-opacity', 0.6],
];
