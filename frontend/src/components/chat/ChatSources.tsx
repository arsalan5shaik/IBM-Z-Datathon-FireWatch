import type { ChatSource } from '../../types';
import { formatStamp } from '../../lib/time';

const DOMAINS = ['ca.gov', 'weather.gov', 'noaa.gov', 'nifc.gov', 'nasa.gov', 'usgs.gov',
  'fs.usda.gov', 'airnow.gov', 'epa.gov', 'ready.gov', 'pubmed.ncbi.nlm.nih.gov',
  'saccounty.gov', 'sjgov.org', 'sjready.org', 'buttecounty.net'];

export function safeSourceUrl(source: ChatSource): string | null {
  if (source.kind !== 'research' || !source.url || !Number.isFinite(Date.parse(source.retrieved_at))) return null;
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    return DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : null;
  } catch { return null; }
}

export function ChatSources({ sources }: { sources: ChatSource[] }) {
  if (!sources.length) return null;
  const stamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? formatStamp(Date.parse(value)) : 'unknown';
  return <details className="msg__source-details">
    <summary>Sources ({sources.length})</summary>
    <ul>{sources.map(source => {
      const href = safeSourceUrl(source);
      return <li key={source.id}>
        <span className="chat-source-kind">{source.kind === 'research' ? 'External research' : 'FireWatch data'}</span>{' '}
        {href ? <a href={href} target="_blank" rel="noopener noreferrer">{source.title}</a> : <strong>{source.title}</strong>}
        <div>{source.provider}{source.scope ? ` · ${source.scope}` : ''}</div>
        {source.valid_at && <div>Valid / observed: {stamp(source.valid_at)}</div>}
        {source.freshness && <div>Freshness: {source.freshness}</div>}
        {source.fetched_at && <div>Provider refreshed: {stamp(source.fetched_at)}</div>}
        {source.generated_at && <div>Prediction generated: {stamp(source.generated_at)}</div>}
        {source.sampling_coordinates && <div>Sample: {source.sampling_coordinates[1].toFixed(4)}, {source.sampling_coordinates[0].toFixed(4)} · coarse weather anchor</div>}
        {source.kind === 'research' && <div>Published: {stamp(source.published_at)}</div>}
        <div>Retrieved: {stamp(source.retrieved_at)}</div>
      </li>;
    })}</ul>
  </details>;
}
