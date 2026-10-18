import { type Map as MapLibreMap } from 'maplibre-gl';

const SOURCE = 'fw-v6-historical';
const HEAT = 'fw-v6-historical-heat';
const GLOW = 'fw-v6-historical-glow';
const DOTS = 'fw-v6-historical-points';
const DATE = '2025-07-09';

type Metadata = { count: number; p05: number; p95: number; date: string };
type ThresholdMode = 'top10' | 'top25' | 'all';
const quantile = (values: number[], q: number) => values[Math.min(values.length - 1, Math.round((values.length - 1) * q))];
const percentile = (values: number[], score: number) => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < score) low = mid + 1;
    else high = mid;
  }
  return (low / values.length) * 100;
};

/** OBSERVED-WEATHER historical model results, not current fire detections or a live forecast. */
export function mountHistoricalERCLayer(map: MapLibreMap): () => void {
  let active = true;
  let removeHeatClick: (() => void) | undefined;
  const controller = new AbortController();
  let visible = true;
  let mode: ThresholdMode = 'top10';
  let thresholds: Record<ThresholdMode, number> = { top10: Infinity, top25: Infinity, all: -Infinity };
  let sortedScores: number[] = [];
  let metadata: Metadata | undefined;

  const control = document.createElement('div');
  control.setAttribute('role', 'group');
  control.setAttribute('aria-label', 'Historical model layer controls');
  Object.assign(control.style, {
    position: 'absolute', top: '118px', left: '58px', zIndex: '10',
    background: 'rgba(17, 29, 43, .92)', backdropFilter: 'blur(15px)',
    color: '#f1f5f9', borderRadius: '10px', border: '1px solid #64748b77',
    boxShadow: '0 4px 18px #0005', padding: '9px 11px',
    fontFamily: 'Inter, system-ui, sans-serif', fontSize: '12px',
    maxWidth: '310px',
  });
  const topRow = document.createElement('label');
  Object.assign(topRow.style, { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '700', cursor: 'pointer' });
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.style.accentColor = '#9d5db1';
  checkbox.setAttribute('aria-label', 'Show or hide historical ERC-G data');
  const title = document.createElement('span');
  title.textContent = 'Historical ERC-G · Loading…';
  topRow.append(checkbox, title);
  const controlsRow = document.createElement('div');
  Object.assign(controlsRow.style, { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' });
  const thresholdLabel = document.createElement('label');
  thresholdLabel.textContent = 'Show:';
  thresholdLabel.htmlFor = 'fw-historical-cutoff';
  const cutoff = document.createElement('select');
  cutoff.id = 'fw-historical-cutoff';
  cutoff.setAttribute('aria-label', 'Historical score percentile filter');
  Object.assign(cutoff.style, {
    flex: '1', background: '#273648', color: '#f8fafc',
    border: '1px solid #718096', borderRadius: '6px', padding: '4px 6px',
    fontSize: '11px', cursor: 'pointer',
  });
  for (const [value, label] of [
    ['top10', 'Top 10% of scores'],
    ['top25', 'Top 25% of scores'],
    ['all', 'All measured cells'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    cutoff.appendChild(option);
  }
  cutoff.value = mode;
  const info = document.createElement('div');
  Object.assign(info.style, { fontSize: '10px', color: '#cbd5e1', marginTop: '6px', lineHeight: '1.4' });
  info.textContent = 'Historical model index · Not live fire sightings or ignition probability';
  controlsRow.append(thresholdLabel, cutoff);
  control.append(topRow, controlsRow, info);
  map.getContainer().appendChild(control);

  function updateVisibility() {
    if (!metadata || !map.getLayer(DOTS)) return;
    const limit = thresholds[mode];
    const filter: any = mode === 'all' ? ['has', 'erc_g_display'] : ['>=', ['get', 'erc_g_display'], limit];
    for (const id of [HEAT, GLOW, DOTS]) {
      if (!map.getLayer(id)) continue;
      map.setFilter(id, filter);
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
    const howMany = sortedScores.length - sortedScores.findIndex((v) => v >= limit);
    const count = mode === 'all' ? metadata.count : Math.max(0, howMany);
    info.textContent = `${count.toLocaleString()} of ${metadata.count.toLocaleString()} historical cells shown · ` +
      (mode === 'all' ? 'All scores' : `ERC-G ≥ ${limit.toFixed(1)}`) +
      '. Click a shaded area to zoom, then click a dot for its score. These are NOT current fire locations.';
  }

  const onPoint = (e: { features?: GeoJSON.Feature[]; lngLat: { lng: number; lat: number } }) => {
    const properties = e.features?.[0]?.properties;
    if (!properties || !metadata || !active) return;
    const score = Number(properties.erc_g_display);
    if (!Number.isFinite(score)) return;
    const feature = e.features?.[0];
    const coordinates = feature?.geometry.type === 'Point'
      ? feature.geometry.coordinates
      : [e.lngLat.lng, e.lngLat.lat];
    window.dispatchEvent(new CustomEvent('firewatch:historical-cell', {
      detail: {
        cell_id: String(properties.cell_id),
        score,
        date: DATE,
        lat: coordinates[1],
        lon: coordinates[0],
        percentile: percentile(sortedScores, score),
        state_median: quantile(sortedScores, 0.5),
        p05: metadata.p05,
        p95: metadata.p95,
        cell_count: metadata.count,
      },
    }));
  };
  const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
  const leave = () => { map.getCanvas().style.cursor = ''; };
  const onToggle = () => { visible = checkbox.checked; updateVisibility(); };
  const onSelect = () => { mode = cutoff.value as ThresholdMode; updateVisibility(); };
  checkbox.addEventListener('change', onToggle);
  cutoff.addEventListener('change', onSelect);

  void (async () => {
    try {
      const [metaResponse, geoResponse] = await Promise.all([
        fetch(`/data/erc-v6-historical-${DATE}-meta.json`, { signal: controller.signal }),
        fetch(`/data/erc-v6-historical-${DATE}.geojson`, { signal: controller.signal }),
      ]);
      if (!metaResponse.ok || !geoResponse.ok) throw new Error(`Historical assets ${metaResponse.status}/${geoResponse.status}`);
      const meta = await metaResponse.json() as Metadata;
      const geo = await geoResponse.json() as GeoJSON.FeatureCollection;
      if (!active) return;
      const values = geo.features.map((feature) => Number(feature.properties?.erc_g_display))
        .filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      if (values.length < 10000) throw new Error('Historical dataset unexpectedly small');
      sortedScores = values;
      metadata = meta;
      thresholds = { top10: quantile(values, 0.90), top25: quantile(values, 0.75), all: -Infinity };
      const lo = meta.p05;
      const hi = meta.p95 > lo ? meta.p95 : lo + 1;
      const ramp: any = ['interpolate', ['linear'], ['get', 'erc_g_display'],
        lo, '#fff5e6', lo + (hi - lo) * 0.35, '#e2b9d8',
        lo + (hi - lo) * 0.7, '#bb78b5', hi, '#7a1c8c'];
      map.addSource(SOURCE, { type: 'geojson', data: geo, tolerance: 0.25 });
      // At statewide zoom, use a subtle density wash instead of fake-looking giant numbered clusters.
      map.addLayer({ id: HEAT, type: 'heatmap', source: SOURCE, maxzoom: 8.5,
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'erc_g_display'], lo, 0.15, hi, 0.95],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.75, 8, 1.1],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 8, 8, 22],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.46, 7.7, 0.36, 8.5, 0],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(255,245,230,0)', 0.3, 'rgba(245,209,230,0.38)',
            0.6, 'rgba(188,112,177,0.68)', 1, 'rgba(122,28,140,0.86)'],
        },
      });
      map.addLayer({ id: GLOW, type: 'circle', source: SOURCE, minzoom: 8.5,
        paint: {
          'circle-color': ramp,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.5, 4.8, 12, 9],
          'circle-blur': 0.65, 'circle-opacity': 0.24,
        },
      });
      map.addLayer({ id: DOTS, type: 'circle', source: SOURCE, minzoom: 8.5,
        paint: {
          'circle-color': ramp,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8.5, 2.8, 11, 4.4, 14, 7],
          'circle-opacity': 0.53,
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.1, 'circle-stroke-opacity': 0.78,
        },
      });
      map.on('click', DOTS, onPoint);
      // Click a historical heatmap region to reveal its actual cells.
      const onHeatClick = (event: {
        lngLat: { lng: number; lat: number };
      }) => {
        if (!visible || !active) return;

        map.easeTo({
          center: [event.lngLat.lng, event.lngLat.lat],
          zoom: Math.max(9.5, map.getZoom() + 2.5),
          duration: 850,
        });
      };

      map.on('click', HEAT, onHeatClick);
      map.on('mouseenter', HEAT, enter);
      map.on('mouseleave', HEAT, leave);

      removeHeatClick = () => {
        map.off('click', HEAT, onHeatClick);
        map.off('mouseenter', HEAT, enter);
        map.off('mouseleave', HEAT, leave);
      };

      map.on('mouseenter', DOTS, enter);
      map.on('mouseleave', DOTS, leave);
      title.textContent = `Historical ERC-G · ${meta.count.toLocaleString()} cells`;
      updateVisibility();
    } catch (error) {
      if (active) {
        console.warn('Historical model layer failed', error);
        title.textContent = 'Historical layer unavailable';
        checkbox.disabled = true;
        cutoff.disabled = true;
      }
    }
  })();

  return () => {
    active = false;
    controller.abort();
    checkbox.removeEventListener('change', onToggle);
    cutoff.removeEventListener('change', onSelect);
    removeHeatClick?.();
    control.remove();
    for (const id of [DOTS, GLOW, HEAT]) {
      if (!map.getLayer(id)) continue;
      if (id === DOTS) {
        map.off('click', DOTS, onPoint);
        map.off('mouseenter', DOTS, enter);
        map.off('mouseleave', DOTS, leave);
      }
      map.removeLayer(id);
    }
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  };
}
