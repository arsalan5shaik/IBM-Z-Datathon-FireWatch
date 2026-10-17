import type {
  ChatRequest,
  ChatResponse,
  CoverageCollection,
  Explanation,
  FiresSnapshot,
  IncidentsSnapshot,
  RiskGrid,
  StatusResponse,
  WeatherGrid,
} from '../types';

/**
 * Everything the UI needs from a data source. Implemented by RemoteProvider (FireWatch backend,
 * /api/v1) and SampleProvider (offline demo data generated in the browser).
 */
export interface DataProvider {
  readonly kind: 'api' | 'sample';
  getStatus(): Promise<StatusResponse>;
  /** Detections acquired within the last `lookbackHours`. */
  getFires(lookbackHours: number): Promise<FiresSnapshot>;
  /** Official incidents / perimeters. May be empty. */
  getIncidents(): Promise<IncidentsSnapshot>;
  /** Illustrative influence polygons, or null to let the client derive them from detections. */
  getCoverage(lookbackHours: number): Promise<CoverageCollection | null>;
  getRisk(): Promise<RiskGrid>;
  /** Hourly weather grid. Backends that serve one hour at a time return a single-frame grid for `validAtMs`. */
  getWeather(validAtMs?: number): Promise<WeatherGrid>;
  explain(cellId: string, validAtMs: number): Promise<Explanation>;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
