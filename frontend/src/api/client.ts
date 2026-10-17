import type { HotspotCollection, Snapshot } from '../types/hotspots'

// Only this adapter knows that Milestone 2 uses local snapshots.
// A future adapter can fetch /api/v1/hotspots with the agreed bbox/from/to/limit.
const DATA_ROOT = `${import.meta.env.BASE_URL}data/historical/`

async function readJson(file: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${DATA_ROOT}${file}`, { signal })
  if (!response.ok) throw new Error(`Historical data request failed (${response.status}).`)
  return response.json()
}

export async function loadSnapshots(signal: AbortSignal): Promise<Snapshot[]> {
  const value = await readJson('manifest.json', signal) as { snapshots?: Snapshot[] }
  if (!Array.isArray(value.snapshots) || value.snapshots.length === 0) {
    throw new Error('No historical snapshots are available.')
  }
  for (const item of value.snapshots) {
    if (!/^viirs-snpp-\d{4}-\d{2}-\d{2}\.geojson$/.test(item.file) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isInteger(item.count) || item.count < 0) {
      throw new Error('Invalid historical snapshot manifest.')
    }
  }
  return value.snapshots
}

export async function loadHotspots(snapshot: Snapshot, signal: AbortSignal): Promise<HotspotCollection> {
  const value = await readJson(snapshot.file, signal) as HotspotCollection
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features) ||
      value.features.length !== snapshot.count || value.metadata?.is_fixture !== false ||
      value.metadata.source_sha256 !== snapshot.source_sha256 ||
      value.metadata.selected_date !== snapshot.date) {
    throw new Error('Historical snapshot metadata does not match its manifest.')
  }
  for (const feature of value.features) {
    const coordinates = feature.geometry?.coordinates
    const properties = feature.properties
    if (feature.type !== 'Feature' || feature.geometry?.type !== 'Point' ||
        !Array.isArray(coordinates) || coordinates.length !== 2 ||
        !coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90 ||
        !properties || properties.is_fixture !== false || typeof properties.id !== 'string' ||
        typeof properties.satellite !== 'string' ||
        !Number.isFinite(Date.parse(properties.detected_at)) ||
        !properties.detected_at.startsWith(snapshot.date) || !properties.detected_at.endsWith('Z') ||
        (properties.frp_mw !== null && (typeof properties.frp_mw !== 'number' || !Number.isFinite(properties.frp_mw) || properties.frp_mw < 0))) {
      throw new Error('A historical observation has invalid coordinates, measurements, or time.')
    }
  }
  return value
}
