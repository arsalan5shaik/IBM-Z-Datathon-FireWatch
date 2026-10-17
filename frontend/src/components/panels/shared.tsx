import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Flame, Sparkles, X } from 'lucide-react';
import { FUEL_CLASSES } from '../../config';
import { getExplanation } from '../../state/data';
import { groupsNear } from '../../state/lookups';
import { select, setState, useStore } from '../../state/store';
import { bearingDeg, compass16, type LngLat } from '../../lib/geo';
import { formatDistance, formatElevation, formatPct, formatPrecip, formatSpeed, formatTemp, formatWind, plural } from '../../lib/format';
import { relativeTime } from '../../lib/time';
import type { Explanation, PointWeather, Units } from '../../types';
import { fuelPhrase } from '../../lib/assistant';
import { ShapBars } from '../charts';
import { Note, Section, Spinner, Stats } from '../ui';

export function PanelShell({
  icon,
  title,
  subtitle,
  badge,
  children,
  actions,
  footer,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <aside className={`panel${expanded ? ' is-expanded' : ''}`} role="dialog" aria-modal="false" aria-labelledby="panel-title">
      <button type="button" className="panel__handle" aria-label={expanded ? 'Collapse details' : 'Expand details'} onClick={() => setExpanded(!expanded)}>
        <span />
      </button>
      <header className="panel__head">
        <span className="panel__icon">{icon}</span>
        <div className="panel__titles">
          <h2 id="panel-title" ref={titleRef} tabIndex={-1}>
            {title}
          </h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {badge}
        <button type="button" className="icon-btn icon-btn--sm panel__close" aria-label="Close details" onClick={() => select(null)}>
          <X size={17} />
        </button>
      </header>
      <div className="panel__body">{children}</div>
      {actions && <div className="panel__actions">{actions}</div>}
      {footer && <footer className="panel__foot">{footer}</footer>}
    </aside>
  );
}

/** Fetch the explanation for a cell/hour; holds the previous result while the next loads. */
export function useExplanation(cellId: string | null, t: number) {
  const playing = useStore((s) => s.playing);
  const [state, setLocal] = useState<{ key: string; data: Explanation | null; error: string | null }>({ key: '', data: null, error: null });
  const key = `${cellId}|${t}`;
  useEffect(() => {
    if (!cellId) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        getExplanation(cellId, t)
          .then((data) => !cancelled && setLocal({ key, data, error: null }))
          .catch((e: Error & { status?: number }) =>
            !cancelled &&
            setLocal({ key, data: null, error: e.status === 404 ? 'the API doesn’t provide factors for this cell and hour yet' : e.message || 'unavailable' }),
          );
      },
      playing ? 500 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cellId, t, key, playing]);
  return { data: state.data, error: state.key === key ? state.error : null, loading: state.key !== key };
}

export function Conditions({ ex, weather, units }: { ex: Explanation | null; weather: PointWeather | null; units: Units }) {
  const dataset = useStore((s) => s.weather);
  const c = ex?.conditions ?? {};
  const w = { ...c, ...(weather ?? {}) } as Explanation['conditions'];
  const fuel = c.fuel_type ? (FUEL_CLASSES[c.fuel_type]?.label ?? c.fuel_type) : null;
  const rows: [ReactNode, ReactNode][] = [
    ['Temperature', formatTemp(w.temperature_c, units)],
    ['Humidity', formatPct(w.relative_humidity_pct)],
    [
      'Wind',
      <span className="wind-val" key="w">
        {w.wind_direction_deg != null && w.wind_speed_kmh != null && w.wind_speed_kmh >= 1.5 && (
          <span className="wind-arrow" style={{ transform: `rotate(${w.wind_direction_deg + 180}deg)` }} aria-hidden>
            ↑
          </span>
        )}
        {formatWind(w.wind_speed_kmh, w.wind_direction_deg, units)}
      </span>,
    ],
    ['Gusts', formatSpeed(w.wind_gust_kmh, units)],
    ['Precipitation', formatPrecip(w.precipitation_mm, units)],
  ];
  if (c.fuel_moisture_pct != null) rows.push(['Dead fuel moisture', formatPct(c.fuel_moisture_pct)]);
  if (c.days_since_rain != null) rows.push(['Days since rain', Math.round(c.days_since_rain).toString()]);
  if (fuel) rows.push(['Vegetation / fuel', fuel]);
  if (c.elevation_m != null) rows.push(['Elevation', formatElevation(c.elevation_m, units)]);
  if (c.slope_deg != null) rows.push(['Slope', `${c.slope_deg.toFixed(0)}°`]);
  if (!ex && !weather) return <Note>{dataset.state === 'loading' ? 'Loading forecast weather…' : 'Forecast weather is unavailable for this hour.'}{dataset.error ? ` ${dataset.error}` : ''}</Note>;
  return <>
    {!weather && <Note>{dataset.state === 'loading' ? 'Loading forecast weather…' : 'Forecast weather is unavailable for this hour.'} {dataset.error ?? ''} Model explanation inputs below are separate from live weather.</Note>}
    {weather && <Note>{weather.source ?? (dataset.origin === 'api' ? 'Weather API' : 'Sample weather')} · forecast{weather.fetched_at ? ` · fetched ${relativeTime(Date.parse(weather.fetched_at))}` : ''}{weather.cache_status === 'stale' || dataset.error ? ' · stale' : ''}{weather.complete === false ? ' · partial coverage' : ''}{dataset.state === 'loading' ? ' · refreshing' : ''}</Note>}
    <Stats rows={rows} />
  </>;
}

/** One-sentence, plain-English reading of the top contributions. */
export function plainEnglish(ex: Explanation, units: Units): string {
  const describe = (f: string, v: unknown) => {
    const n = typeof v === 'number' ? v : null;
    switch (f) {
      case 'wind_speed_10m':
        return n != null && n > 35 ? `strong winds (${formatSpeed(n, units)})` : `wind (${n != null ? formatSpeed(n, units) : '—'})`;
      case 'wind_gust_10m':
        return `gusts (${n != null ? formatSpeed(n, units) : '—'})`;
      case 'relative_humidity_2m':
        return n != null && n < 20 ? `very low humidity (${Math.round(n)}%)` : n != null && n > 60 ? `high humidity (${Math.round(n)}%)` : `humidity (${n != null ? Math.round(n) : '—'}%)`;
      case 'temperature_2m':
        return n != null && n > 28 ? `heat (${formatTemp(n, units)})` : `temperature (${n != null ? formatTemp(n, units) : '—'})`;
      case 'dead_fuel_moisture':
        return n != null && n < 7 ? 'very dry fuels' : 'fuel moisture';
      case 'fuel_type':
        return fuelPhrase(String(v));
      case 'vegetation_density':
        return n != null && n > 0.55 ? 'dense vegetation' : 'sparse vegetation';
      case 'slope':
        return 'steep terrain';
      case 'hotspot_history':
        return 'past fire activity here';
      case 'active_hotspots_nearby':
        return 'active hotspots nearby';
      case 'precipitation_6h':
        return 'recent rain';
      case 'days_since_rain':
        return 'a long dry spell';
      default:
        return f.replace(/_/g, ' ');
    }
  };
  const up = ex.drivers.filter((d) => d.contribution_raw > 0.08).slice(0, 2);
  const down = ex.drivers.filter((d) => d.contribution_raw < -0.08).slice(0, 2);
  const join = (a: string[]) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0]);
  const parts: string[] = [];
  if (up.length) parts.push(`${join(up.map((d) => describe(d.feature, d.value)))} push${up.length > 1 ? '' : 'es'} the risk up`);
  if (down.length) parts.push(`${join(down.map((d) => describe(d.feature, d.value)))} hold${down.length > 1 ? '' : 's'} it down`);
  if (!parts.length) return 'No single factor stands out for this hour.';
  const s = parts.join(', while ');
  return s[0].toUpperCase() + s.slice(1) + '.';
}

let whyOpenPref = false;
export function WhySection({ ex, loading, error, units }: { ex: Explanation | null; loading: boolean; error: string | null; units: Units }) {
  const [open, setOpen] = useState(whyOpenPref);
  return (
    <section className="section why">
      <button
        type="button"
        className="why__toggle"
        aria-expanded={open}
        onClick={() => {
          whyOpenPref = !open;
          setOpen(!open);
        }}
      >
        <Sparkles size={16} /> Why this risk?
        {loading && <Spinner />}
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <div className={`why__body${loading ? ' is-refreshing' : ''}`}>
          {error && <Note tone="warn">Explanation unavailable: {error}</Note>}
          {ex && (
            <>
              <p className="why__summary">{plainEnglish(ex, units)}</p>
              <ShapBars drivers={ex.drivers} units={units} outputScale={ex.output_scale} />
              <Note>
                Bars are SHAP-style contributions in the model’s declared {ex.output_scale ?? 'unknown'} units (baseline {ex.base_value.toFixed(2)} → {ex.raw_score.toFixed(2)}). They explain
                the model, not physical cause.
              </Note>
            </>
          )}
          {!ex && !error && <Spinner label="Loading explanation" />}
        </div>
      )}
    </section>
  );
}

export function NearbyFires({
  point,
  km,
  title = 'Nearby fire activity',
  exclude,
}: {
  point: LngLat;
  km: number;
  title?: string;
  /** Group or incident id to leave out (the one the panel is about). */
  exclude?: string | null;
}) {
  const groups = useStore((s) => s.derived.groups);
  const incidents = useStore((s) => s.incidents.data?.incidents);
  const lookback = useStore((s) => s.lookbackHours);
  const units = useStore((s) => s.units);
  const now = useStore((s) => s.now);
  const firesOn = useStore((s) => s.layers.fires);
  const near = groupsNear(groups, point, km)
    .filter(({ group }) => !exclude || (group.id !== exclude && group.incidentId !== exclude))
    .slice(0, 5);
  return (
    <Section title={title} aside={<span className="section__aside">within {formatDistance(km, units)} · {lookback} h</span>}>
      {near.length === 0 ? (
        <Note>No satellite hotspots detected within {formatDistance(km, units)} in the last {lookback} hours.</Note>
      ) : (
        <ul className="fire-list">
          {near.map(({ group: g, km: d }) => {
            const inc = incidents?.find((i) => i.id === g.incidentId);
            return (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!firesOn) setState((s) => ({ layers: { ...s.layers, fires: true } }));
                    select(inc ? { kind: 'incident', incidentId: inc.id } : { kind: 'group', groupId: g.id });
                  }}
                >
                  <span className="fire-list__icon">
                    <Flame size={15} />
                  </span>
                  <span className="fire-list__text">
                    <strong>{inc?.name ?? 'Unnamed hotspot cluster'}</strong>
                    <small>
                      {d < 0.5 ? 'Here' : `${formatDistance(d, units)} ${compass16(bearingDeg(point, g.center))}`} · {plural(g.count, 'detection')} · latest {relativeTime(g.latest, now)}
                    </small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
