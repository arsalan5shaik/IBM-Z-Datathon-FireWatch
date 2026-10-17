import { RISK_LEVELS, RISK_RAMP } from '../config';
import type { RiskLevelKey } from '../types';

export function riskLevel(score: number) {
  let level = RISK_LEVELS[0];
  for (const l of RISK_LEVELS) if (score >= l.min) level = l;
  return level;
}
export const riskLevelKey = (score: number): RiskLevelKey => riskLevel(score).key;
export const riskLabel = (key: RiskLevelKey) => RISK_LEVELS.find((l) => l.key === key)?.label ?? key;
export const isShaded = (score: number) => score >= RISK_LEVELS[1].min;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Colour for a score using the same ramp as the map fill. */
export function riskColor(score: number): string {
  if (score <= RISK_RAMP[0][0]) return score < RISK_LEVELS[1].min ? '#94A3B8' : RISK_RAMP[0][1];
  for (let i = 1; i < RISK_RAMP.length; i++) {
    const [s1, c1] = RISK_RAMP[i];
    const [s0, c0] = RISK_RAMP[i - 1];
    if (score <= s1) {
      const t = (score - s0) / (s1 - s0);
      const a = hexToRgb(c0), b = hexToRgb(c1);
      const m = a.map((v, k) => Math.round(v + (b[k] - v) * t));
      return `rgb(${m[0]}, ${m[1]}, ${m[2]})`;
    }
  }
  return RISK_RAMP[RISK_RAMP.length - 1][1];
}

/** Human wording for the score depending on whether the model is calibrated. */
export function scoreCaption(scoreType: string | undefined): string {
  return scoreType === 'calibrated_probability' ? 'calibrated probability' : 'model score · uncalibrated';
}
export function scoreValue(score: number, scoreType: string | undefined): string {
  return scoreType === 'calibrated_probability' ? `${Math.round(score * 100)}%` : score.toFixed(2);
}
