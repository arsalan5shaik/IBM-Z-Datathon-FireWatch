import type { Map as MapLibreMap, MapGeoJSONFeature, MapMouseEvent, PointLike } from 'maplibre-gl';
import { compass16 } from '../lib/geo';
import { formatFrp, formatSpeed } from '../lib/format';
import { riskColor, riskLabel, riskLevelKey, scoreValue } from '../lib/risk';
import { HOUR_MS, formatHour, formatWeekday, relativeTime } from '../lib/time';
import { cellIndexAt, riskIndex, seriesForCells } from '../state/lookups';
import { getState, select, setState, validTimeOf } from '../state/store';
import { INTERACTIVE, SRC } from './layers';
import { MOTION, motionOn, tween } from './motion';

const canHover = () => window.matchMedia?.('(hover: hover)').matches ?? true;

function pick(map: MapLibreMap, point: PointLike): MapGeoJSONFeature | null {
  const layers = INTERACTIVE.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
  if (!layers.length) return null;
  const hits = map.queryRenderedFeatures(point, { layers });
  if (!hits.length) return null;
  hits.sort((a, b) => INTERACTIVE.indexOf(a.layer.id) - INTERACTIVE.indexOf(b.layer.id));
  // A transparent (low-risk) cell still counts: clicking anywhere in California is meaningful.
  return hits[0];
}

/** Inline SVG of the next 24 hours for a cell (tooltip mini-chart). Missing hours leave gaps. */
export function miniSparkline(values: number[], current: number): string {
  const n = values.length;
  if (n < 2 || !values.some(Number.isFinite)) return '';
  const W = 120, H = 26;
  const x = (i: number) => ((i / (n - 1)) * W).toFixed(1);
  const y = (v: number) => (H - 2 - Math.max(0, Math.min(1, v)) * (H - 4)).toFixed(1);
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
    pen = true;
  });
  const cv = values[current];
  const dot = Number.isFinite(cv) ? `<circle cx="${x(current)}" cy="${y(cv)}" r="2.6" fill="${riskColor(Math.max(0.2, cv))}" stroke="#fff" stroke-width="1"/>` : '';
  return `<svg class="map-tooltip__spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>${dot}</svg>`;
}

function tooltipHtml(f: MapGeoJSONFeature): string | null {
  const s = getState();
  const p = f.properties as Record<string, unknown>;
  const t = validTimeOf(s);
  switch (f.layer.id) {
    case 'fw-hotspot': {
      const age = Number(p.age);
      return `<b>Satellite hotspot</b><span>${relativeTime(s.now - age * HOUR_MS, s.now)} · FRP ${formatFrp(Number(p.frp))}</span>`;
    }
    case 'fw-perimeter-fill':
      return `<b>${String(p.name)}</b><span>Official perimeter</span>`;
    case 'fw-coverage-fill':
      return `<b>Hotspot influence</b><span>Illustrative — not a fire perimeter</span>`;
    case 'fw-wind-0':
    case 'fw-wind-1':
    case 'fw-wind-2':
    case 'fw-wind-3': {
      const from = (Number(p.d) + 180) % 360;
      return `<b>Wind ${compass16(from)} ${formatSpeed(Number(p.s), s.units)}</b><span>${formatWeekday(t)} ${formatHour(t)}</span>`;
    }
    case 'fw-weather':
      return `<b>${String(p.name)}</b><span>${String(p.t)} · RH ${String(p.rh)} · ${formatWeekday(t)} ${formatHour(t)}</span>`;
    case 'fw-risk-fill': {
      const score = f.state?.s as number | undefined;
      if (score == null || score < 0) return null;
      const grid = s.risk.data;
      const md = grid?.metadata;
      let spark = '';
      const i = grid ? riskIndex(grid).byId.get(String(f.id ?? p.cell_id)) : undefined;
      if (grid && i != null) {
        const hours = Array.from({ length: 24 }, (_, k) => t + k * HOUR_MS);
        spark = `${miniSparkline(seriesForCells(grid, [i], hours), 0)}<small>next 24 h</small>`;
      }
      const held = (f.state?.a as number | undefined) ?? 1;
      const note = held < 0.9 ? ' · loading this hour…' : ' · click for details';
      return `<b>${riskLabel(riskLevelKey(score))} risk · ${scoreValue(score, md?.score_type)}</b><span>${formatWeekday(t)} ${formatHour(t)}${note}</span>${spark}`;
    }
  }
  return null;
}

export function bindInteractions(map: MapLibreMap, tooltip: HTMLElement): () => void {
  let hoverCell: string | number | null = null;
  const hoverLevel = new Map<string | number, number>();
  const hoverTweens = new Map<string | number, () => void>();
  let raf = 0;
  let lastEvent: MapMouseEvent | null = null;
  let tooltipShown = false;

  /** Fade the hover outline of a cell towards `to` (feature-state `h`). */
  const fadeHover = (id: string | number, to: number) => {
    hoverTweens.get(id)?.();
    const from = hoverLevel.get(id) ?? 0;
    hoverTweens.set(
      id,
      tween(MOTION.fast, (k) => {
        const v = from + (to - from) * k;
        hoverLevel.set(id, v);
        map.setFeatureState({ source: SRC.cells, id }, { h: v, hover: v > 0.5 });
        if (k >= 1 && to === 0) hoverLevel.delete(id);
      }),
    );
  };
  const setHoverCell = (id: string | number | null) => {
    if (hoverCell === id) return;
    if (hoverCell != null) fadeHover(hoverCell, 0);
    hoverCell = id;
    if (id != null) fadeHover(id, 1);
  };
  const hideTooltip = () => {
    tooltip.hidden = true;
    tooltipShown = false;
    tooltip.classList.remove('is-gliding');
    setHoverCell(null);
    map.getCanvas().style.cursor = '';
  };

  const onMove = (e: MapMouseEvent) => {
    lastEvent = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ev = lastEvent;
      if (!ev || map.isMoving()) return hideTooltip();
      const f = pick(map, ev.point);
      map.getCanvas().style.cursor = f ? 'pointer' : '';
      setHoverCell(f?.layer.id === 'fw-risk-fill' ? (f.id ?? null) : null);
      const html = f && canHover() ? tooltipHtml(f) : null;
      if (!html) {
        tooltip.hidden = true;
        tooltipShown = false;
        tooltip.classList.remove('is-gliding');
        return;
      }
      tooltip.innerHTML = html;
      const { x, y } = ev.point;
      const w = map.getContainer().clientWidth;
      const flip = x > w - 260;
      // First appearance snaps into place; afterwards the tooltip glides after the cursor.
      tooltip.classList.toggle('is-gliding', tooltipShown && motionOn());
      tooltip.style.transform = `translate(${flip ? x - 14 : x + 14}px, ${y + 14}px) translateX(${flip ? '-100%' : '0'})`;
      tooltip.hidden = false;
      tooltipShown = true;
    });
  };

  const onClick = (e: MapMouseEvent) => {
    const s = getState();
    const f = pick(map, e.point);
    const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const selectCellAt = (p: [number, number]) => {
      const grid = s.risk.data;
      if (!grid) return false;
      const i = cellIndexAt(grid, p);
      if (i < 0) return false;
      const cellId = grid.cells[i].properties.cell_id;
      if (s.selection?.kind === 'cell' && s.selection.cellId === cellId) select(null);
      else select({ kind: 'cell', cellId, lngLat: p });
      return true;
    };
    if (!f) {
      setState({ layersOpen: false, calendarOpen: false });
      if (s.selection) select(null);
      return;
    }
    const p = f.properties as Record<string, unknown>;
    switch (f.layer.id) {
      case 'fw-hotspot':
        return select({ kind: 'hotspot', detectionId: String(p.id) });
      case 'fw-perimeter-fill':
        return select({ kind: 'incident', incidentId: String(p.id) });
      case 'fw-coverage-fill': {
        const group = s.derived.groups.find((g) => g.id === p.group_id);
        if (group?.incidentId) return select({ kind: 'incident', incidentId: group.incidentId });
        return select({ kind: 'group', groupId: String(p.group_id) });
      }
      case 'fw-weather': {
        const g = f.geometry.type === 'Point' ? (f.geometry.coordinates as [number, number]) : lngLat;
        if (!selectCellAt(g)) select(null);
        return;
      }
      default:
        if (!selectCellAt(lngLat)) select(null);
    }
  };

  const onLeave = () => hideTooltip();
  map.on('mousemove', onMove);
  map.on('click', onClick);
  map.on('mouseout', onLeave);
  map.on('movestart', onLeave);
  return () => {
    map.off('mousemove', onMove);
    map.off('click', onClick);
    map.off('mouseout', onLeave);
    map.off('movestart', onLeave);
    cancelAnimationFrame(raf);
    hoverTweens.forEach((c) => c());
  };
}
