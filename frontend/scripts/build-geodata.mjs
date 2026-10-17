#!/usr/bin/env node
/**
 * Builds the static California geography used by search and map masking:
 *
 *   public/data/ca-boundary.geojson          state outline (mask, clipping, "is this in CA?")
 *   public/data/ca-counties.geojson          58 county polygons
 *   public/data/boundaries/places/<county>.geojson  cities, towns and census-designated places, by county
 *   public/data/boundaries/zcta/NNN.geojson  ZIP Code Tabulation Areas, sharded by 3-digit prefix
 *   public/data/places.json                  search index (same shape as GET /api/v1/places results)
 *
 * Source: US Census Bureau cartographic boundary files (public domain) and the
 * Vintage 2024 population estimates. Files are downloaded into scripts/.cache/census
 * (or $CENSUS_DIR) on first run.
 *
 *   npm run data:geo
 */
import mapshaper from 'mapshaper';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = process.env.CENSUS_DIR ?? path.join(ROOT, 'scripts/.cache/census');
const OUT = path.join(ROOT, 'public/data');

const TIGER = 'https://www2.census.gov/geo/tiger';
const SOURCES = {
  state: `${TIGER}/GENZ2023/shp/cb_2023_us_state_500k.zip`,
  county: `${TIGER}/GENZ2023/shp/cb_2023_us_county_500k.zip`,
  place: `${TIGER}/GENZ2023/shp/cb_2023_06_place_500k.zip`,
  zcta: `${TIGER}/GENZ2020/shp/cb_2020_us_zcta520_500k.zip`,
  pop: 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024_6.csv',
};

async function ensureDownloaded() {
  await fs.mkdir(CACHE, { recursive: true });
  const files = {};
  for (const [key, url] of Object.entries(SOURCES)) {
    const file = path.join(CACHE, path.basename(url));
    if (!existsSync(file)) {
      console.log(`downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    }
    files[key] = file;
  }
  return files;
}

async function run(commands) {
  const out = await mapshaper.applyCommands(commands);
  const [name] = Object.keys(out);
  return JSON.parse(out[name]);
}

const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const roundBbox = (b) => [round(b[0]), round(b[1]), round(b[2]), round(b[3])];

// --- point-in-polygon helpers (ray casting, GeoJSON rings) -------------------
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(x, y, rings) {
  if (!inRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(x, y, rings[k])) return false;
  return true;
}
function inGeometry(x, y, geom) {
  if (geom.type === 'Polygon') return inPolygon(x, y, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((p) => inPolygon(x, y, p));
  return false;
}
function bboxOf(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}
const kmBetween = ([x1, y1], [x2, y2]) => {
  const k = Math.cos(((y1 + y2) / 2) * (Math.PI / 180));
  return Math.hypot((x1 - x2) * 111.32 * k, (y1 - y2) * 110.57);
};

function parsePopulation(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  const col = (name) => head.indexOf(name);
  const [iSum, iCounty, iPlace, iPop] = [col('SUMLEV'), col('COUNTY'), col('PLACE'), col('POPESTIMATE2024')];
  const places = new Map();
  const counties = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c[iSum] === '162') places.set(c[iPlace], Number(c[iPop]));
    if (c[iSum] === '050') counties.set(c[iCounty], Number(c[iPop]));
  }
  return { places, counties };
}

async function main() {
  const src = await ensureDownloaded();
  await fs.mkdir(path.join(OUT, 'boundaries'), { recursive: true });
  const pop = parsePopulation(await fs.readFile(src.pop, 'utf8'));
  const q = (p) => JSON.stringify(p);

  // 1. State outline — detailed copy for clipping, simplified copy for the app.
  const caFull = path.join(CACHE, 'ca-full.geojson');
  await mapshaper.runCommands(
    `-i ${q(src.state)} -filter 'STATEFP=="06"' -proj wgs84 -filter-fields GEOID -o ${q(caFull)} precision=0.00001`,
  );
  const state = await run(
    `-i ${q(caFull)} -simplify interval=120 keep-shapes -filter-islands min-area=1km2 ` +
      `-each 'id="ca", name="California"' -filter-fields id,name -o format=geojson precision=0.0001`,
  );
  await fs.writeFile(path.join(OUT, 'ca-boundary.geojson'), JSON.stringify(state));

  // 2. Counties
  const counties = await run(
    `-i ${q(src.county)} -filter 'STATEFP=="06"' -proj wgs84 -simplify interval=250 keep-shapes ` +
      `-each 'cx=this.innerX, cy=this.innerY' -filter-fields NAME,COUNTYFP,cx,cy -o format=geojson precision=0.0001`,
  );
  const countyIndex = [];
  const countyFeatures = counties.features.map((f) => {
    const { NAME, COUNTYFP, cx, cy } = f.properties;
    const id = `county-ca-${slug(NAME)}`;
    countyIndex.push({
      id,
      name: `${NAME} County`,
      type: 'county',
      county: NAME,
      state: 'CA',
      center: [round(cx), round(cy)],
      bbox: roundBbox(bboxOf(f.geometry)),
      population: pop.counties.get(COUNTYFP) ?? null,
    });
    return { type: 'Feature', id, properties: { id, name: `${NAME} County`, county: NAME }, geometry: f.geometry };
  });
  await fs.writeFile(
    path.join(OUT, 'ca-counties.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: countyFeatures }),
  );
  // Point-in-polygon, falling back to the nearest county center for points that land
  // just offshore after simplification.
  const countyOf = (pt) => {
    const hit = countyFeatures.find((f) => inGeometry(pt[0], pt[1], f.geometry));
    if (hit) return hit.properties.county;
    let best = Infinity, name = null;
    for (const c of countyIndex) {
      const d = kmBetween(pt, c.center);
      if (d < best) [best, name] = [d, c.county];
    }
    return name;
  };

  // 3. Places (cities, towns, census-designated places)
  const places = await run(
    `-i ${q(src.place)} -proj wgs84 -simplify interval=90 keep-shapes ` +
      `-each 'cx=this.innerX, cy=this.innerY' -filter-fields NAME,LSAD,PLACEFP,cx,cy -o format=geojson precision=0.0001`,
  );
  const typeOf = { 25: 'city', 43: 'town', 57: 'cdp' };
  const nameCount = new Map();
  for (const f of places.features) nameCount.set(f.properties.NAME, (nameCount.get(f.properties.NAME) ?? 0) + 1);
  const placeIndex = [];
  const placeFeatures = [];
  for (const f of places.features) {
    const { NAME, LSAD, PLACEFP, cx, cy } = f.properties;
    const center = [round(cx), round(cy)];
    const county = countyOf(center);
    const base = `place-ca-${slug(NAME)}`;
    const id = nameCount.get(NAME) > 1 ? `${base}-${slug(county ?? PLACEFP)}` : base;
    placeIndex.push({
      id,
      name: NAME,
      type: typeOf[LSAD] ?? 'cdp',
      county,
      state: 'CA',
      center,
      bbox: roundBbox(bboxOf(f.geometry)),
      population: pop.places.get(PLACEFP) ?? null,
    });
    placeFeatures.push({ type: 'Feature', id, properties: { id, shard: slug(county) }, geometry: f.geometry });
  }
  // A natural name can collide with another place's county-qualified slug
  // (Spring Valley Lake vs Spring Valley in Lake County). Resolve both records
  // deterministically before publishing any index or boundary shards.
  const idCounts = new Map();
  for (const p of placeIndex) idCounts.set(p.id, (idCounts.get(p.id) ?? 0) + 1);
  placeIndex.forEach((p, i) => {
    if (idCounts.get(p.id) > 1) {
      p.id = `${p.id}-county-${slug(p.county)}`;
      placeFeatures[i].id = p.id;
      placeFeatures[i].properties.id = p.id;
    }
  });
  // Shard by county: selecting a city only downloads that county's places.
  const placeDir = path.join(OUT, 'boundaries/places');
  await fs.rm(placeDir, { recursive: true, force: true });
  await fs.mkdir(placeDir, { recursive: true });
  for (const [shard, features] of Map.groupBy(placeFeatures, (f) => f.properties.shard)) {
    const clean = features.map((f) => ({ ...f, properties: { id: f.id } }));
    await fs.writeFile(path.join(placeDir, `${shard}.geojson`), JSON.stringify({ type: 'FeatureCollection', features: clean }));
  }

  // 4. ZIP Code Tabulation Areas, California prefixes 900–961, clipped to the state outline.
  const zcta = await run(
    `-i ${q(src.zcta)} -filter 'ZCTA5CE20 >= "90000" && ZCTA5CE20 < "96200"' -proj wgs84 ` +
      `-clip ${q(caFull)} -simplify interval=100 keep-shapes -filter 'this.area > 0' ` +
      `-each 'cx=this.innerX, cy=this.innerY' -filter-fields ZCTA5CE20,cx,cy -o format=geojson precision=0.0001`,
  );
  const incorporated = placeIndex.filter((p) => p.type !== 'cdp');
  const zipIndex = [];
  const zipFeatures = [];
  for (const f of zcta.features) {
    const { ZCTA5CE20: zip, cx, cy } = f.properties;
    const center = [round(cx), round(cy)];
    const id = `zip-${zip}`;
    const containing = placeFeatures.find((p) => inGeometry(center[0], center[1], p.geometry));
    let near = containing ? placeIndex.find((p) => p.id === containing.id)?.name : null;
    if (!near) {
      let best = Infinity;
      for (const p of incorporated) {
        const d = kmBetween(center, p.center);
        if (d < best) [best, near] = [d, p.name];
      }
    }
    zipIndex.push({
      id,
      name: zip,
      type: 'zip',
      county: countyOf(center),
      near,
      state: 'CA',
      center,
      bbox: roundBbox(bboxOf(f.geometry)),
      approximate: true,
    });
    zipFeatures.push({ type: 'Feature', id, properties: { id }, geometry: f.geometry });
  }
  // Shard by 3-digit prefix so selecting one ZIP only downloads its neighbourhood.
  const zipDir = path.join(OUT, 'boundaries/zcta');
  await fs.rm(zipDir, { recursive: true, force: true });
  await fs.mkdir(zipDir, { recursive: true });
  const shards = Map.groupBy(zipFeatures, (f) => f.id.slice(4, 7));
  for (const [prefix, features] of shards)
    await fs.writeFile(path.join(zipDir, `${prefix}.geojson`), JSON.stringify({ type: 'FeatureCollection', features }));

  const index = {
    version: 1,
    generated_at: new Date().toISOString(),
    source: 'US Census Bureau cartographic boundary files (2023 places/counties, 2020 ZCTA); Vintage 2024 population estimates',
    results: [...countyIndex, ...placeIndex, ...zipIndex],
  };
  await fs.writeFile(path.join(OUT, 'places.json'), JSON.stringify(index));

  const size = async (p) => `${((await fs.stat(path.join(OUT, p))).size / 1024).toFixed(0)} KB`;
  console.log(`counties ${countyIndex.length}, places ${placeIndex.length}, zips ${zipIndex.length}`);
  for (const p of ['ca-boundary.geojson', 'ca-counties.geojson', 'places.json'])
    console.log(p, await size(p));
  console.log(`boundaries/zcta/*.geojson ${shards.size} shards, largest ${await size(`boundaries/zcta/${[...shards].sort((a, b) => b[1].length - a[1].length)[0][0]}.geojson`)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
