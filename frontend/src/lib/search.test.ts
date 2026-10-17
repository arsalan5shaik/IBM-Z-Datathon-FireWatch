import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlaceResult } from '../types';
import { searchPlaces } from './search';

const index = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../public/data/places.json'), 'utf8')) as { results: PlaceResult[] }).results;
const top = (q: string) => searchPlaces(index, q).results[0]?.id;

describe('place search', () => {
  it('ranks the expected city first', () => {
    expect(top('Stockton')).toBe('place-ca-stockton');
    expect(top('los angeles')).toBe('place-ca-los-angeles');
    expect(top('san fran')).toBe('place-ca-san-francisco');
    expect(top('Fresno, CA')).toBe('place-ca-fresno');
  });
  it('prefers counties when "county" is typed', () => {
    expect(top('Los Angeles County')).toBe('county-ca-los-angeles');
    expect(top('butte co')).toBe('county-ca-butte');
  });
  it('disambiguates duplicate names with county context', () => {
    const ids = searchPlaces(index, 'Mountain View').results.map((r) => r.id);
    expect(ids).toContain('place-ca-mountain-view-santa-clara');
    expect(ids).toContain('place-ca-mountain-view-contra-costa');
  });
  it('tolerates typos', () => {
    const out = searchPlaces(index, 'Sacremento');
    expect(out.fuzzy).toBe(true);
    expect(out.results[0].id).toBe('place-ca-sacramento');
  });
  it('handles ZIP codes inside and outside California', () => {
    expect(top('95202')).toBe('zip-95202');
    expect(searchPlaces(index, '89501').notice?.kind).toBe('zip-outside');
    expect(searchPlaces(index, '952').results.length).toBeGreaterThan(1);
  });
  it('flags other states and addresses, parses coordinates', () => {
    const reno = searchPlaces(index, 'Reno, NV');
    expect(reno.notice?.kind).toBe('outside');
    expect(reno.results).toHaveLength(0);
    const addr = searchPlaces(index, '123 Main St, Stockton CA 95202');
    expect(addr.notice?.kind).toBe('address');
    expect(addr.results[0].id).toBe('zip-95202');
    expect(searchPlaces(index, '37.95, -121.29').coordinates).toEqual([-121.29, 37.95]);
    expect(searchPlaces(index, 'Phoenix').notice?.kind).toBe('outside');
  });
});
