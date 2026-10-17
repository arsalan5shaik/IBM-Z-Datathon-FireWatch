import { useState, type ReactNode } from 'react';
import { AlertTriangle, Clock, Mountain, RefreshCw, WifiOff, X, ZoomIn } from 'lucide-react';
import { refreshAll } from '../state/data';
import { useStore } from '../state/store';

/** Unobtrusive one-line notices for degraded states. Each can be dismissed for the session. */
export function Banners() {
  const online = useStore((s) => s.online);
  const fallback = useStore((s) => [s.fires.origin, s.risk.origin, s.weather.origin].includes('fallback'));
  const riskError = useStore((s) => s.risk.state === 'error' && !s.risk.data);
  const firesError = useStore((s) => s.fires.state === 'error' && !s.fires.data);
  const frozen = useStore((s) => (s.risk.data?.metadata.frames ?? 2) === 1);
  const terrain = useStore((s) => s.map.terrainError && (s.view === '3d' || s.basemap === 'terrain'));
  const styleFallback = useStore((s) => s.map.styleFallback);
  const coverage = useStore((s) => (s.risk.origin === 'api' && s.risk.data && s.layers.risk ? s.riskCoverage : null));
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    await refreshAll();
    setBusy(false);
  };

  const items: { id: string; icon: ReactNode; text: string; action?: ReactNode }[] = [];
  if (!online) items.push({ id: 'offline', icon: <WifiOff size={15} />, text: 'You’re offline — showing the last loaded data.' });
  if (fallback)
    items.push({
      id: 'fallback',
      icon: <AlertTriangle size={15} />,
      text: 'Some FireWatch API data isn’t available yet — those layers show sample data.',
      action: (
        <button type="button" onClick={retry} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'spin' : ''} /> Retry
        </button>
      ),
    });
  if (riskError || firesError)
    items.push({
      id: 'error',
      icon: <AlertTriangle size={15} />,
      text: riskError ? 'Model forecast unavailable — awaiting validated ML data.' : 'Satellite observations unavailable; this does not establish whether hotspots are present.',
      action: (
        <button type="button" onClick={retry} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'spin' : ''} /> Retry
        </button>
      ),
    });
  if (coverage === 'zoom-in') items.push({ id: 'zoom', icon: <ZoomIn size={15} />, text: 'Zoom in to load the 3 km hourly forecast for this area.' });
  if (coverage === 'missing-hour') items.push({ id: 'missing-hour', icon: <Clock size={15} />, text: 'No published forecast for this hour in view.' });
  if (coverage === 'error') items.push({ id: 'tiles', icon: <AlertTriangle size={15} />, text: 'Some forecast tiles failed to load — retrying shortly.' });
  if (frozen) items.push({ id: 'frozen', icon: <AlertTriangle size={15} />, text: 'Only one forecast interval was supplied; missing hours are not additional predictions.' });
  if (terrain) items.push({ id: 'terrain', icon: <Mountain size={15} />, text: 'Terrain elevation tiles are unavailable — 3D shows a tilted flat map.' });
  if (styleFallback) items.push({ id: 'style', icon: <AlertTriangle size={15} />, text: 'Using a simplified basemap (the vector map service is unreachable).' });

  const visible = items.filter((i) => !hidden[i.id]);
  if (!visible.length) return null;
  return (
    <div className="banners">
      {visible.map((b) => (
        <div key={b.id} className={`banner banner--${b.id}`} role="status">
          {b.icon}
          <span>{b.text}</span>
          {b.action}
          <button type="button" className="banner__close" aria-label="Dismiss" onClick={() => setHidden((h) => ({ ...h, [b.id]: true }))}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
