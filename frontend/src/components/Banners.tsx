import { useState, type ReactNode } from 'react';
import { AlertTriangle, Mountain, RefreshCw, WifiOff, X } from 'lucide-react';
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
      text: 'Can’t reach the FireWatch API — showing sample data instead.',
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
      text: `${riskError ? 'The risk forecast' : 'Fire detections'} couldn’t be loaded.`,
      action: (
        <button type="button" onClick={retry} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'spin' : ''} /> Retry
        </button>
      ),
    });
  if (frozen) items.push({ id: 'frozen', icon: <AlertTriangle size={15} />, text: 'Hourly risk isn’t available from the API — every hour shows the 7-day score.' });
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
