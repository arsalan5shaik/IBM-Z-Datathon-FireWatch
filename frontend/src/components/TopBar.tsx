import { CloudRain, Info, Loader2, MapPin, Moon, Sun, WifiOff, Wind } from 'lucide-react';
import { STALE_AFTER_MS } from '../config';
import { formatTemp, formatWind } from '../lib/format';
import { formatHour, formatWeekday, localParts, parseTime, relativeTime } from '../lib/time';
import { fitCalifornia } from '../map/mapRef';
import { weatherAtPoint } from '../state/lookups';
import { select, setState, useStore, validTimeOf } from '../state/store';
import { SearchBox } from './SearchBox';

export function FlameLogo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="fw-logo" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#E8262B" />
          <stop offset="0.6" stopColor="#FF7A1A" />
          <stop offset="1" stopColor="#FFB547" />
        </linearGradient>
      </defs>
      <path
        fill="url(#fw-logo)"
        d="M33.5 3c2.2 9.3-2.8 14.6-7.7 19.8C21 27.9 16 33.2 16 41.3 16 52.7 24.3 61 34 61s18-7.8 18-18.5c0-7.4-3.6-12.6-7.6-16.4.4 4.5-.9 8.3-4.3 10.1 1-8.6-1.9-17.5-6.6-23.3 0 0 .4-5.2 0-9.9z"
      />
      <path fill="#FFE66D" d="M34.6 36.5c3.6 3.2 6.4 6.9 6.4 11.4 0 4.7-3.2 8.1-7.2 8.1s-7.3-3.3-7.3-7.6c0-4.6 3.7-7.6 6.2-10.3.8 2.2 2.2 3.5 3.6 3.9-.3-1.9-.9-3.8-1.7-5.5z" />
    </svg>
  );
}

function WeatherChip() {
  const grid = useStore((s) => s.weather.data);
  const weatherState = useStore((s) => s.weather);
  const center = useStore((s) => s.map.center);
  const t = useStore(validTimeOf);
  const units = useStore((s) => s.units);
  const w = weatherAtPoint(grid, center, t);
  if (!w) return null;
  const hour = localParts(t).hour;
  const Icon = w.precipitation_mm > 0.1 ? CloudRain : w.wind_speed_kmh > 35 ? Wind : hour >= 7 && hour < 19 ? Sun : Moon;
  return (
    <span
      className="weather-chip"
      title={`Forecast near the map center · ${formatWeekday(t)} ${formatHour(t)}: ${formatTemp(w.temperature_c, units)}, humidity ${Math.round(w.relative_humidity_pct)}%, wind ${formatWind(w.wind_speed_kmh, w.wind_direction_deg, units)} · ${w.source ?? 'Sample weather'}${w.fetched_at ? ` · fetched ${w.fetched_at}` : ''}${w.cache_status === 'stale' || weatherState.error ? ' · stale' : ''}`}
    >
      <Icon size={17} className={`weather-chip__icon${Icon === Sun ? ' is-sun' : ''}`} aria-hidden />
      {formatTemp(w.temperature_c, units)}
    </span>
  );
}

function StatusPill() {
  const fires = useStore((s) => s.fires);
  const risk = useStore((s) => s.risk);
  const weather = useStore((s) => s.weather);
  const online = useStore((s) => s.online);
  const now = useStore((s) => s.now);
  const origins = [fires.origin, risk.origin, weather.origin];
  const loading = [fires, risk, weather].some((d) => d.state === 'loading' && !d.data);
  const firesAt = parseTime(fires.data?.metadata.generated_at);
  let cls = 'status-pill';
  let content;
  if (!online) {
    cls += ' is-offline';
    content = (
      <>
        <WifiOff size={14} /> Offline
      </>
    );
  } else if (loading) {
    content = (
      <>
        <Loader2 size={14} className="spin" /> Loading
      </>
    );
  } else if (fires.state === 'error' && !fires.data) {
    cls += ' is-error';
    content = <>Satellite data unavailable</>;
  } else if (fires.origin === 'api' && (fires.error || fires.data?.metadata.stale)) {
    cls += ' is-stale';
    content = <>Stale satellite cache</>;
  } else if (origins.includes('api') && [risk, weather].some((ds) => ds.state === 'error' && !ds.data)) {
    cls += ' is-stale';
    content = <>API · some layers unavailable</>;
  } else if (origins.includes('fallback') && origins.includes('api')) {
    cls += ' is-stale';
    content = (
      <>
        <span className="live-dot" /> Live + sample layers
      </>
    );
  } else if (origins.includes('fallback')) {
    cls += ' is-error';
    content = <>API offline · Sample</>;
  } else if (origins.includes('sample')) {
    cls += ' is-sample';
    content = <>Sample data</>;
  } else if (firesAt && now - firesAt > STALE_AFTER_MS) {
    cls += ' is-stale';
    content = <>Stale · {relativeTime(firesAt, now)}</>;
  } else {
    cls += ' is-live';
    content = (
      <>
        <span className="live-dot" /> Live{firesAt ? ` · ${relativeTime(firesAt, now)}` : ''}
      </>
    );
  }
  return (
    <button type="button" className={cls} onClick={() => setState({ aboutOpen: true })} title="Data sources and update times">
      {content}
    </button>
  );
}

export function TopBar() {
  return (
    <header className="topbar">
      <button
        type="button"
        className="brand"
        onClick={() => {
          select(null);
          fitCalifornia();
        }}
        title="California overview"
      >
        <FlameLogo />
        <span className="brand__name">FireWatch</span>
      </button>
      <SearchBox />
      <div className="topbar__right">
        <WeatherChip />
        <span className="scope-pill" title="FireWatch covers California only">
          <MapPin size={14} aria-hidden /> California
        </span>
        <StatusPill />
        <button type="button" className="icon-btn" aria-label="About FireWatch, data sources and help" onClick={() => setState({ aboutOpen: true })}>
          <Info size={18} />
        </button>
      </div>
    </header>
  );
}
