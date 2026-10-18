import { useEffect, useState } from 'react';

type HistoricalCell = {
  cell_id: string;
  score: number;
  date: string;
  lat: number;
  lon: number;
  percentile: number;
  state_median: number;
  p05: number;
  p95: number;
  cell_count: number;
};

/** Historical model output is NOT an active-fire hotspot or a seven-day forecast. */
export function HistoricalERCDetails() {
  const [cell, setCell] = useState<HistoricalCell | null>(null);

  useEffect(() => {
    const open = (event: Event) => {
      const payload = (event as CustomEvent<HistoricalCell>).detail;
      if (!payload || !Number.isFinite(payload.score) || !payload.cell_id) return;
      setCell(payload);
    };
    const close = () => setCell(null);
    window.addEventListener('firewatch:historical-cell', open);
    window.addEventListener('firewatch:open-v6', close);
    return () => {
      window.removeEventListener('firewatch:historical-cell', open);
      window.removeEventListener('firewatch:open-v6', close);
    };
  }, []);

  if (!cell) return null;
  const fraction = Math.max(0, Math.min(1, (cell.score - cell.p05) / Math.max(1, cell.p95 - cell.p05)));
  const higher = cell.score - cell.state_median;
  return (
    <aside role="dialog" aria-label="Historical model cell details" style={{
      position: 'fixed', top: 175, right: 18, zIndex: 1020,
      width: 310, maxWidth: 'calc(100vw - 36px)', maxHeight: 'calc(100vh - 195px)',
      overflowY: 'auto', border: '1px solid rgba(255,255,255,.24)', borderRadius: 14,
      background: 'rgba(17,29,43,.97)', backdropFilter: 'blur(18px)',
      color: '#f1f5f9', boxShadow: '0 12px 38px #0008',
      padding: 16, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 12, color: '#e8bfdc' }}>HISTORICAL V6 · GRID CELL</strong>
        <button onClick={() => setCell(null)} type="button" style={{
          background: '#28384b', color: '#f8fafc', border: 'none',
          padding: '6px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
        }}>CLOSE ×</button>
      </div>
      <h3 style={{ margin: '13px 0 4px', fontSize: 18 }}>California grid cell</h3>
      <div style={{ fontSize: 11, color: '#94a3b8', overflowWrap: 'anywhere' }}>{cell.cell_id}</div>
      <p style={{ color: '#cbd5e1', fontSize: 11 }}>July 9, 2025 · Observed-weather historical model output</p>
      <div style={{ background: 'rgba(226,185,216,.10)', border: '1px solid #d9aacf44', padding: 13, borderRadius: 11 }}>
        <div style={{ color: '#d5b6d1', fontSize: 11 }}>Historical ERC-G relative rank</div>
        <strong style={{ fontSize: 34, color: '#eed3e7' }}>
          {cell.percentile.toFixed(1)}<span style={{ fontSize: 16, fontWeight: 500 }}> / 100</span>
        </strong>
        <div style={{ color: '#cbd5e1', fontSize: 11, marginTop: 4 }}>
          Higher than this share of California cells on July 9, 2025.
        </div>
        <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 6 }}>
          Original modeled ERC-G: {cell.score.toFixed(2)} index units. ERC-G is not a percentage or probability of a fire starting.
        </div>
      </div>
      <h4 style={{ margin: '16px 0 7px' }}>How this cell compares</h4>
      <div style={{ color: '#dbe2ea', fontSize: 12 }}>
        Higher than approximately <strong>{cell.percentile.toFixed(1)}%</strong> of the {cell.cell_count.toLocaleString()} valid modeled cells on this historical date.
      </div>
      <div style={{ position: 'relative', margin: '13px 0 7px' }}>
        <div style={{ height: 11, borderRadius: 8, background: 'linear-gradient(90deg,#fff5e6,#e2b9d8,#bb78b5,#7a1c8c)' }} />
        <div style={{ position: 'absolute', top: -4, left: `calc(${(fraction * 100).toFixed(1)}% - 2px)`, height: 19, width: 4, background: '#ffffff', borderRadius: 3, boxShadow: '0 0 7px #0007' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#94a3b8' }}>
        <span>5th pct: {cell.p05.toFixed(1)}</span><span>95th pct: {cell.p95.toFixed(1)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 17, borderTop: '1px solid #334155', paddingTop: 11 }}>
        <span>Statewide median ERC-G</span><strong>{cell.state_median.toFixed(2)}</strong>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 10 }}>
        <span>Difference from median</span>
        <strong style={{ color: higher >= 0 ? '#f4b5d9' : '#93c5fd' }}>{higher >= 0 ? '+' : ''}{higher.toFixed(2)}</strong>
      </div>
      <div style={{ marginTop: 13, fontSize: 11, color: '#94a3b8' }}>
        Coordinates: {cell.lat.toFixed(4)}°, {cell.lon.toFixed(4)}°
      </div>
      <div style={{ borderTop: '1px solid #334155', marginTop: 16, paddingTop: 12, lineHeight: 1.55, color: '#cbd5e1', fontSize: 11 }}>
        <strong>About the explanation</strong>
        <div>The 2025 map archive contains the model score and location, but not the 15 weather-feature inputs required to calculate a valid cell-specific TreeSHAP breakdown. Those contributions are unavailable for this historical cell.</div>
        <div style={{ marginTop: 10 }}>A higher ERC-G indicates greater modeled fuel-energy conditions relative to other cells here. It does <strong>not</strong> predict whether a fire will start, nor indicate an active hotspot.</div>
      </div>
    </aside>
  );
}
