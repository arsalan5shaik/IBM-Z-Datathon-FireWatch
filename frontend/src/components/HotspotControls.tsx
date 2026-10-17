import type { Snapshot } from '../types/hotspots'
import { FRP_BANDS, MISSING_FRP_COLOR } from '../types/frp'

interface Props {
  snapshots: Snapshot[]
  selectedDate: string
  onDateChange: (date: string) => void
  visible: boolean
  onVisibilityChange: (visible: boolean) => void
  opacity: number
  onOpacityChange: (opacity: number) => void
  message: string
  error: boolean
  onRetry: () => void
}

export default function HotspotControls(props: Props) {
  return (
    <section className="hotspot-controls" aria-label="Historical observation controls">
      <div className="historical-heading">
        <h3>Historical satellite observations</h3>
        <span className="historical-badge">Archive / not live</span>
      </div>
      <div className="hotspot-inputs">
        <label className="date-control">
          Observation date (UTC)
          <select value={props.selectedDate} onChange={(event) => props.onDateChange(event.target.value)} disabled={!props.snapshots.length}>
            {!props.snapshots.length && <option value="">Loading dates...</option>}
            {props.snapshots.map((snapshot) => (
              <option key={snapshot.date} value={snapshot.date}>{snapshot.date} / {snapshot.count.toLocaleString()} observations</option>
            ))}
          </select>
        </label>
        <label className="visibility-control">
          <input type="checkbox" checked={props.visible} onChange={(event) => props.onVisibilityChange(event.target.checked)} />
          Show hotspots
        </label>
        <label className="opacity-control">
          Layer opacity: {Math.round(props.opacity * 100)}%
          <input type="range" min="0" max="100" step="5" value={Math.round(props.opacity * 100)} onChange={(event) => props.onOpacityChange(Number(event.target.value) / 100)} disabled={!props.visible} />
        </label>
      </div>
      <div className="frp-legend" aria-label="Fire radiative power legend">
        <strong>FRP (MW)</strong>
        {FRP_BANDS.map((band) => <span key={band.minimum}><i style={{ backgroundColor: band.color }} aria-hidden="true" />{band.label}</span>)}
        <span><i style={{ backgroundColor: MISSING_FRP_COLOR }} aria-hidden="true" />Unavailable</span>
      </div>
      <p className="layer-help">Two daily snapshots: every observation on the busiest date in each source file. This is not full-year history or a representative sample.</p>
      <p className="layer-help">FRP measures pixel-integrated radiative power. These display bands are not hazard levels or fire perimeters. Overlapping observations can hide one another; zoom in to inspect points.</p>
      <p className={`data-status ${props.error ? 'data-status-error' : ''}`} role="status">{props.message}</p>
      {props.error && <button className="retry-button" type="button" onClick={props.onRetry}>Retry historical data</button>}
    </section>
  )
}

