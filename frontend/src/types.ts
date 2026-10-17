/**
 * Domain + API contract types. Field names follow 02_API_CONTRACT.md (v1) wherever an
 * endpoint is frozen; additions for the hourly timeline are documented in frontend/API_INTEGRATION.md.
 */
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

export type BasemapStyle = 'default' | 'terrain';
export type ViewMode = '2d' | '3d';
export type LayerKey = 'fires' | 'risk' | 'wind' | 'weather' | 'vegetation' | 'perimeters';
export type Units = 'us' | 'metric';
export type RiskLevelKey = 'low' | 'elevated' | 'high' | 'very_high' | 'extreme';
/** Where a dataset came from: the backend, built-in sample data, or sample data because the backend failed. */
export type DataOrigin = 'api' | 'sample' | 'fallback';
export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface ApiError {
  code: string;
  message: string;
  status?: number;
}

// ---- /status -----------------------------------------------------------------
export interface StatusResponse {
  status: 'ok' | 'degraded' | string;
  runtime_arch?: string;
  model_version?: string;
  snapshots: { fires_at?: string | null; risk_at?: string | null; weather_at?: string | null };
  data_mode: 'fixture' | 'live' | 'cached' | 'unavailable' | string;
  api_contract_version?: number;
  /** Raw per-subsystem report from the backend's ServiceStatus, when available. */
  forecast?: Record<string, unknown> | null;
  providers?: Record<string, { status?: string; stale?: boolean; last_success_at?: string | null; source_observed_at?: string | null }> | null;
}

// ---- /fires ------------------------------------------------------------------
export interface Detection {
  id: string;
  lon: number;
  lat: number;
  acquired_at: string;
  sensor: string;
  frp_mw: number | null;
  confidence: string;
  display_weight: number;
  daynight?: 'D' | 'N' | null;
  incident_id?: string | null;
}
export interface FiresMetadata {
  source: string;
  generated_at: string;
  stale?: boolean;
  observation_type?: string;
  not_fire_perimeter?: boolean;
  lookback_hours?: number;
}
export interface FiresSnapshot {
  metadata: FiresMetadata;
  detections: Detection[];
}

// ---- /incidents (perimeters) ---------------------------------------------------
export interface Incident {
  id: string;
  name: string;
  official: boolean;
  source: string;
  updated_at: string | null;
  acres: number | null;
  containment_pct: number | null;
  status?: string | null;
  url?: string | null;
  geometry: Polygon | MultiPolygon | null;
  center: [number, number];
}
export interface IncidentsSnapshot {
  metadata: { source: string; generated_at: string; official_perimeter: boolean; sample?: boolean };
  incidents: Incident[];
}

// ---- /coverage (illustrative hotspot influence) --------------------------------
export interface CoverageProps {
  group_id: string;
  visual_intensity: number;
  detection_count: number;
  illustrative_only: true;
}
export type CoverageCollection = FeatureCollection<Polygon | MultiPolygon, CoverageProps>;

// ---- /risk (hourly) ----------------------------------------------------------
export interface CellProps {
  cell_id: string;
  county?: string | null;
  near?: string | null;
  lon?: number;
  lat?: number;
  fuel?: string | null;
  elev_m?: number;
  slope_deg?: number;
  [key: string]: unknown;
}
export type CellFeature = Feature<Polygon | MultiPolygon, CellProps>;

export interface RiskMetadata {
  generated_at: string;
  model_version: string;
  target: string;
  score_type: 'uncalibrated_model_score' | 'calibrated_probability' | string;
  calibrated: boolean;
  not_fire_spread_prediction?: boolean;
  /** First valid hour (UTC ISO). */
  forecast_start: string;
  step_minutes: number;
  frames: number;
  source: string;
  sample?: boolean;
  /**
   * Backend mode: cells and hours are loaded on demand for the visible area (the API serves
   * bbox + hour slices), so scores are NaN where nothing has been loaded and statewide
   * summaries are unavailable.
   */
  sparse?: boolean;
  grid_version?: string;
  published_at?: string;
}
export interface RiskGrid {
  metadata: RiskMetadata;
  cells: CellFeature[];
  /** cell index → id; scores are laid out frame-major: scores[frame * cells.length + cell]. */
  scores: Float32Array;
}

// ---- /weather (hourly gridded) -------------------------------------------------
export interface WeatherGrid {
  metadata: { generated_at: string; source: string; forecast_start: string; step_minutes: number; frames: number; sample?: boolean; fetched_at?: string; cache_status?: 'fresh' | 'stale'; complete?: boolean; data_kind?: 'forecast'; location_id?: string; provider_coordinates?: [number, number] };
  points: [number, number][];
  temperature_c: Float32Array;
  relative_humidity_pct: Float32Array;
  wind_speed_kmh: Float32Array;
  wind_direction_deg: Float32Array;
  wind_gust_kmh: Float32Array;
  precipitation_mm: Float32Array;
}
export interface PointWeather {
  sampling_coordinates?: [number, number];
  provider_coordinates?: [number, number];
  complete?: boolean;
  fetched_at?: string;
  cache_status?: 'fresh' | 'stale';
  source?: string;
  temperature_c: number;
  relative_humidity_pct: number;
  wind_speed_kmh: number;
  wind_direction_deg: number;
  wind_gust_kmh: number;
  precipitation_mm: number;
}

// ---- /explain ----------------------------------------------------------------
export interface Driver {
  feature: string;
  label: string;
  value: number | string | null;
  unit?: string;
  contribution_raw: number;
  direction: 'increase' | 'decrease';
}
export interface Explanation {
  cell_id: string;
  valid_at: string;
  model_version: string;
  risk_score: number;
  risk_level: RiskLevelKey;
  score_type: string;
  base_value: number;
  raw_score: number;
  /** e.g. "log_odds" — contributions are in this unit, never percentage points. */
  output_scale?: string;
  drivers: Driver[];
  conditions: Partial<PointWeather> & {
    fuel_moisture_pct?: number;
    days_since_rain?: number;
    fuel_type?: string | null;
    vegetation_density?: number;
    elevation_m?: number;
    slope_deg?: number;
  };
  sample?: boolean;
}

// ---- /places -------------------------------------------------------------------
export type PlaceType = 'city' | 'town' | 'cdp' | 'county' | 'zip';
export interface PlaceResult {
  display_name?: string;
  boundary_available?: boolean;
  dataset_source?: string;
  dataset_version?: string;
  dataset_url?: string;
  id: string;
  name: string;
  type: PlaceType;
  county: string | null;
  near?: string | null;
  state: 'CA';
  center: [number, number];
  bbox: [number, number, number, number];
  population?: number | null;
  approximate?: boolean;
}

// ---- /chat ---------------------------------------------------------------------
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
export interface ChatRequest {
  message: string;
  location_id?: string | null;
  cell_id?: string | null;
  detection_id?: string | null;
  incident_id?: string | null;
  valid_at?: string | null;
  conversation: ChatTurn[];
}
export interface Grounding {
  dataset: string;
  as_of: string | null;
}
export interface ChatResponse {
  answer: string;
  grounding: Grounding[];
  location_id?: string | null;
  disclaimer?: string;
}

// ---- UI ------------------------------------------------------------------------
export interface FireGroup {
  id: string;
  center: [number, number];
  bbox: [number, number, number, number];
  count: number;
  maxFrp: number;
  sumFrp: number;
  latest: number;
  earliest: number;
  incidentId: string | null;
  detectionIds: string[];
}

export type Selection =
  | { kind: 'place'; place: PlaceResult }
  | { kind: 'cell'; cellId: string; lngLat: [number, number] }
  | { kind: 'hotspot'; detectionId: string }
  | { kind: 'incident'; incidentId: string }
  | { kind: 'group'; groupId: string };
