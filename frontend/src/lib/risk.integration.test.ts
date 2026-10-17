import { describe, expect, it, vi } from 'vitest';
vi.mock('../config', async () => ({ ...await vi.importActual('../config'), API_BASE: 'http://test/api/v1' }));
import { riskLevelKey, scoreCaption, scoreValue } from './risk';
import { apiRiskScore } from '../api/forecastTiles';

describe('real model score display', () => {
  it('displays the documented normalized API scale out of 100 without claiming probability', () => {
    expect(scoreValue(0.423, 'relative_risk')).toBe('42.3 / 100');
    expect(scoreValue(1, 'relative_risk')).toBe('100 / 100');
    expect(scoreValue(0, 'relative_risk')).toBe('0 / 100');
    expect(scoreCaption('relative_risk')).toContain('calibration unverified');
    expect(scoreValue(.423, 'calibrated_probability')).toBe('42.3 / 100');
    expect(scoreCaption('calibrated_probability')).toContain('calibration unverified');
    expect(riskLevelKey(.1)).toBe('unclassified');
    expect(riskLevelKey(.99)).toBe('unclassified');
  });
  it('rejects a raw 0–100 payload under the current normalized contract instead of guessing or magnifying it', () => {
    expect(apiRiskScore(.42)).toBe(.42);
    expect(Number.isNaN(apiRiskScore(null))).toBe(true);
    expect(() => apiRiskScore(42)).toThrow('normalization');
  });
});
