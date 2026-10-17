import type { Map as MapLibreMap, MapGeoJSONFeature, MapMouseEvent, PointLike } from 'maplibre-gl';
import { compass16 } from '../lib/geo';
import { formatFrp, formatSpeed } from '../lib/format';
import { riskLabel, riskLevelKey, scoreValue } from '../lib/risk';
import { HOUR_MS, formatHour, formatWeekday, relativeTime } from '../lib/time';
import { cellIndexAt } from '../state/lookups';
import { getState, select, setState, validTimeOf } from '../state/store';
import { INTERACTIVE, SRC } from './layers';

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
    case 'fw-wind-2': {
      const from = (Number(p.d) + 180) % 360;
      return `<b>Wind ${compass16(from)} ${formatSpeed(Number(p.s), s.units)}</b><span>${formatWeekday(t)} ${formatHour(t)}</span>`;
    }
    case 'fw-weather':
      return `<b>${String(p.name)}</b><span>${String(p.t)} · RH ${String(p.rh)} · ${formatWeekday(t)} ${formatHour(t)}</span>`;
    case 'fw-risk-fill': {
      const score = f.state?.s as number | undefined;
      if (score == null || score < 0) return null;
      const md = s.risk.data?.metadata;
      return `<b>${riskLabel(riskLevelKey(score))} risk · ${scoreValue(score, md?.score_type)}</b><span>${formatWeekday(t)} ${formatHour(t)} · click for details</span>`;
    }
  }
  return null;
}

export function bindInteractions(map: MapLibreMap, tooltip: HTMLElement): () => void {
  let hoverCell: string | number | null = null;
  let raf = 0;
  let lastEvent: MapMouseEvent | null = null;

  const setHoverCell = (id: string | number | null) => {
    if (hoverCell === id) return;
    if (hoverCell != null) map.setFeatureState({ source: SRC.cells, id: hoverCell }, { hover: false });
    hoverCell = id;
    if (id != null) map.setFeatureState({ source: SRC.cells, id }, { hover: true });
  };
  const hideTooltip = () => {
    tooltip.hidden = true;
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
        return;
      }
      tooltip.innerHTML = html;
      tooltip.hidden = false;
      const { x, y } = ev.point;
      const w = map.getContainer().clientWidth;
      const flip = x > w - 260;
      tooltip.style.transform = `translate(${flip ? x - 14 : x + 14}px, ${y + 14}px) translateX(${flip ? '-100%' : '0'})`;
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
  };
}
