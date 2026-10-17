import type { PlaceResult } from '../types';
import { parseCoordinates, type LngLat } from './geo';

export interface SearchNotice {
  kind: 'outside' | 'address' | 'zip-outside' | 'zip-unknown' | 'none' | 'short';
  message: string;
}
export interface SearchOutcome {
  results: PlaceResult[];
  notice: SearchNotice | null;
  coordinates: LngLat | null;
  /** Set when results came from typo-tolerant matching. */
  fuzzy: boolean;
}

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STATE_SUFFIX = /(,?\s+(ca|calif|california|usa|us))+$/;

const OTHER_STATES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii',
  'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
  'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'mexico', 'baja california', 'canada',
];
// "co" is left out on purpose: "Butte co" means county.
const OTHER_STATE_ABBRS = new Set(
  'al ak az ar ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy bc mx'.split(' '),
);
/** "Reno, NV", "Reno nv" (with comma) or "Reno NV" (uppercase) → another state. */
function endsWithOtherState(raw: string): boolean {
  const m = raw.trim().match(/(,\s*|\s)([A-Za-z]{2})\.?$/);
  if (!m || !OTHER_STATE_ABBRS.has(m[2].toLowerCase())) return false;
  return m[1].includes(',') || m[2] === m[2].toUpperCase();
}
const OTHER_CITIES = [
  'reno', 'las vegas', 'henderson', 'carson city', 'sparks', 'phoenix', 'tucson', 'yuma', 'flagstaff', 'portland',
  'medford', 'eugene', 'salem', 'bend', 'seattle', 'boise', 'salt lake city', 'denver', 'tijuana', 'mexicali',
  'ensenada', 'new york', 'chicago', 'houston', 'dallas', 'austin', 'miami', 'boston', 'atlanta', 'honolulu',
  'vancouver', 'albuquerque', 'stateline', 'laughlin', 'lake havasu city', 'brookings', 'klamath falls',
];
const STREET = /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway|pkwy|parkway|cir|circle|ter|terrace)\b/;

const TYPE_BONUS: Record<PlaceResult['type'], number> = { city: 12, town: 12, county: 8, cdp: 2, zip: 0 };

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

interface Indexed {
  place: PlaceResult;
  norm: string;
  base: string; // county name without "County"
  words: string[];
  popBonus: number;
}
let indexed: Indexed[] | null = null;
let indexedFrom: PlaceResult[] | null = null;
function prepare(index: PlaceResult[]): Indexed[] {
  if (indexed && indexedFrom === index) return indexed;
  indexedFrom = index;
  indexed = index.map((place) => {
    const norm = normalize(place.name);
    const base = place.type === 'county' ? norm.replace(/ county$/, '') : norm;
    return { place, norm, base, words: base.split(' '), popBonus: Math.log10((place.population ?? 0) + 1) * 3 };
  });
  return indexed;
}

function rank(items: Indexed[], q: string, countyIntent: boolean): { place: PlaceResult; score: number }[] {
  const out: { place: PlaceResult; score: number }[] = [];
  for (const it of items) {
    if (it.place.type === 'zip') continue;
    let s: number;
    if (it.base === q || it.norm === q) s = 100;
    else if (it.base.startsWith(q)) s = 80 - (it.base.length - q.length) * 0.3;
    else if (it.words.some((w) => w.startsWith(q)) || it.base.includes(' ' + q)) s = 60;
    else if (q.length >= 3 && it.base.includes(q)) s = 40;
    else continue;
    s += TYPE_BONUS[it.place.type] + it.popBonus;
    if (countyIntent) s += it.place.type === 'county' ? 40 : -25;
    out.push({ place: it.place, score: s });
  }
  return out;
}

export function searchPlaces(index: PlaceResult[], raw: string, limit = 8): SearchOutcome {
  const outcome: SearchOutcome = { results: [], notice: null, coordinates: null, fuzzy: false };
  const query = raw.trim();
  if (!query) return outcome;

  const coords = parseCoordinates(query);
  if (coords) {
    outcome.coordinates = coords;
    return outcome;
  }

  let q = normalize(query);
  const items = prepare(index);

  // Numeric → ZIP code search.
  if (/^\d{1,5}$/.test(q)) {
    if (q.length < 3) {
      outcome.notice = { kind: 'short', message: 'Keep typing — enter at least 3 digits of a California ZIP code.' };
      return outcome;
    }
    outcome.results = items.filter((i) => i.place.type === 'zip' && i.norm.startsWith(q)).slice(0, limit).map((i) => i.place);
    if (!outcome.results.length) {
      const prefix = Number(q.slice(0, 3));
      outcome.notice =
        prefix < 900 || prefix > 961
          ? { kind: 'zip-outside', message: `ZIP ${q} is outside California. FireWatch covers California only.` }
          : {
              kind: 'zip-unknown',
              message: `No mapped area for ZIP ${q}. PO Box and single-business ZIPs have no boundary — try the city name instead.`,
            };
    }
    return outcome;
  }

  // Street address → keep its ZIP or city part.
  if (/^\d+\s+\S+/.test(q) && STREET.test(q)) {
    const zip = query.match(/\b(9\d{4})\b/)?.[1];
    const afterComma = query.includes(',') ? normalize(query.split(',')[1] ?? '') : '';
    outcome.notice = { kind: 'address', message: 'Street addresses aren’t supported — showing the closest city or ZIP match.' };
    if (zip) {
      outcome.results = items.filter((i) => i.place.type === 'zip' && i.norm === zip).map((i) => i.place);
    }
    if (!outcome.results.length && afterComma) q = afterComma.replace(STATE_SUFFIX, '');
    else if (!outcome.results.length) {
      outcome.notice.message = 'Street addresses aren’t supported. Search a city, county or ZIP code instead.';
      return outcome;
    } else return outcome;
  }

  const outsideByAbbr = endsWithOtherState(query);
  q = q.replace(STATE_SUFFIX, '').trim();
  if (q.length < 2) {
    outcome.notice = { kind: 'short', message: 'Type at least 2 letters.' };
    return outcome;
  }
  const outsideName = OTHER_STATES.includes(q) || OTHER_CITIES.includes(q) || outsideByAbbr;

  const countyIntent = /\b(county|co)$/.test(q);
  const qCore = countyIntent ? q.replace(/\s*\b(county|co)$/, '').trim() : q;
  let ranked = rank(items, qCore || q, countyIntent);

  if (!ranked.length && qCore.length >= 4) {
    const max = qCore.length >= 8 ? 2 : 1;
    for (const it of items) {
      if (it.place.type === 'zip') continue;
      const d = Math.min(levenshtein(qCore, it.base, max), levenshtein(qCore, it.base.slice(0, qCore.length), max));
      if (d <= max) ranked.push({ place: it.place, score: 50 - d * 10 + TYPE_BONUS[it.place.type] + it.popBonus });
    }
    outcome.fuzzy = ranked.length > 0;
  }

  ranked.sort((a, b) => b.score - a.score);
  outcome.results = ranked.slice(0, limit).map((r) => r.place);
  const exact = ranked.some((r) => normalize(r.place.name).replace(/ county$/, '') === qCore);

  if (outsideName && !exact) {
    outcome.notice = {
      kind: 'outside',
      message: `“${query}” looks like it’s outside California. FireWatch covers California only.`,
    };
    if (outsideByAbbr) outcome.results = [];
  } else if (!outcome.results.length) {
    outcome.notice = { kind: 'none', message: `No California city, town, county or ZIP matches “${query}”.` };
  }
  return outcome;
}

export function placeTypeLabel(p: PlaceResult): string {
  switch (p.type) {
    case 'city':
      return 'City';
    case 'town':
      return 'Town';
    case 'cdp':
      return 'Community';
    case 'county':
      return 'County';
    case 'zip':
      return 'ZIP code area';
  }
}
export function placeSubtitle(p: PlaceResult): string {
  if (p.type === 'county') return 'County · California';
  if (p.type === 'zip') return `ZIP code area (approx.)${p.near ? ` · ${p.near}` : ''}${p.county ? ` · ${p.county} County` : ''}`;
  return `${placeTypeLabel(p)}${p.county ? ` · ${p.county} County` : ''}`;
}
export const placeTitle = (p: PlaceResult) => (p.type === 'zip' ? `ZIP ${p.name}` : p.name);
