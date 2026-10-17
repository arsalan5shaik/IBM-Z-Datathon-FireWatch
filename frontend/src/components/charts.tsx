import { useRef, useState } from 'react';
import { FUEL_CLASSES } from '../config';
import { riskLabel, riskLevelKey, scoreValue } from '../lib/risk';
import { HOUR_MS, daySegments, formatHour, formatWeekday } from '../lib/time';
import { formatSpeed, formatTemp } from '../lib/format';
import type { Driver, Units } from '../types';

/**
 * Single-series risk trend over the timeline hours. Crosshair + tooltip on hover/focus,
 * click (or Enter) to move the map to that hour.
 */
export function RiskSparkline({
  values,
  start,
  firstIndex,
  currentIndex,
  scoreType,
  onPick,
  title,
}: {
  values: number[];
  start: number;
  firstIndex: number;
  currentIndex: number;
  scoreType?: string;
  onPick: (index: number) => void;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const n = values.length;
  if (n < 2) return null;
  const W = 1000, H = 100, PAD = 6;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => PAD + (1 - Math.max(0, Math.min(1, v))) * (H - PAD * 2);
  const visible = values.map((v, i) => [i, v] as const).filter(([i]) => i >= firstIndex);
  const line = visible.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' L');
  const area = `M${x(visible[0][0]).toFixed(1)},${H} L${line} L${x(n - 1)},${H} Z`;
  const days = daySegments(start, HOUR_MS, n).slice(1);
  const pct = (i: number) => `${(i / (n - 1)) * 100}%`;

  const indexAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.max(firstIndex, Math.min(n - 1, Math.round(((clientX - r.left) / r.width) * (n - 1))));
  };
  const shown = hover ?? currentIndex;
  const v = values[shown];
  const t = start + shown * HOUR_MS;

  return (
    <figure className="spark">
      <figcaption className="spark__title">{title}</figcaption>
      <div
        ref={box}
        className="spark__plot"
        tabIndex={0}
        role="slider"
        aria-label={`${title}. Use arrow keys to move through hours, Enter to show that hour on the map.`}
        aria-valuemin={firstIndex}
        aria-valuemax={n - 1}
        aria-valuenow={shown}
        aria-valuetext={`${formatWeekday(t)} ${formatHour(t)}: ${riskLabel(riskLevelKey(v))}, score ${scoreValue(v, scoreType)}`}
        onPointerMove={(e) => setHover(indexAt(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => onPick(indexAt(e.clientX))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            setHover(Math.max(firstIndex, Math.min(n - 1, shown + (e.key === 'ArrowRight' ? (e.shiftKey ? 24 : 1) : e.shiftKey ? -24 : -1))));
          } else if (e.key === 'Enter') onPick(shown);
        }}
        onBlur={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id="spark-stroke" x1="0" y1="1" x2="0" y2="0" gradientUnits="objectBoundingBox">
              <stop offset="0" stopColor="#FFB547" />
              <stop offset="0.5" stopColor="#E8262B" />
              <stop offset="1" stopColor="#5B1A8C" />
            </linearGradient>
          </defs>
          {[0.4, 0.8].map((g) => (
            <line key={g} x1="0" x2={W} y1={y(g)} y2={y(g)} className="spark__grid" vectorEffect="non-scaling-stroke" />
          ))}
          {days.map((d) => (
            <line key={d.key} x1={x(d.startIndex)} x2={x(d.startIndex)} y1="0" y2={H} className="spark__day" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} className="spark__area" />
          <path d={`M${line}`} className="spark__line" stroke="url(#spark-stroke)" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="spark__gridlabel" style={{ top: `${y(0.8)}%` }}>
          Extreme
        </span>
        <span className="spark__gridlabel" style={{ top: `${y(0.4)}%` }}>
          High
        </span>
        <span className="spark__cursor" style={{ left: pct(shown) }} />
        <span className="spark__dot" style={{ left: pct(shown), top: `${y(v)}%` }} />
        {hover != null && (
          <span className={`spark__tip${shown / (n - 1) > 0.6 ? ' is-left' : ''}`} style={{ left: pct(shown) }}>
            <strong>{scoreValue(v, scoreType)}</strong> {riskLabel(riskLevelKey(v))}
            <small>
              {formatWeekday(t)} {formatHour(t)}
            </small>
          </span>
        )}
      </div>
      <div className="spark__days" aria-hidden>
        {daySegments(start, HOUR_MS, n)
          .filter((d) => d.endIndex - d.startIndex >= 6)
          .map((d) => (
            <span key={d.key} style={{ left: pct((d.startIndex + d.endIndex) / 2) }}>
              {formatWeekday(d.startMs)}
            </span>
          ))}
      </div>
    </figure>
  );
}

function driverValue(d: Driver, units: Units): string {
  const v = d.value;
  if (v == null) return 'Unavailable';
  if (typeof v === 'string') return FUEL_CLASSES[v]?.label ?? v;
  if (d.unit === 'km/h') return formatSpeed(v, units);
  if (d.unit === '°C') return formatTemp(v, units);
  if (d.unit === '%') return `${Math.round(v)}%`;
  if (d.unit === 'mm') return v < 0.05 ? 'None' : `${v.toFixed(1)} mm`;
  if (d.unit === 'index') return v.toFixed(2);
  if (d.unit === '°') return `${v.toFixed(0)}°`;
  return `${Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1)}${d.unit ? ` ${d.unit}` : ''}`;
}

/** Diverging SHAP-style contribution bars: red raises risk, blue lowers it, zero baseline in the middle. */
export function ShapBars({ drivers, units, max = 8 }: { drivers: Driver[]; units: Units; max?: number }) {
  const rows = [...drivers].sort((a, b) => Math.abs(b.contribution_raw) - Math.abs(a.contribution_raw)).slice(0, max);
  const scale = Math.max(0.1, ...rows.map((d) => Math.abs(d.contribution_raw)));
  return (
    <div className="shap" role="table" aria-label="Factors behind this prediction">
      <div className="shap__axis" role="row" aria-hidden>
        <span>← lowers risk</span>
        <span>raises risk →</span>
      </div>
      {rows.map((d) => {
        const w = (Math.abs(d.contribution_raw) / scale) * 50;
        const up = d.contribution_raw >= 0;
        const value = driverValue(d, units);
        return (
          <div
            key={d.feature}
            className="shap__row"
            role="row"
            tabIndex={0}
            title={`${d.label}: ${value} → ${up ? '+' : ''}${d.contribution_raw.toFixed(2)} (log-odds)`}
          >
            <span className="shap__label" role="cell">
              {d.label}
              <small>{value}</small>
            </span>
            <span className="shap__track" role="cell" aria-label={`${up ? 'raises' : 'lowers'} by ${Math.abs(d.contribution_raw).toFixed(2)}`}>
              <span className="shap__zero" />
              <span className={`shap__bar ${up ? 'is-up' : 'is-down'}`} style={up ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
              <span className={`shap__val ${up ? 'is-up' : 'is-down'}`} style={up ? { left: `calc(50% + ${w}% + 4px)` } : { right: `calc(50% + ${w}% + 4px)` }}>
                {up ? '+' : '−'}
                {Math.abs(d.contribution_raw).toFixed(2)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
