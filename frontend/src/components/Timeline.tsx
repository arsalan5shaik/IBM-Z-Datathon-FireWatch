import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CalendarDays, ChevronLeft, ChevronRight, Info, Pause, Play, RotateCcw, TrendingUp, X } from 'lucide-react';
import { cellsForPlace, riskIndex, seriesForCells, statewideShare } from '../state/lookups';
import { effectiveIndex, getState, goLive, setState, setTimeIndex, stepTime, timelineOf, togglePlay, useStore } from '../state/store';
import { HOUR_MS, dayName, daySegments, formatHour, formatMonthDay, formatStamp, formatValidTime, formatWeekday, localParts, parseTime, relativeTime, tzAbbrev } from '../lib/time';
import { scoreValue } from '../lib/risk';

const THUMB = 18;
const pos = (frac: number) => `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${frac})`;

/** Hour-by-hour trend for the background sparkline: selected area, or statewide share of High+ cells. */
function useTrend(frames: number, start: number) {
  const risk = useStore((s) => s.risk.data);
  const selection = useStore((s) => s.selection);
  const highlight = useStore((s) => s.highlight);
  return useMemo(() => {
    if (!risk) return null;
    const hours = Array.from({ length: frames }, (_, i) => start + i * HOUR_MS);
    let cells: number[] | null = null;
    let label = 'Statewide share of cells at High risk or above';
    if (selection?.kind === 'cell') {
      const i = riskIndex(risk).byId.get(selection.cellId);
      if (i != null) cells = [i];
      label = 'Risk score for the selected area';
    } else if (selection?.kind === 'place') {
      cells = cellsForPlace(risk, selection.place, highlight?.place.id === selection.place.id ? highlight.boundary : null);
      label = `Highest risk score in ${selection.place.name}`;
    }
    if (cells?.length) return { values: seriesForCells(risk, cells, hours), label, absolute: true };
    // Backend mode only holds the area on screen, so a statewide trend would mislead.
    if (risk.metadata.sparse) return null;
    const share = statewideShare(risk);
    const md = risk.metadata;
    const values = hours.map((h) => share[Math.max(0, Math.min(md.frames - 1, Math.floor((h - Date.parse(md.forecast_start)) / (md.step_minutes * 60_000))))]);
    const max = Math.max(0.05, ...values);
    return { values: values.map((v) => v / max), label, absolute: false };
  }, [risk, selection, highlight, frames, start]);
}

function Sparkline({ values }: { values: number[] }) {
  const n = values.length;
  if (n < 2) return null;
  // Decorative background: missing hours sit on the baseline (the panel chart shows real gaps).
  const pts = values.map((v, i) => `${((i / (n - 1)) * 1000).toFixed(1)},${(40 - Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)) * 36).toFixed(1)}`);
  return (
    <svg className="timeline__trend" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="fw-trend" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#FFB547" stopOpacity="0.15" />
          <stop offset="0.6" stopColor="#E8262B" stopOpacity="0.35" />
          <stop offset="1" stopColor="#5B1A8C" stopOpacity="0.5" />
        </linearGradient>
      </defs>
      <path d={`M0,40 L${pts.join(' L')} L1000,40 Z`} fill="url(#fw-trend)" />
      <path d={`M${pts.join(' L')}`} fill="none" stroke="#E8262B" strokeOpacity="0.45" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function InfoPopover({ onClose }: { onClose: () => void }) {
  const risk = useStore((s) => s.risk.data?.metadata);
  const weather = useStore((s) => s.weather.data?.metadata);
  const fires = useStore((s) => s.fires.data?.metadata);
  const now = useStore((s) => s.now);
  const t = useStore((s) => {
    const tl = timelineOf(s);
    return tl.start + effectiveIndex(s, tl) * tl.step;
  });
  const start = parseTime(risk?.forecast_start);
  const runAt = parseTime(risk?.generated_at);
  const wAt = parseTime(weather?.generated_at);
  const fAt = parseTime(fires?.generated_at);
  return (
    <div className="popover timeline-pop" role="dialog" aria-label="About forecast times">
      <div className="popover__head">
        <h2>Forecast times</h2>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <dl className="stats stats--compact">
        <dt>Valid time</dt>
        <dd>
          {formatValidTime(t)}
          <small>The hour the map’s forecast applies to</small>
        </dd>
        <dt>Model run</dt>
        <dd>
          {runAt ? formatStamp(runAt) : 'Unavailable'}
          <small>{risk ? `${risk.model_version} · ${risk.score_type === 'calibrated_probability' ? 'calibrated' : 'uncalibrated score'}` : ''}</small>
        </dd>
        <dt>Weather data</dt>
        <dd>{wAt ? formatStamp(wAt) : 'Unavailable'}</dd>
        <dt>Hotspots updated</dt>
        <dd>{fAt ? `${formatStamp(fAt)} (${relativeTime(fAt, now)})` : 'Unavailable'}</dd>
        <dt>Covers</dt>
        <dd>
          {start && risk
            ? `${formatMonthDay(start)} ${formatHour(start)} → ${formatMonthDay(start + (risk.frames * risk.step_minutes - 60) * 60_000)} · ${risk.step_minutes === 60 ? 'hourly' : `every ${Math.round(risk.step_minutes / 60)} h`}`
            : 'Unavailable'}
        </dd>
      </dl>
      <p className="note note--muted">Shortcuts: [ ] step an hour, Shift+[ ] a day, P play, L live.</p>
    </div>
  );
}

function CalendarPopover({ onClose }: { onClose: () => void }) {
  const tl = useStore(useShallow((s) => timelineOf(s)));
  const idx = useStore((s) => effectiveIndex(s));
  const risk = useStore((s) => s.risk.data);
  const now = useStore((s) => s.now);
  const segments = daySegments(tl.start, HOUR_MS, tl.frames).filter((d) => d.endIndex >= tl.liveIndex);
  const current = segments.find((d) => idx >= d.startIndex && idx <= d.endIndex) ?? segments[0];
  const [dayKey, setDayKey] = useState(current?.key);
  const day = segments.find((d) => d.key === dayKey) ?? current;
  const hours = day ? Array.from({ length: day.endIndex - Math.max(day.startIndex, tl.liveIndex) + 1 }, (_, k) => Math.max(day.startIndex, tl.liveIndex) + k) : [];
  const peak = useMemo(() => {
    if (!risk || risk.metadata.sparse) return null;
    const share = statewideShare(risk);
    let best = tl.liveIndex;
    let bestV = -1;
    for (let i = tl.liveIndex; i < tl.frames; i++) {
      const h = tl.start + i * HOUR_MS;
      const f = Math.max(0, Math.min(risk.metadata.frames - 1, Math.floor((h - Date.parse(risk.metadata.forecast_start)) / (risk.metadata.step_minutes * 60_000))));
      if (share[f] > bestV) [best, bestV] = [i, share[f]];
    }
    return { index: best, share: bestV };
  }, [risk, tl]);
  return (
    <div className="popover cal-pop" role="dialog" aria-label="Jump to a forecast hour">
      <div className="popover__head">
        <h2>Jump to</h2>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="cal-days">
        {segments.map((d) => (
          <button key={d.key} type="button" className={d.key === day?.key ? 'is-active' : ''} onClick={() => setDayKey(d.key)}>
            <span>{dayName(d.startMs, now)}</span>
            <small>{formatMonthDay(d.startMs)}</small>
          </button>
        ))}
      </div>
      <div className="cal-hours" role="listbox" aria-label="Hour">
        {hours.map((i) => (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={i === idx}
            className={i === idx ? 'is-active' : ''}
            onClick={() => {
              setTimeIndex(i);
              onClose();
            }}
          >
            {formatHour(tl.start + i * HOUR_MS).replace(' ', ' ')}
          </button>
        ))}
      </div>
      <div className="cal-actions">
        {peak && (
          <button
            type="button"
            className="btn btn--soft"
            onClick={() => {
              setTimeIndex(peak.index);
              onClose();
            }}
          >
            <TrendingUp size={15} /> Statewide peak: {formatWeekday(tl.start + peak.index * HOUR_MS)} {formatHour(tl.start + peak.index * HOUR_MS)}
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            goLive();
            onClose();
          }}
        >
          <RotateCcw size={15} /> Now
        </button>
      </div>
    </div>
  );
}

export function Timeline() {
  const tl = useStore(useShallow((s) => timelineOf(s)));
  const idx = useStore((s) => effectiveIndex(s));
  const isLive = useStore((s) => s.isLive);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const now = useStore((s) => s.now);
  const calendarOpen = useStore((s) => s.calendarOpen);
  const scoreType = useStore((s) => s.risk.data?.metadata.score_type);
  const riskLoading = useStore((s) => s.risk.state === 'loading' && !s.risk.data);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const t = tl.start + idx * HOUR_MS;
  const segments = useMemo(() => daySegments(tl.start, HOUR_MS, tl.frames), [tl.start, tl.frames]);
  const trend = useTrend(tl.frames, tl.start);
  const frac = (i: number) => i / Math.max(1, tl.frames - 1);

  // Playback: advance one hour per tick, stop at the end of the forecast.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const s = getState();
      const cur = timelineOf(s);
      const i = effectiveIndex(s, cur);
      if (i >= cur.frames - 1) setState({ playing: false });
      else setTimeIndex(i + 1, { keepPlaying: true });
    }, 420 / speed);
    return () => clearInterval(id);
  }, [playing, speed]);

  useEffect(() => {
    if (!infoOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setInfoOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [infoOpen]);

  useEffect(() => {
    if (!infoOpen && !calendarOpen) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
        setState({ calendarOpen: false });
      }
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [infoOpen, calendarOpen]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      stepTime(e.key === 'PageUp' ? 24 : -24);
    } else if (e.key === 'Home') {
      e.preventDefault();
      goLive();
    } else if (e.key === 'End') {
      e.preventDefault();
      setTimeIndex(tl.frames - 1);
    } else if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      togglePlay();
    }
  };

  const atEnd = idx >= tl.frames - 1;
  const hoursAhead = idx - tl.liveIndex;
  const label = isLive ? 'Now' : dayName(t, now);
  const peakValue = trend?.absolute && Number.isFinite(trend.values[idx]) ? trend.values[idx] : null;

  return (
    <div className="timeline" ref={rootRef} role="group" aria-label="Forecast timeline (hourly)">
      <div className="timeline__head">
        <button type="button" className={`live-btn${isLive ? ' is-live' : ''}`} onClick={goLive} aria-pressed={isLive} title="Show the current hour and live detections">
          <span className="live-dot" /> Live
        </button>
        <div className="timeline__when" aria-live="polite">
          <strong>{label}</strong>
          <span>
            {formatMonthDay(t)}, {formatHour(t)} {tzAbbrev(t)}
          </span>
          <span className="timeline__ahead">{isLive ? (t > now ? 'next forecast hour' : 'current hour') : `+${hoursAhead} h forecast`}</span>
          {peakValue != null && <span className="timeline__score">score {scoreValue(peakValue, scoreType)}</span>}
          {riskLoading && <span className="timeline__ahead">loading forecast…</span>}
        </div>
        <div className="timeline__tools">
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Previous hour" onClick={(e) => stepTime(e.shiftKey ? -24 : -1)} disabled={idx <= tl.liveIndex}>
            <ChevronLeft size={17} />
          </button>
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Next hour" onClick={(e) => stepTime(e.shiftKey ? 24 : 1)} disabled={atEnd}>
            <ChevronRight size={17} />
          </button>
          <button
            type="button"
            className="speed-btn"
            aria-label={`Playback speed ${speed}×`}
            title="Playback speed"
            onClick={() => setState({ speed: speed === 1 ? 2 : speed === 2 ? 4 : 1 })}
          >
            {speed}×
          </button>
          <button
            type="button"
            className={`icon-btn icon-btn--sm${infoOpen ? ' is-on' : ''}`}
            aria-label="About forecast times"
            aria-expanded={infoOpen}
            onClick={() => {
              setInfoOpen(!infoOpen);
              setState({ calendarOpen: false });
            }}
          >
            <Info size={16} />
          </button>
        </div>
      </div>
      <div className="timeline__body">
        <button type="button" className="play-btn" onClick={togglePlay} aria-label={playing ? 'Pause forecast playback' : atEnd ? 'Replay forecast from now' : 'Play forecast hour by hour'}>
          {playing ? <Pause size={18} fill="currentColor" /> : atEnd ? <RotateCcw size={18} /> : <Play size={18} fill="currentColor" />}
        </button>
        <div className={`timeline__track${dragging ? ' is-dragging' : ''}`} style={{ ['--progress' as string]: frac(idx), ['--live' as string]: frac(tl.liveIndex) }}>
          <div className="timeline__rail" title={trend?.label}>
            {trend && <Sparkline values={trend.values} />}
            {tl.liveIndex > 0 && <div className="timeline__past" style={{ width: pos(frac(tl.liveIndex)) }} />}
            {segments.slice(1).map((d) => (
              <span key={d.key} className="timeline__tick" style={{ left: pos(frac(d.startIndex)) }} />
            ))}
          </div>
          <input
            type="range"
            className="timeline__range"
            min={0}
            max={tl.frames - 1}
            step={1}
            value={idx}
            aria-label="Forecast hour"
            aria-valuetext={`${formatValidTime(t)}${isLive ? ' (now)' : `, ${hoursAhead} hours ahead`}`}
            onChange={(e) => setTimeIndex(Number(e.target.value))}
            onKeyDown={onKeyDown}
            onPointerDown={() => setDragging(true)}
            onPointerUp={() => setDragging(false)}
            onBlur={() => setDragging(false)}
          />
          <div className="timeline__bubble" style={{ left: pos(frac(idx)) }} aria-hidden>
            {formatWeekday(t)} {formatHour(t)}
          </div>
          <div className="timeline__days">
            {segments.map((d) => {
              const startI = Math.max(d.startIndex, tl.liveIndex);
              if (d.endIndex < tl.liveIndex) return null;
              const mid = (startI + d.endIndex) / 2;
              const active = idx >= d.startIndex && idx <= d.endIndex;
              const narrow = d.endIndex - startI < 8;
              return (
                <button
                  key={d.key}
                  type="button"
                  className={`timeline__day${active ? ' is-active' : ''}${narrow ? ' is-narrow' : ''}`}
                  style={{ left: pos(frac(mid)) }}
                  onClick={() => {
                    const hour = localParts(t).hour;
                    let target = startI;
                    for (let i = startI; i <= d.endIndex; i++) if (localParts(tl.start + i * HOUR_MS).hour === hour) target = i;
                    setTimeIndex(target);
                  }}
                  aria-label={`Jump to ${formatWeekday(d.startMs)} ${formatMonthDay(d.startMs)}`}
                >
                  <span className="d-full">{narrow ? formatWeekday(d.startMs) : dayName(d.startMs, now)}</span>
                  <span className="d-short">{formatWeekday(d.startMs).slice(0, narrow ? 1 : 3)}</span>
                  {!narrow && <small>{formatMonthDay(d.startMs)}</small>}
                </button>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          className={`icon-btn cal-btn${calendarOpen ? ' is-on' : ''}`}
          aria-label="Jump to a day and hour"
          aria-expanded={calendarOpen}
          onClick={() => {
            setInfoOpen(false);
            setState({ calendarOpen: !calendarOpen, layersOpen: false });
          }}
        >
          <CalendarDays size={19} />
        </button>
      </div>
      {tl.expired && <div className="timeline__warn">This forecast has expired — waiting for a new model run.</div>}
      {infoOpen && <InfoPopover onClose={() => setInfoOpen(false)} />}
      {calendarOpen && <CalendarPopover onClose={() => setState({ calendarOpen: false })} />}
    </div>
  );
}
