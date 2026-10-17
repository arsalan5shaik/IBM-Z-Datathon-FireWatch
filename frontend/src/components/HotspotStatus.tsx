import { loadFires, loadIncidents } from '../state/data';
import { useStore } from '../state/store';
import { utcLabel } from '../api/fires';

/** Status for the existing hotspot layer; never equate unavailable data with an empty sky. */
export function HotspotStatus() {
  const dataset = useStore((s) => s.fires);
  const shown = useStore((s) => s.derived.detections.length);
  const md = dataset.data?.metadata;
  const sample = dataset.origin === 'sample' || dataset.origin === 'fallback';
  const loading = (dataset.state === 'loading' || dataset.state === 'idle') && !dataset.data;
  const stale = !!dataset.error || md?.stale || md?.cache_status === 'stale';
  const status = loading ? 'Loading observations…' : !dataset.data ? 'Observation data unavailable' : sample ? 'Sample observations' : stale ? 'Stale cache · last-known-good observations' : md?.cache_status === 'fresh' ? 'Fresh NASA cache' : 'Cache freshness unknown';
  const partial = md?.partial_sources || md?.partial_boundary_coverage || md?.partial_time_coverage || md?.partial_observations;
  return (
    <div className={`hotspot-status${stale || partial ? ' hotspot-status--warning' : ''}`} role="status" aria-live="polite" aria-label="Satellite observation status">
      <strong>{status}</strong>
      {dataset.data ? <span>{shown.toLocaleString()} observations in the selected time window{shown === 0 ? ' — no matching observations in this cache' : ''}.</span>
        : !loading && <span>Unavailable data does not establish whether hotspots are present.</span>}
      <span>Last successful refresh: {utcLabel(md?.last_successful_refresh ?? md?.generated_at)}</span>
      {md?.observation_end && <span>Latest acquisition: {utcLabel(md.observation_end)}</span>}
      {md?.truncated && <strong>Limited results: API returned {md.returned_count?.toLocaleString()} of {md.matched_count?.toLocaleString()} matches in its {md.lookback_hours} h window.</strong>}
      {partial && <span>Partial coverage or rejected observations; inspect data status before interpreting gaps.</span>}
      {Object.entries(md?.refresh_errors ?? {}).filter(([, error]) => error).map(([source, error]) => <span key={source}>{source}: {error}</span>)}
      {dataset.error && <span>{dataset.error}</span>}
      <span>Satellite thermal anomalies · not confirmed wildfire incidents.</span>
      <button type="button" className="link" disabled={loading} onClick={() => void loadFires().then(loadIncidents)}>Refresh cached observations</button>
    </div>
  );
}
