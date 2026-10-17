/**
 * Offline, data-grounded assistant. Used when no LLM backend is configured (sample mode) or the
 * backend chat fails. It only reports numbers that exist in the loaded datasets, says "not
 * available" otherwise, and never gives evacuation advice.
 */
import { FUEL_CLASSES, OFFICIAL_LINKS } from '../config';
import { loadBoundary } from '../api/static';
import { getExplanation } from '../state/data';
import { cellIndexAt, cellsForPlace, groupsNear, seriesForCells, statewideShare, summarizeCells, weatherAtPoint } from '../state/lookups';
import { timelineOf, type AppState, type ChatContext } from '../state/store';
import type { ChatResponse, Explanation, Grounding, PlaceResult } from '../types';
import { bearingDeg, compass8, compass16, type LngLat } from './geo';
import { formatDistance, formatFrp, formatPct, formatPrecip, formatSpeed, formatTemp, formatWind, plural, sensorLabel } from './format';
import { riskLabel, riskLevelKey, scoreValue } from './risk';
import { normalize, placeTitle } from './search';
import { HOUR_MS, daySegments, formatMonthDay, formatValidTime, formatWeekday, localParts, relativeTime } from './time';

const OUTSIDE = ['reno', 'las vegas', 'carson city', 'phoenix', 'portland', 'seattle', 'medford', 'tijuana', 'yuma', 'nevada', 'oregon', 'arizona', 'mexico', 'new york', 'texas'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

interface Resolved {
  label: string;
  point: LngLat | null;
  place: PlaceResult | null;
  cellIndexes: number[];
}

function findPlaceInText(text: string, index: PlaceResult[]): PlaceResult | null {
  const zip = text.match(/\b(9[0-6]\d{3})\b/)?.[1];
  if (zip) return index.find((p) => p.type === 'zip' && p.name === zip) ?? null;
  const t = ` ${normalize(text)} `;
  let best: PlaceResult | null = null;
  let bestScore = 0;
  for (const p of index) {
    if (p.type === 'zip') continue;
    const n = normalize(p.name);
    const base = p.type === 'county' ? n.replace(/ county$/, '') : n;
    const hitFull = t.includes(` ${n} `);
    const hitBase = base.length >= 4 && t.includes(` ${base} `);
    if (!hitFull && !hitBase) continue;
    // Longer names, incorporated places and bigger populations win ("Los Angeles" over "Angeles").
    const score =
      base.length * 10 + (p.type === 'city' || p.type === 'town' ? 25 : p.type === 'county' ? (t.includes(' county') ? 60 : 15) : 0) + Math.log10((p.population ?? 0) + 1) * 4;
    if (score > bestScore) [best, bestScore] = [p, score];
  }
  return best;
}

async function resolveLocation(s: AppState, text: string, ctx: ChatContext | null): Promise<Resolved | null> {
  const grid = s.risk.data;
  const index = s.places.data ?? [];
  const mentioned = findPlaceInText(text, index);
  const place = mentioned ?? (ctx?.placeId ? index.find((p) => p.id === ctx.placeId) ?? null : null);
  if (place) {
    let boundary = s.highlight?.place.id === place.id ? s.highlight.boundary : null;
    if (!boundary) boundary = await loadBoundary(place).catch(() => null);
    return { label: placeTitle(place), point: place.center, place, cellIndexes: grid ? cellsForPlace(grid, place, boundary) : [] };
  }
  if (!ctx?.lngLat) return null;
  const p = ctx.lngLat;
  const i = grid ? (ctx.cellId ? grid.cells.findIndex((c) => c.properties.cell_id === ctx.cellId) : cellIndexAt(grid, p)) : -1;
  const near = i >= 0 ? grid!.cells[i].properties.near : null;
  const base = ctx.label.split(' · ')[0];
  return { label: near && !ctx.incidentId ? `the area near ${near}` : base, point: p, place: null, cellIndexes: i >= 0 ? [i] : [] };
}

/** Pick the valid time a question refers to ("day 4", "tomorrow", "Saturday 5 pm", "now"). */
function resolveTime(s: AppState, text: string, validAt: number, seriesFor: (hours: number[]) => number[]): { t: number; explicit: boolean } {
  const tl = timelineOf(s);
  const t0 = tl.start + tl.liveIndex * HOUR_MS;
  const days = daySegments(tl.start, HOUR_MS, tl.frames).filter((d) => d.endIndex >= tl.liveIndex);
  const q = text.toLowerCase();
  let day: (typeof days)[number] | undefined;
  const dn = q.match(/\bday\s*([1-8])\b/);
  if (dn) day = days[Math.min(days.length - 1, Number(dn[1]) - 1)];
  else if (/\btomorrow\b/.test(q)) day = days[1];
  else if (/\b(today|tonight|this (afternoon|evening|morning))\b/.test(q)) day = days[0];
  else {
    const wd = WEEKDAYS.findIndex((w) => q.includes(w) || new RegExp(`\\b${w.slice(0, 3)}\\b`).test(q));
    if (wd >= 0) day = days.find((d) => formatWeekday(d.startMs).toLowerCase() === WEEKDAYS[wd].slice(0, 3));
  }
  if (/\b(now|right now|currently|at the moment|current)\b/.test(q) && !day) return { t: t0, explicit: true };
  const hm = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? q.match(/\b(\d{1,2}):(\d{2})\b/);
  let hour: number | null = null;
  if (hm) {
    hour = Number(hm[1]) % 12 + (hm[3] === 'pm' ? 12 : 0);
    if (!hm[3]) hour = Number(hm[1]);
  } else if (/\btonight\b|\bthis evening\b/.test(q)) hour = 21;
  else if (/\bthis afternoon\b/.test(q)) hour = 15;
  else if (/\bthis morning\b/.test(q)) hour = 9;

  const clamp = (ms: number) => Math.max(t0, Math.min(tl.start + (tl.frames - 1) * HOUR_MS, ms));
  if (day) {
    const hours: number[] = [];
    for (let i = Math.max(day.startIndex, tl.liveIndex); i <= day.endIndex; i++) hours.push(tl.start + i * HOUR_MS);
    if (hour != null) {
      const match = hours.find((h) => localParts(h).hour === hour);
      return { t: clamp(match ?? hours[hours.length - 1]), explicit: true };
    }
    const vals = seriesFor(hours);
    const k = vals.reduce((bi, v, i) => (v > vals[bi] ? i : bi), 0);
    return { t: hours[k] ?? clamp(day.startMs), explicit: true };
  }
  if (hour != null) {
    for (let i = tl.liveIndex; i < tl.frames; i++) {
      const h = tl.start + i * HOUR_MS;
      if (localParts(h).hour === hour) return { t: h, explicit: true };
    }
  }
  return { t: validAt, explicit: false };
}

const when = (t: number) => formatValidTime(t);

/** "shrub / chaparral fuels", "developed land", … */
export function fuelPhrase(fuel: string): string {
  if (fuel === 'urban') return 'developed (urban) land';
  if (fuel === 'agriculture') return 'irrigated farmland';
  if (fuel === 'desert') return 'sparse desert fuels';
  return `${(FUEL_CLASSES[fuel]?.label ?? fuel).toLowerCase()} fuels`;
}
const bullet = (lines: string[]) => lines.map((l) => `• ${l}`).join('\n');

function explainDrivers(ex: Explanation, units: AppState['units']): string {
  const up = ex.drivers.filter((d) => d.contribution_raw > 0.05).slice(0, 3);
  const down = ex.drivers.filter((d) => d.contribution_raw < -0.05).slice(0, 2);
  const describe = (d: Explanation['drivers'][number]) => {
    const v = d.value;
    if (d.feature === 'wind_speed_10m' && typeof v === 'number') return `wind ${formatSpeed(v, units)}`;
    if (d.feature === 'wind_gust_10m' && typeof v === 'number') return `gusts ${formatSpeed(v, units)}`;
    if (d.feature === 'temperature_2m' && typeof v === 'number') return `temperature ${formatTemp(v, units)}`;
    if (d.feature === 'relative_humidity_2m' && typeof v === 'number') return `humidity ${Math.round(v)}%`;
    if (d.feature === 'fuel_type' && typeof v === 'string') return fuelPhrase(v);
    if (d.feature === 'dead_fuel_moisture' && typeof v === 'number') return `dead fuel moisture ${v.toFixed(0)}%`;
    if (d.feature === 'days_since_rain' && typeof v === 'number') return `${Math.round(v)} days since rain`;
    if (d.feature === 'vegetation_density' && typeof v === 'number') return `${v > 0.55 ? 'dense' : v < 0.3 ? 'sparse' : 'moderate'} vegetation (${v.toFixed(2)})`;
    if (d.feature === 'precipitation_6h' && typeof v === 'number') return v > 0.05 ? `recent rain (${formatPrecip(v, units)})` : 'no recent rain';
    if (typeof v === 'number') return `${d.label.toLowerCase()} (${Number.isInteger(v) ? v : v.toFixed(1)}${d.unit && d.unit.length < 4 ? ' ' + d.unit : ''})`;
    return d.label.toLowerCase();
  };
  const parts: string[] = [];
  if (up.length) parts.push(`Biggest factors **raising** the score: ${up.map((d) => `${describe(d)} (+${d.contribution_raw.toFixed(2)})`).join(', ')}.`);
  if (down.length) parts.push(`Factors **lowering** it: ${down.map((d) => `${describe(d)} (${d.contribution_raw.toFixed(2)})`).join(', ')}.`);
  if (!parts.length) parts.push('No single factor dominates this prediction.');
  parts.push('_Contributions are model log-odds (SHAP-style), not percentage points._');
  return parts.join('\n');
}

export async function answerOffline(message: string, s: AppState, ctx: ChatContext | null, validAt: number): Promise<ChatResponse> {
  const q = message.toLowerCase();
  const grounding: Grounding[] = [];
  const ground = (dataset: string, asOf: string | null | undefined) => {
    if (!grounding.some((g) => g.dataset === dataset)) grounding.push({ dataset, as_of: asOf ?? null });
  };
  const grid = s.risk.data;
  const md = grid?.metadata;
  const units = s.units;
  const reply = (answer: string): ChatResponse => ({ answer, grounding, disclaimer: 'Experimental model. Not for emergency decisions.' });

  // 1. Safety questions: never advise; point to officials.
  if (/(evacuat|should i (leave|go|stay)|is it safe|am i safe|stay or go|shelter in place|emergency|911|get out|leave (my|the) house)/.test(q)) {
    return reply(
      `I can’t give evacuation or safety instructions — FireWatch is an experimental forecast, not an alert system.\n\n` +
        bullet([
          '**In immediate danger, call 911** and follow instructions from local officials.',
          ...OFFICIAL_LINKS.map((l) => `[${l.label}](${l.href})`),
          'Sign up for your county’s emergency alerts.',
        ]),
    );
  }

  if (/^(hi|hello|hey)\b|what can you|help me|^help\b/.test(q)) {
    return reply(
      `I answer questions using FireWatch’s loaded data — satellite hotspots, the hourly 7-day risk forecast, weather and the model’s explanation factors. Try:\n\n` +
        bullet(['Why is Stockton high risk on Day 4?', 'What live fires are near Sacramento?', 'How is wind affecting this area?', 'When is the peak risk this week?']),
    );
  }

  // 2. Glossary / model questions.
  if (/\b(shap|log.?odds|contribution)s?\b/.test(q) && /what|how|mean/.test(q)) {
    return reply(
      'SHAP-style contributions show how much each input pushed the model’s output up (+) or down (−) from its baseline for one place and hour. They’re in the model’s raw log-odds units, so they add up to the raw score — they are **not** percentage points or proof of cause.',
    );
  }
  if (/\bfrp\b|radiative/.test(q)) {
    return reply('FRP (fire radiative power, in megawatts) is the heat a satellite pixel radiates. It’s a rough intensity proxy for a hotspot — not fire size, acreage, or a measure of future risk.');
  }
  if (/(how|what).*(model|forecast|score).*(work|mean|calculated|accurate|reliable)|calibrat|probabilit/.test(q)) {
    ground('risk', md?.generated_at);
    return reply(
      `The risk layer is ${md?.sample ? 'a **sample demo model**' : `model **${md?.model_version ?? 'unknown'}**`}. Target: ${md?.target ?? 'hotspot-occurrence risk'}. ` +
        `Scores are ${md?.score_type === 'calibrated_probability' ? 'calibrated probabilities' : '**uncalibrated model scores (0–1)**, useful for comparing places and hours, not exact probabilities'}. ` +
        `It does not predict fire spread or where a fire will burn. Inputs include forecast weather, fuels/vegetation, terrain and past hotspot activity.`,
    );
  }
  if (/where.*(data|information) (come|from)|data source|sources/.test(q)) {
    return reply(
      bullet([
        `Hotspots: ${s.fires.data?.metadata.source ?? 'not loaded'}`,
        `Risk: ${md?.source ?? 'not loaded'}`,
        `Weather: ${s.weather.data?.metadata.source ?? 'not loaded'}`,
        `Perimeters: ${s.incidents.data?.metadata.source ?? 'not loaded'}`,
      ]),
    );
  }

  // 3. Out-of-state places.
  const outside = OUTSIDE.find((o) => new RegExp(`\\b${o}\\b`).test(q));
  const loc = await resolveLocation(s, message, ctx);
  if (outside && !loc?.place) return reply(`FireWatch only covers California, so I don’t have data for ${outside.replace(/\b\w/g, (c) => c.toUpperCase())}.`);

  const seriesFor = (hours: number[]) =>
    grid ? (loc?.cellIndexes.length ? seriesForCells(grid, loc.cellIndexes, hours) : hours.map((h) => statewideShare(grid)[Math.max(0, Math.min(grid.metadata.frames - 1, Math.floor((h - Date.parse(grid.metadata.forecast_start)) / (grid.metadata.step_minutes * 60_000))))])) : hours.map(() => 0);
  const { t } = resolveTime(s, message, validAt, seriesFor);

  const wantsWhy = /\bwhy\b|explain|reason|cause|factor|driver|contribut|what makes|behind/.test(q);
  const wantsFires = /\b(fires?|hotspots?|burning|detections?|incidents?|blaze|smoke|active)\b/.test(q) && !/fire (risk|danger|weather)/.test(q.replace(/fires? near/, ''));
  const wantsWind = /\bwind|gust|santa ana|diablo|offshore/.test(q);
  const wantsWeather = /weather|temperat|\bhot\b|humid|rain|precip|\bdry\b|conditions/.test(q);
  const wantsPeak = /\bwhen\b|peak|worst|highest|which day|what time|most dangerous|safest|lowest|best day/.test(q);
  const wantsWhere = /\bwhere\b|which (areas|counties|places|regions)|statewide|across california|hotspots? of risk/.test(q);

  const parts: string[] = [];

  // 4. Statewide questions (or no location at all).
  if (!loc || (wantsWhere && !loc.place && !ctx)) {
    if (wantsFires || (!grid && s.derived.groups.length)) {
      ground('fires', s.fires.data?.metadata.generated_at);
      const groups = s.derived.groups.filter((g) => g.count >= 3).slice(0, 5);
      const incidents = s.incidents.data?.incidents ?? [];
      parts.push(
        groups.length
          ? `There are **${plural(s.derived.detections.length, 'satellite detection')}** in California in the last ${s.lookbackHours} h. Largest clusters:\n` +
              bullet(groups.map((g) => `${incidents.find((i) => i.id === g.incidentId)?.name ?? 'Unnamed cluster'} — ${plural(g.count, 'detection')}, latest ${relativeTime(g.latest, s.now)}`))
          : `No satellite hotspots were detected in the last ${s.lookbackHours} h.`,
      );
    }
    if (grid && (!wantsFires || wantsWhere)) {
      ground('risk', md?.generated_at);
      const f = Math.max(0, Math.min(grid.metadata.frames - 1, Math.floor((t - Date.parse(grid.metadata.forecast_start)) / (grid.metadata.step_minutes * 60_000))));
      const n = grid.cells.length;
      const byCounty = new Map<string, number>();
      grid.cells.forEach((c, i) => {
        const county = c.properties.county;
        if (!county) return;
        byCounty.set(county, Math.max(byCounty.get(county) ?? 0, grid.scores[f * n + i]));
      });
      const top = [...byCounty.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const share = statewideShare(grid)[f];
      parts.push(
        `For **${when(t)}**, ${formatPct(share * 100)} of California’s forecast cells are at High risk or above. Highest-scoring counties:\n` +
          bullet(top.map(([c, v]) => `${c} County — ${riskLabel(riskLevelKey(v))} (${scoreValue(v, md?.score_type)})`)),
      );
      if (wantsPeak) {
        const shares = statewideShare(grid);
        let pk = 0;
        shares.forEach((v, i) => (v > shares[pk] ? (pk = i) : 0));
        parts.push(`Statewide, the forecast peaks around **${when(Date.parse(grid.metadata.forecast_start) + pk * grid.metadata.step_minutes * 60_000)}**.`);
      }
    }
    if (!parts.length) parts.push('Select a place on the map or search for one, then ask me about its risk, nearby fires, wind or weather.');
    return reply(parts.join('\n\n'));
  }

  // 5. Location-specific answers.
  const p = loc.point;
  const summary = grid && loc.cellIndexes.length ? summarizeCells(grid, loc.cellIndexes, t) : null;
  const cellId = summary && summary.maxCell >= 0 ? grid!.cells[summary.maxCell].properties.cell_id : null;
  const ex = cellId ? await getExplanation(cellId, t).catch(() => null) : null;
  const gridWeather = p ? weatherAtPoint(s.weather.data, p, t) : null;
  const c = ex?.conditions;
  // Prefer the explained cell's own inputs so drivers and conditions agree.
  const weather =
    c?.temperature_c != null && c.relative_humidity_pct != null && c.wind_speed_kmh != null
      ? {
          temperature_c: c.temperature_c,
          relative_humidity_pct: c.relative_humidity_pct,
          wind_speed_kmh: c.wind_speed_kmh,
          wind_direction_deg: c.wind_direction_deg ?? gridWeather?.wind_direction_deg ?? 0,
          wind_gust_kmh: c.wind_gust_kmh ?? gridWeather?.wind_gust_kmh ?? c.wind_speed_kmh,
          precipitation_mm: c.precipitation_mm ?? gridWeather?.precipitation_mm ?? 0,
        }
      : gridWeather;
  const generic = !wantsWhy && !wantsFires && !wantsWind && !wantsWeather && !wantsPeak;

  if (summary && (generic || wantsWhy || wantsPeak || /risk|danger|level|score|how (bad|high)/.test(q))) {
    ground('risk', md?.generated_at);
    const level = riskLabel(riskLevelKey(summary.max));
    const area = loc.cellIndexes.length > 1 ? ` (highest of ${loc.cellIndexes.length} forecast cells in the area)` : '';
    const claimed = q.match(/\b(extreme|very high|high)\s+(fire\s+)?risk/)?.[1];
    const order = ['low', 'elevated', 'high', 'very high', 'extreme'];
    const premiseWrong = claimed && order.indexOf(level.toLowerCase()) < order.indexOf(claimed);
    parts.push(
      `${premiseWrong ? `Actually, ${loc.label} isn’t forecast to be ${claimed} risk then. ` : ''}For **${loc.label}** at **${when(t)}**, forecast wildfire risk is **${level}** — score ${scoreValue(summary.max, md?.score_type)}${area}.`,
    );
    if (wantsPeak && grid) {
      const tl = timelineOf(s);
      const hours = Array.from({ length: tl.frames - tl.liveIndex }, (_, i) => tl.start + (tl.liveIndex + i) * HOUR_MS);
      const vals = seriesForCells(grid, loc.cellIndexes, hours);
      const lowest = /safest|lowest/.test(q);
      const k = vals.reduce((bi, v, i) => ((lowest ? v < vals[bi] : v > vals[bi]) ? i : bi), 0);
      const days = daySegments(tl.start, HOUR_MS, tl.frames)
        .filter((d) => d.endIndex >= tl.liveIndex)
        .map((d) => {
          let m = 0;
          for (let i = Math.max(d.startIndex, tl.liveIndex); i <= d.endIndex; i++) m = Math.max(m, vals[i - tl.liveIndex]);
          return `${formatWeekday(d.startMs)} ${formatMonthDay(d.startMs)}: ${riskLabel(riskLevelKey(m))} (${scoreValue(m, md?.score_type)})`;
        });
      parts.push(`The ${lowest ? 'lowest' : 'highest'} forecast hour this week is **${when(hours[k])}** (${scoreValue(vals[k], md?.score_type)}). Daily peaks:\n${bullet(days)}`);
    }
  } else if (!summary && (generic || wantsWhy)) {
    parts.push(`I don’t have a forecast cell for ${loc.label}${grid ? '' : ' — the risk forecast isn’t loaded'}.`);
  }

  if (ex && (wantsWhy || generic)) parts.push(explainDrivers(ex, units));

  if ((wantsWind || wantsWeather || generic) && p) {
    ground('weather', s.weather.data?.metadata.generated_at);
    if (weather) {
      const lines = [
        `Temperature ${formatTemp(weather.temperature_c, units)}, humidity ${Math.round(weather.relative_humidity_pct)}%`,
        `Wind ${formatWind(weather.wind_speed_kmh, weather.wind_direction_deg, units)}, gusts ${formatSpeed(weather.wind_gust_kmh, units)}`,
        `Precipitation ${formatPrecip(weather.precipitation_mm, units)}`,
      ];
      parts.push(`Forecast conditions for ${loc.label} at ${when(t)}:\n${bullet(wantsWind && !wantsWeather ? lines.slice(1, 2) : lines)}`);
      if (wantsWind) {
        const windEffect = ex?.drivers.filter((d) => d.feature.startsWith('wind')).reduce((a, d) => a + d.contribution_raw, 0);
        if (windEffect != null)
          parts.push(
            windEffect > 0.05
              ? `Wind is **raising** the model’s risk score here (combined contribution +${windEffect.toFixed(2)}).`
              : windEffect < -0.05
                ? `Wind is currently **lowering** the risk score slightly (${windEffect.toFixed(2)}).`
                : 'Wind has little effect on the risk score at this hour.',
          );
        parts.push(`Winds from the ${compass8(weather.wind_direction_deg)} blow toward the ${compass8((weather.wind_direction_deg + 180) % 360)}. FireWatch doesn’t model fire spread.`);
      }
    } else parts.push('Weather for this location isn’t available.');
  }

  if ((wantsFires || generic) && p) {
    ground('fires', s.fires.data?.metadata.generated_at);
    const near = groupsNear(s.derived.groups, p, 50).slice(0, 4);
    const incidents = s.incidents.data?.incidents ?? [];
    if (ctx?.detectionId) {
      const d = s.fires.data?.detections.find((x) => x.id === ctx.detectionId);
      if (d)
        parts.push(
          `The selected hotspot was detected by ${sensorLabel(d.sensor)} ${relativeTime(Date.parse(d.acquired_at), s.now)} with ${d.confidence} confidence and FRP ${formatFrp(d.frp_mw)}. A hotspot is a satellite heat signal, not a confirmed fire perimeter.`,
        );
    }
    if (near.length) {
      parts.push(
        `Satellite hotspot clusters within ${formatDistance(50, units)} (last ${s.lookbackHours} h):\n` +
          bullet(
            near.map(({ group: g, km }) => {
              const name = incidents.find((i) => i.id === g.incidentId)?.name ?? 'Unnamed cluster';
              const dir = km > 0.5 ? ` ${compass16(bearingDeg(p, g.center))}` : '';
              return `${name} — ${formatDistance(km, units)}${dir}, ${plural(g.count, 'detection')}, latest ${relativeTime(g.latest, s.now)}`;
            }),
          ),
      );
    } else {
      const nearest = groupsNear(s.derived.groups.filter((g) => g.count >= 3), p, 2000)[0];
      const name = nearest ? (incidents.find((i) => i.id === nearest.group.incidentId)?.name ?? 'an unnamed hotspot cluster') : null;
      parts.push(
        `No satellite hotspots were detected within ${formatDistance(50, units)} in the last ${s.lookbackHours} h.` +
          (nearest ? ` The nearest active cluster is ${name}, ${formatDistance(nearest.km, units)} ${compass16(bearingDeg(p, nearest.group.center))}.` : ''),
      );
    }
    const inc = ctx?.incidentId ? incidents.find((i) => i.id === ctx.incidentId) : null;
    if (inc)
      parts.push(
        `${inc.name}: ${inc.acres != null ? `${Math.round(inc.acres).toLocaleString('en-US')} acres` : 'acreage unavailable'}, containment ${inc.containment_pct != null ? `${inc.containment_pct}%` : 'unavailable'} (per ${inc.source}${inc.updated_at ? `, updated ${relativeTime(Date.parse(inc.updated_at), s.now)}` : ''}).`,
      );
  }

  if (!parts.length) parts.push(`I don’t have data to answer that for ${loc.label}.`);
  if (md?.sample || s.fires.data?.metadata.source.startsWith('SAMPLE')) parts.push('_Note: FireWatch is showing sample data right now._');
  return reply(parts.join('\n\n'));
}
