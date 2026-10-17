import { describe, expect, it } from 'vitest';
import { HOUR_MS, daySegments, formatHour, formatValidTime, localParts } from './time';
import { frameAt } from '../state/store';

describe('California time helpers', () => {
  it('formats in Pacific time regardless of the machine time zone', () => {
    const t = Date.parse('2026-10-18T22:00:00Z'); // 3 PM PDT
    expect(formatHour(t)).toBe('3 PM');
    expect(formatValidTime(t)).toBe('Sun, Oct 18 · 3 PM PDT');
    expect(localParts(t).hour).toBe(15);
  });
  it('splits the hourly axis into calendar days across the DST change', () => {
    const start = Date.parse('2026-10-31T07:00:00Z'); // midnight PDT, Sat Oct 31
    const days = daySegments(start, HOUR_MS, 72);
    expect(days[0].endIndex - days[0].startIndex + 1).toBe(24);
    expect(days[1].endIndex - days[1].startIndex + 1).toBe(25); // Nov 1 has 25 hours
  });
  it('maps valid times onto coarser model frames', () => {
    const start = '2026-10-17T17:00:00Z';
    expect(frameAt(Date.parse('2026-10-17T17:00:00Z'), start, 60, 168)).toBe(0);
    expect(frameAt(Date.parse('2026-10-18T05:00:00Z'), start, 60, 168)).toBe(12);
    expect(frameAt(Date.parse('2026-10-20T17:00:00Z'), start, 1440, 7)).toBe(3);
    expect(frameAt(Date.parse('2026-11-30T00:00:00Z'), start, 60, 168)).toBe(167);
  });
});
