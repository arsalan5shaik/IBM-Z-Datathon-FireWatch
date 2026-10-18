/**
 * Risk colour ramps. "default" is the orange → red → purple design ramp; "cvd" is a
 * colour-vision-deficiency-safe ramp (viridis order: yellow → green → blue → purple, purple highest).
 * Both keep purple as the highest value so the meaning never flips.
 */
import { RISK_RAMP } from '../config';

export type PaletteKey = 'default' | 'cvd';

export const PALETTES: Record<PaletteKey, [number, string][]> = {
  default: RISK_RAMP,
  cvd: [
    [0.2, '#FDE725'],
    [0.4, '#7AD151'],
    [0.6, '#22A884'],
    [0.8, '#2A788E'],
    [1.0, '#440154'],
  ],
};

export const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Colour at value `v` on a ramp of [stop, hex] pairs (clamped at the ends). */
export function rampRgb(stops: [number, string][], v: number): [number, number, number] {
  if (v <= stops[0][0]) return hexToRgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    const [s1, c1] = stops[i];
    const [s0, c0] = stops[i - 1];
    if (v <= s1) {
      const t = (v - s0) / (s1 - s0);
      const a = hexToRgb(c0), b = hexToRgb(c1);
      return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as [number, number, number];
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

export const rgba = ([r, g, b]: [number, number, number], a: number) => `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;

/** Map fill alpha at each risk stop (score-dependent part of the old fill-opacity). */
export const RISK_ALPHA: [number, number][] = [
  [0.2, 0.3],
  [0.4, 0.44],
  [0.6, 0.54],
  [0.8, 0.62],
  [1.0, 0.68],
];
