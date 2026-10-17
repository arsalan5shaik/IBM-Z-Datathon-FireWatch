import type { FeatureCollection, Point } from 'geojson'

// The shared hotspot fields keep the same names as 03_INTEGRATION.md.
export interface HotspotProperties {
  id: string
  detected_at: string
  satellite: string
  frp_mw: number | null
  confidence: string | null
  is_fixture: boolean
  // Extra measurements are local historical-adapter fields, not API changes.
  instrument?: string
  bright_ti4_k?: number | null
  bright_ti5_k?: number | null
  scan_km?: number | null
  track_km?: number | null
  daynight?: string | null
  source_type?: string | null
  version?: string | null
  source_row?: number
}

export type HotspotCollection = FeatureCollection<Point, HotspotProperties> & {
  metadata: {
    source: string
    sensor: string
    updated_at: string | null
    is_fixture: boolean
    source_file: string
    source_sha256: string
    source_rows: number
    selected_date: string
    feature_count: number
    selection: string
  }
}

export interface Snapshot {
  date: string
  file: string
  count: number
  source_file: string
  source_sha256: string
}
