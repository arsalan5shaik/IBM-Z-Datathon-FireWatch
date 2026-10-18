import { ChevronDown, ChevronUp, History } from 'lucide-react';
import { startReplay } from '../state/replay';
import { API_BASE, MODEL_SCORE_COLORS, FUEL_CLASSES, HOTSPOT_AGE_COLORS, RISK_LEVELS, RISK_RAMP, WIND_RAMP } from '../config';
import { formatHour, formatWeekday } from '../lib/time';
import { setState, useStore, validTimeOf } from '../state/store';
import { kmhToMph } from '../lib/format';
import { HotspotStatus } from './HotspotStatus';

const gradient = (stops: [number, string][], from: number, to: number) =>
  `linear-gradient(90deg, ${stops.map(([v, c]) => `${c} ${(((v - from) / (to - from)) * 100).toFixed(0)}%`).join(', ')})`;

export function Legend() {
  const collapsed = useStore((s) => s.legendCollapsed);
  const layers = useStore((s) => s.layers);
  const t = useStore(validTimeOf);
  const isLive = useStore((s) => s.isLive);
  const units = useStore((s) => s.units);
  const scoreType = useStore((s) => s.risk.data?.metadata.score_type);
  const lookback = useStore((s) => s.lookbackHours);
  const hasDetections = useStore((s) => (s.fires.data?.detections.length ?? 0) > 0);
  const replaying = useStore((s) => !!s.replay);
  const when = isLive ? 'now' : `${formatWeekday(t)} ${formatHour(t)}`;

  if (collapsed)
    return (
      <button type="button" className="legend legend--pill" onClick={() => setState({ legendCollapsed: false })} aria-expanded={false} aria-label="Show legend">
        <span className="legend__bar legend__bar--mini" style={{ background: API_BASE ? '#64748b' : gradient(RISK_RAMP, 0.2, 1) }} />
        Legend <ChevronUp size={14} />
      </button>
    );

  const windMax = units === 'us' ? Math.round(kmhToMph(70)) : 70;
  return (
    <aside className="legend" aria-label="Map legend">
      <button type="button" className="legend__collapse" onClick={() => setState({ legendCollapsed: true })} aria-label="Collapse legend" aria-expanded>
        <ChevronDown size={15} />
      </button>
      {layers.risk && (
        <div className="legend__block">
          <div className="legend__title">
            Fire risk <span>· {when}</span>
          </div>
          {API_BASE ? <><div className="legend__bar" style={{ background: `linear-gradient(90deg, ${MODEL_SCORE_COLORS[0]}, ${MODEL_SCORE_COLORS[1]})` }} /><div className="legend__labels"><span>0</span><span>Risk score / 100</span><span>100</span></div><div className="legend__foot">Modeled occurrence risk, not intensity or severity. Calibration unverified; category thresholds pending ML. Values appear only when supplied by the API.</div></> : <>
            <div className="legend__bar" style={{ background: API_BASE ? '#64748b' : gradient(RISK_RAMP, 0.2, 1) }} />
            <div className="legend__labels">{RISK_LEVELS.slice(1).map((l) => <span key={l.key}>{l.label}</span>)}</div>
            <div className="legend__foot">Sample forecast · illustrative categories, not validated model output{scoreType === 'calibrated_probability' ? '' : ' · relative score'}</div>
          </>}
        </div>
      )}
      {layers.fires && (
        <div className="legend__block">
          <div className="legend__title">
            Satellite hotspots <span>· last {lookback} h</span>
          </div>
          <div className="legend__row">
            {HOTSPOT_AGE_COLORS.map((a) => (
              <span key={a.label} className="legend__item">
                <i className="legend__dot" style={{ background: a.color }} />
                {a.label}
              </span>
            ))}
          </div>
          <div className="legend__foot">Size = fire radiative power (MW), not fire size</div>
          {hasDetections && (
            <button type="button" className="legend__replay" onClick={startReplay} disabled={replaying}>
              <History size={14} aria-hidden /> {replaying ? 'Replaying…' : `Replay the last ${lookback} h`}
            </button>
          )}
          <HotspotStatus />
        </div>
      )}
      {(layers.perimeters || layers.fires) && (
        <div className="legend__block legend__row legend__row--wrap">
          {layers.perimeters && (
            <span className="legend__item">
              <i className="legend__line legend__line--perimeter" /> Official perimeter
            </span>
          )}
          {layers.fires && (
            <span className="legend__item">
              <i className="legend__line legend__line--influence" /> Hotspot influence (illustrative)
            </span>
          )}
        </div>
      )}
      {layers.wind && (
        <div className="legend__block">
          <div className="legend__title">Wind</div>
          <div className="legend__bar legend__bar--thin" style={{ background: gradient(WIND_RAMP, 0, 70) }} />
          <div className="legend__labels">
            <span>Calm</span>
            <span>
              {windMax}+ {units === 'us' ? 'mph' : 'km/h'}
            </span>
          </div>
        </div>
      )}
      {layers.vegetation && (
        <div className="legend__block legend__row legend__row--wrap">
          {Object.values(FUEL_CLASSES).map((f) => (
            <span key={f.label} className="legend__item">
              <i className="legend__swatch" style={{ background: f.color }} />
              {f.label}
            </span>
          ))}
        </div>
      )}
      {!layers.risk && !layers.fires && !layers.wind && !layers.vegetation && !layers.perimeters && (
        <div className="legend__foot">All overlays are off — open Layers to turn them on.</div>
      )}
    </aside>
  );
}
