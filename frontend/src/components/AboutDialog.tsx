import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, X } from 'lucide-react';
import { API_BASE, OFFICIAL_LINKS } from '../config';
import { refreshAll } from '../state/data';
import { SHORTCUTS } from '../state/keyboard';
import { setState, useStore, type Dataset } from '../state/store';
import { formatStamp, parseTime, relativeTime } from '../lib/time';
import { FlameLogo } from './TopBar';

function Row({ name, ds, source, at, label }: { name: string; ds: Dataset<unknown>; source?: string; at?: string | null; label?: string }) {
  const now = useStore((s) => s.now);
  const t = parseTime(at);
  const status = label && ds.state === 'ready'
    ? label
    : ds.state === 'loading' && !ds.data
      ? 'Loading…'
      : ds.state === 'error'
        ? `Error: ${ds.error ?? 'unavailable'}`
        : ds.origin === 'api'
          ? ds.error
            ? `Stale (refresh failed: ${ds.error})`
            : 'Live API'
          : ds.origin === 'fallback'
            ? `Sample (API failed: ${ds.error ?? 'unreachable'})`
            : ds.origin === 'sample'
              ? 'Sample data'
              : '—';
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{source ?? '—'}</td>
      <td>{t ? `${formatStamp(t)} · ${relativeTime(t, now)}` : '—'}</td>
      <td className={`status status--${ds.origin ?? 'none'}`}>{status}</td>
    </tr>
  );
}

export function AboutDialog() {
  const open = useStore((s) => s.aboutOpen);
  const status = useStore((s) => s.status);
  const fires = useStore((s) => s.fires);
  const risk = useStore((s) => s.risk);
  const weather = useStore((s) => s.weather);
  const incidents = useStore((s) => s.incidents);
  const places = useStore((s) => s.places);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open) return null;
  const close = () => setState({ aboutOpen: false });
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="about-title" tabIndex={-1} ref={ref}>
        <header className="modal__head">
          <FlameLogo size={28} />
          <h2 id="about-title">About FireWatch</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div className="modal__body">
          <p>
            FireWatch shows <strong>where satellites see fire activity now</strong> and an <strong>experimental hourly 7-day wildfire risk forecast</strong> for
            California, with the factors behind each prediction.
          </p>
          <ul className="about-list">
            <li>
              <b>Hotspots</b> are NASA FIRMS satellite heat detections (VIIRS). They are not confirmed fire perimeters; size shows fire radiative power.
            </li>
            <li>
              <b>Risk</b> (orange → red → purple) is a machine-learning score for hotspot occurrence in each grid cell for the selected hour. It is not a
              fire-spread prediction or an official warning.
            </li>
            <li>
              <b>Perimeters</b> (solid dark red) come from official incident data when available. Dashed orange shapes are an <em>illustrative</em> hotspot
              influence view, not burned area.
            </li>
          </ul>

          <h3>Data status</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Dataset</th>
                  <th scope="col">Source</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                <Row name="Satellite hotspots" ds={fires} source={fires.data?.metadata.source} at={fires.data?.metadata.generated_at} />
                <Row name="Risk forecast" ds={risk} source={risk.data ? `${risk.data.metadata.source} · ${risk.data.metadata.model_version}` : undefined} at={risk.data?.metadata.generated_at} />
                <Row name="Weather & wind" ds={weather} source={weather.data?.metadata.source} at={weather.data?.metadata.generated_at} />
                <Row name="Incidents & perimeters" ds={incidents} source={incidents.data?.metadata.source} at={incidents.data?.metadata.generated_at} />
                <Row name="Places (search)" ds={places} source="US Census Bureau boundaries (2023) & population (2024)" at={null} label="Built in" />
              </tbody>
            </table>
          </div>
          <p className="note note--muted">
            Backend: {API_BASE ? <code>{API_BASE}</code> : 'not configured — running on built-in sample data'}
            {status.data?.runtime_arch ? ` · runtime ${status.data.runtime_arch}` : ''}
            {status.data?.data_mode ? ` · mode ${status.data.data_mode}` : ''}
          </p>
          <button
            type="button"
            className="btn btn--soft"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await refreshAll();
              setBusy(false);
            }}
          >
            <RefreshCw size={15} className={busy ? 'spin' : ''} /> Refresh data
          </button>

          <h3>Safety</h3>
          <p>
            FireWatch is an experimental datathon project. <strong>Do not use it for evacuation, dispatch or safety decisions.</strong> In an emergency, call
            911 and follow local officials.
          </p>
          <ul className="link-list">
            {OFFICIAL_LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href} target="_blank" rel="noopener noreferrer">
                  {l.label} <ExternalLink size={13} />
                </a>
              </li>
            ))}
          </ul>

          <h3>Keyboard shortcuts</h3>
          <dl className="shortcuts">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>

          <h3>Credits</h3>
          <p className="note note--muted">
            Basemap © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap. Terrain: Mapzen/AWS Terrain Tiles. Boundaries & population: US Census Bureau.
            Historical hotspots: NASA FIRMS. Built with MapLibre GL JS.
          </p>
        </div>
      </div>
    </div>
  );
}
