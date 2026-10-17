import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Building2, Crosshair, Hash, Home, Map as MapIcon, Radar, Sparkles, X } from 'lucide-react';
import { askAbout, clearSearch } from '../../state/actions';
import { requestCellHistory, requestRiskArea } from '../../state/data';
import { cellsForPlace, describePoint, riskIndex, seriesForCells, summarizeCells, weatherAtPoint } from '../../state/lookups';
import { effectiveIndex, setTimeIndex, timelineOf, useStore } from '../../state/store';
import { fitBbox, flyToPoint } from '../../map/mapRef';
import { bboxOfGeometry, type LngLat } from '../../lib/geo';
import { formatPct, formatPopulation } from '../../lib/format';
import { riskColor, riskLabel, riskLevelKey, scoreCaption, scoreValue } from '../../lib/risk';
import { placeSubtitle, placeTitle } from '../../lib/search';
import { HOUR_MS, formatStamp, formatValidTime, parseTime } from '../../lib/time';
import type { PlaceResult } from '../../types';
import { RiskSparkline } from '../charts';
import { Note, OriginTag, Section } from '../ui';
import { Conditions, NearbyFires, PanelShell, WhySection, useExplanation } from './shared';

function useTimeline() {
  const tl = useStore(useShallow((s) => timelineOf(s)));
  const idx = useStore((s) => effectiveIndex(s));
  return { tl, idx, t: tl.start + idx * HOUR_MS };
}

function RiskHeadline({ score, scoreType, t, extra }: { score: number; scoreType?: string; t: number; extra?: string }) {
  if (!Number.isFinite(score))
    return (
      <div className="risk-card risk-card--low">
        <div className="risk-card__main">
          <span className="risk-card__level">Unavailable</span>
        </div>
        <div className="risk-card__when">No forecast value for {formatValidTime(t)} — it may still be loading or missing from the published forecast.</div>
      </div>
    );
  const key = riskLevelKey(score);
  return (
    <div className={`risk-card risk-card--${key}`} style={{ ['--c' as string]: riskColor(Math.max(0.2, score)) }}>
      <div className="risk-card__main">
        <span className="risk-card__level">{riskLabel(key)}</span>
        <span className="risk-card__score">
          {scoreValue(score, scoreType)}
          <small>{scoreCaption(scoreType)}</small>
        </span>
      </div>
      <div className="risk-card__meter" aria-hidden>
        <span style={{ width: `${Math.max(2, score * 100)}%` }} />
      </div>
      <div className="risk-card__when">
        Predicted for {formatValidTime(t)}
        {extra ? ` · ${extra}` : ''}
      </div>
      {key === 'low' && <div className="risk-card__note">Below the “Elevated” threshold, so this area isn’t shaded on the map.</div>}
    </div>
  );
}

function ModelFoot({ cellId }: { cellId?: string | null }) {
  const md = useStore((s) => s.risk.data?.metadata);
  const origin = useStore((s) => s.risk.origin);
  const run = parseTime(md?.generated_at);
  if (!md) return null;
  return (
    <>
      <span>
        Model {md.model_version}
        {run ? ` · run ${formatStamp(run)}` : ''}
        {cellId ? ` · ${cellId}` : ''}
      </span>
      <OriginTag origin={origin} />
    </>
  );
}

export function CellPanel({ cellId, lngLat }: { cellId: string; lngLat: LngLat }) {
  const grid = useStore((s) => s.risk.data);
  const weather = useStore((s) => s.weather.data);
  const weatherOrigin = useStore((s) => s.weather.origin);
  const index = useStore((s) => s.places.data);
  const units = useStore((s) => s.units);
  const { tl, idx, t } = useTimeline();
  const i = grid ? riskIndex(grid).byId.get(cellId) : undefined;
  const cell = i != null ? grid!.cells[i] : null;
  const ex = useExplanation(cell ? cellId : null, t);
  useEffect(() => requestCellHistory(cellId), [cellId, !!cell]);
  const series = useMemo(() => {
    if (!grid || i == null) return [];
    return seriesForCells(grid, [i], Array.from({ length: tl.frames }, (_, k) => tl.start + k * HOUR_MS));
  }, [grid, i, tl.frames, tl.start]);

  if (!grid || !cell)
    return (
      <PanelShell icon={<Radar size={18} />} title="Forecast area">
        <Note>{grid ? 'This forecast cell is not in the current forecast.' : 'The risk forecast is still loading…'}</Note>
      </PanelShell>
    );

  const md = grid.metadata;
  const score = series[idx] ?? 0;
  const p = cell.properties;
  const center: LngLat = typeof p.lon === 'number' && typeof p.lat === 'number' ? [p.lon, p.lat] : lngLat;
  const w = weatherAtPoint(weather, center, t);
  const where = describePoint(index, center, p);
  const title = where.near ? `Near ${where.near}` : 'Forecast area';
  // Conditions come from the model explanation when it has them; otherwise from the weather layer.
  const conditionsFromWeather = ex.data?.conditions?.temperature_c == null;

  return (
    <PanelShell
      icon={<Radar size={18} />}
      title={title}
      subtitle={`${where.county ? `${where.county} County · ` : ''}~${cellWidthKm(cell.geometry)} km forecast cell`}
      actions={
        <>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => askAbout(Number.isFinite(score) ? `Why is this area ${riskLabel(riskLevelKey(score)).toLowerCase()} risk at this hour?` : 'What do you know about this area at this hour?')}
          >
            <Sparkles size={16} /> Ask AI about this area
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => fitBbox(bboxOfGeometry(cell.geometry), 11)}>
            <Crosshair size={16} /> Zoom to area
          </button>
        </>
      }
      footer={<ModelFoot cellId={cellId} />}
    >
      <RiskHeadline score={score} scoreType={md.score_type} t={t} />
      <RiskSparkline
        title="Risk over the next 7 days (hourly)"
        values={series}
        start={tl.start}
        firstIndex={tl.liveIndex}
        currentIndex={idx}
        scoreType={md.score_type}
        onPick={(k) => setTimeIndex(k)}
      />
      <Section title="Conditions at this hour" aside={conditionsFromWeather ? <OriginTag origin={weatherOrigin} /> : undefined}>
        <Conditions ex={ex.data} weather={w} units={units} />
      </Section>
      <WhySection ex={ex.data} loading={ex.loading} error={ex.error} units={units} />
      <NearbyFires point={center} km={25} />
      <Note>
        {md.target}. Forecast resolution is the model grid — zooming in doesn’t add finer detail. Not an official fire warning.
      </Note>
    </PanelShell>
  );
}

/** Cell width in km from its bounding box (subtitle only). */
function cellWidthKm(g: Parameters<typeof bboxOfGeometry>[0]) {
  const b = bboxOfGeometry(g);
  return Math.max(1, Math.round((b[2] - b[0]) * 111.32 * Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180)));
}

const PlaceIcon = ({ type }: { type: PlaceResult['type'] }) =>
  type === 'county' ? <MapIcon size={18} /> : type === 'zip' ? <Hash size={18} /> : type === 'cdp' ? <Home size={18} /> : <Building2 size={18} />;

export function PlacePanel({ place }: { place: PlaceResult }) {
  const grid = useStore((s) => s.risk.data);
  const weather = useStore((s) => s.weather.data);
  const units = useStore((s) => s.units);
  const boundary = useStore((s) => (s.highlight?.place.id === place.id ? s.highlight.boundary : null));
  const { tl, idx, t } = useTimeline();
  useEffect(() => requestRiskArea(place.bbox, t), [place, t]);
  const cells = useMemo(() => (grid ? cellsForPlace(grid, place, boundary) : []), [grid, place, boundary]);
  const series = useMemo(
    () => (grid && cells.length ? seriesForCells(grid, cells, Array.from({ length: tl.frames }, (_, k) => tl.start + k * HOUR_MS)) : []),
    [grid, cells, tl.frames, tl.start],
  );
  const summary = grid && cells.length ? summarizeCells(grid, cells, t) : null;
  const maxCellId = summary && summary.maxCell >= 0 ? grid!.cells[summary.maxCell].properties.cell_id : null;
  const ex = useExplanation(maxCellId, t);
  useEffect(() => {
    if (maxCellId) requestCellHistory(maxCellId);
  }, [maxCellId]);
  const w = weatherAtPoint(weather, place.center, t);
  const pop = formatPopulation(place.population);
  const radius = place.type === 'county' ? 20 : 30;

  return (
    <PanelShell
      icon={<PlaceIcon type={place.type} />}
      title={placeTitle(place)}
      subtitle={`${placeSubtitle(place)}${pop ? ` · ${pop}` : ''}`}
      actions={
        <>
          <button type="button" className="btn btn--primary" onClick={() => askAbout(`What is the wildfire risk for ${placeTitle(place)} and why?`)}>
            <Sparkles size={16} /> Ask AI about this area
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => fitBbox(place.bbox, 12.5)}>
            <Crosshair size={16} /> Zoom to area
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              clearSearch();
              flyToPoint(place.center, 7);
            }}
          >
            <X size={16} />
          </button>
        </>
      }
      footer={<ModelFoot cellId={maxCellId} />}
    >
      {!grid && <Note>The risk forecast is still loading…</Note>}
      {grid && !summary && <Note>No forecast cells cover this place.</Note>}
      {summary && (
        <>
          <RiskHeadline
            score={summary.max}
            scoreType={grid!.metadata.score_type}
            t={t}
            extra={summary.count > 1 ? `highest of ${summary.count} cells, ${formatPct(summary.shadedShare * 100)} of area Elevated+` : undefined}
          />
          <RiskSparkline
            title={summary.count > 1 ? 'Highest risk in this area, next 7 days' : 'Risk over the next 7 days (hourly)'}
            values={series}
            start={tl.start}
            firstIndex={tl.liveIndex}
            currentIndex={idx}
            scoreType={grid!.metadata.score_type}
            onPick={(k) => setTimeIndex(k)}
          />
        </>
      )}
      <Section title="Conditions at this hour" aside={<span className="section__aside">representative point</span>}>
        <Conditions ex={null} weather={w} units={units} />
      </Section>
      {place.type === 'county' && <Note>Representative-point weather does not describe every part of this county.</Note>}
      {maxCellId && <WhySection ex={ex.data} loading={ex.loading} error={ex.error} units={units} />}
      <NearbyFires point={place.center} km={radius} />
      {place.type === 'zip' && <Note>ZIP code areas are Census ZCTA approximations — not exact USPS delivery boundaries.</Note>}
      {place.type === 'cdp' && <Note>Census-designated place: a named community without its own city government.</Note>}
    </PanelShell>
  );
}
