#!/usr/bin/env node
/**
 * Builds the SAMPLE forecast grid used by the in-browser demo data provider:
 *
 *   public/data/grid/cells.geojson
 *
 * ~7 km hexagonal cells clipped to California, each with static "environment"
 * features the mock model uses to generate plausible-looking demo forecasts:
 *   elev_m, slope_deg      sampled from AWS Terrain Tiles (Terrarium, z8)
 *   hist_count, hist_frp   NASA FIRMS VIIRS S-NPP detections 2024–2025 (CSV files in the repo root)
 *   urban_frac             share of the cell inside an incorporated city/town
 *   coast_km               distance to the Pacific coastline
 *   fuel, veg_density      HEURISTIC fuel class — placeholder until the ML team supplies
 *                          real vegetation/fuel features (e.g. LANDFIRE / NLCD)
 *
 * The real ML pipeline replaces all of this with its own grid + /api/v1/risk output.
 * Run `npm run data:geo` first (needs ca-boundary + place boundaries).
 *
 *   npm run data:grid
 */
import mapshaper from 'mapshaper';
import { PNG } from 'pngjs';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(ROOT, '..');
const DATA = path.join(ROOT, 'public/data');
const CACHE = process.env.DEM_DIR ?? path.join(ROOT, 'scripts/.cache/dem');
const HEX_KM = 7; // circumradius at the reference latitude
const DEM_Z = 8;

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const R_EARTH = 6378137;
const toMerc = (lon, lat) => [
  R_EARTH * (lon * Math.PI) / 180,
  R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
];
const fromMerc = (x, y) => [
  (x / R_EARTH) * (180 / Math.PI),
  (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * (180 / Math.PI),
];
const kmBetween = ([x1, y1], [x2, y2]) => {
  const k = Math.cos(((y1 + y2) / 2) * (Math.PI / 180));
  return Math.hypot((x1 - x2) * 111.32 * k, (y1 - y2) * 110.57);
};

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((r) => inRing(x, y, r));
const inGeometry = (x, y, g) =>
  g.type === 'Polygon' ? inPolygon(x, y, g.coordinates) : g.coordinates.some((p) => inPolygon(x, y, p));

// Small deterministic hash noise in [0,1).
function hash01(a, b) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// --- DEM ---------------------------------------------------------------------
const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat, z) =>
  ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;

async function loadDem(bbox) {
  await fs.mkdir(CACHE, { recursive: true });
  const [w, s, e, n] = bbox;
  const x0 = Math.floor(lon2tile(w, DEM_Z)), x1 = Math.floor(lon2tile(e, DEM_Z));
  const y0 = Math.floor(lat2tile(n, DEM_Z)), y1 = Math.floor(lat2tile(s, DEM_Z));
  const tiles = new Map();
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const file = path.join(CACHE, `${DEM_Z}-${x}-${y}.png`);
      if (!existsSync(file)) {
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_Z}/${x}/${y}.png`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} -> ${res.status}`);
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      }
      tiles.set(`${x}/${y}`, PNG.sync.read(await fs.readFile(file)));
    }
  console.log(`DEM: ${tiles.size} tiles at z${DEM_Z}`);
  const elevation = (lon, lat) => {
    const tx = lon2tile(lon, DEM_Z), ty = lat2tile(lat, DEM_Z);
    const png = tiles.get(`${Math.floor(tx)}/${Math.floor(ty)}`);
    if (!png) return 0;
    const px = Math.min(255, Math.floor((tx % 1) * 256)), py = Math.min(255, Math.floor((ty % 1) * 256));
    const i = (py * 256 + px) * 4;
    return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
  };
  // Slope from central differences over ~1 km.
  const slope = (lon, lat) => {
    const d = 0.009;
    const dx = (elevation(lon + d, lat) - elevation(lon - d, lat)) / (2 * d * 111320 * Math.cos((lat * Math.PI) / 180));
    const dy = (elevation(lon, lat + d) - elevation(lon, lat - d)) / (2 * d * 110570);
    return (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  };
  return { elevation, slope };
}

// --- Historical NASA FIRMS detections ------------------------------------------
async function loadHistory() {
  const files = readdirSync(REPO).filter((f) => /^FireWatch_California_VIIRS.*\.csv$/i.test(f));
  const points = [];
  for (const f of files) {
    const lines = (await fs.readFile(path.join(REPO, f), 'utf8')).trim().split(/\r?\n/);
    const head = lines[0].split(',');
    const [iLat, iLon, iFrp, iConf, iType] = ['latitude', 'longitude', 'frp', 'confidence', 'type'].map((c) => head.indexOf(c));
    for (const line of lines.slice(1)) {
      const c = line.split(',');
      if (c[iConf] === 'l') continue; // low-confidence detections
      if (iType >= 0 && c[iType] !== '0') continue; // presumed vegetation fires only
      points.push([Number(c[iLon]), Number(c[iLat]), Number(c[iFrp]) || 0]);
    }
  }
  console.log(`history: ${points.length} detections from ${files.join(', ')}`);
  return points;
}

async function main() {
  const ca = JSON.parse(await fs.readFile(path.join(DATA, 'ca-boundary.geojson'), 'utf8'));
  const caGeom = ca.features[0].geometry;
  const bbox = [-124.48, 32.52, -114.12, 42.02];

  // 1. Hex grid in Web Mercator so cells look regular on the map.
  const refLat = 37.25;
  const R = (HEX_KM * 1000) / Math.cos((refLat * Math.PI) / 180);
  const W = Math.sqrt(3) * R, H = 1.5 * R;
  const [mx0, my0] = toMerc(bbox[0] - 0.1, bbox[1] - 0.1);
  const [mx1, my1] = toMerc(bbox[2] + 0.1, bbox[3] + 0.1);
  const hexes = [];
  for (let row = 0, y = my0; y <= my1 + H; row++, y += H)
    for (let col = 0, x = mx0 + (row % 2 ? W / 2 : 0); x <= mx1 + W; col++, x += W) {
      const ring = [];
      for (let k = 0; k < 6; k++) {
        const a = ((60 * k - 30) * Math.PI) / 180;
        const [lon, lat] = fromMerc(x + R * Math.cos(a), y + R * Math.sin(a));
        ring.push([round(lon, 5), round(lat, 5)]);
      }
      ring.push(ring[0]);
      const [clon, clat] = fromMerc(x, y);
      hexes.push({ type: 'Feature', properties: { row, col, clon, clat }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }

  // 2. Clip to the state outline; drop slivers.
  const tmp = path.join(CACHE, 'hex-raw.geojson');
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ type: 'FeatureCollection', features: hexes }));
  const caFile = path.join(DATA, 'ca-boundary.geojson');
  const out = await mapshaper.applyCommands(
    `-i ${JSON.stringify(tmp)} -each 'full=this.area' -clip ${JSON.stringify(caFile)} ` +
      `-each 'frac=this.area/full' -filter 'frac > 0.12' -o format=geojson precision=0.0001`,
  );
  const clipped = JSON.parse(Object.values(out)[0]).features;
  console.log(`grid: ${clipped.length} cells (from ${hexes.length} hexes)`);

  // 3. Supporting data
  const dem = await loadDem(bbox);
  const history = await loadHistory();
  const counties = JSON.parse(await fs.readFile(path.join(DATA, 'ca-counties.geojson'), 'utf8')).features;
  const index = JSON.parse(await fs.readFile(path.join(DATA, 'places.json'), 'utf8')).results;
  const places = index.filter((p) => p.type !== 'zip' && p.type !== 'county');
  const cityPolys = [];
  for (const f of readdirSync(path.join(DATA, 'boundaries/places'))) {
    const fc = JSON.parse(await fs.readFile(path.join(DATA, 'boundaries/places', f), 'utf8'));
    for (const feat of fc.features) {
      const meta = index.find((p) => p.id === feat.id);
      if (meta && meta.type !== 'cdp') cityPolys.push({ geom: feat.geometry, bbox: meta.bbox });
    }
  }
  // Coastline vertices: boundary points with ocean immediately to the west.
  const coast = [];
  for (const poly of caGeom.coordinates)
    for (const [x, y] of poly[0]) {
      if (y > 41.98 || (y < 32.56 && x > -117.15) || x > -117) continue;
      if (!inGeometry(x - 0.03, y, caGeom) || !inGeometry(x - 0.02, y - 0.02, caGeom)) coast.push([x, y]);
    }

  // Bucket history by hex row/col via nearest-center lookup on a coarse spatial hash.
  const cellOf = new Map();
  const bucket = (lon, lat) => `${Math.floor(lon * 10)}:${Math.floor(lat * 10)}`;
  const centers = clipped.map((f, i) => ({ i, c: [f.properties.clon, f.properties.clat] }));
  for (const c of centers) {
    const k = bucket(...c.c);
    if (!cellOf.has(k)) cellOf.set(k, []);
    cellOf.get(k).push(c);
  }
  const nearestCell = (lon, lat) => {
    let best = null, bd = Infinity;
    const bx = Math.floor(lon * 10), by = Math.floor(lat * 10);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const c of cellOf.get(`${bx + dx}:${by + dy}`) ?? []) {
          const d = kmBetween([lon, lat], c.c);
          if (d < bd) [bd, best] = [d, c.i];
        }
    return bd < HEX_KM * 1.1 ? best : null;
  };
  const histCount = new Float64Array(clipped.length), histFrp = new Float64Array(clipped.length);
  for (const [lon, lat, frp] of history) {
    const i = nearestCell(lon, lat);
    if (i == null) continue;
    histCount[i]++;
    histFrp[i] += frp;
  }

  // 4. Features per cell
  const features = clipped.map((f, i) => {
    const { clon, clat, row, col } = f.properties;
    const samples = [[clon, clat]];
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      samples.push([clon + (0.035 * Math.cos(a)) / Math.cos((clat * Math.PI) / 180), clat + 0.035 * Math.sin(a)]);
    }
    const inside = samples.filter(([x, y]) => inGeometry(x, y, caGeom));
    const pts = inside.length ? inside : samples;
    const elev = pts.reduce((s, p) => s + Math.max(0, dem.elevation(...p)), 0) / pts.length;
    const slope = pts.reduce((s, p) => s + dem.slope(...p), 0) / pts.length;
    const urbanHits = pts.filter(([x, y]) =>
      cityPolys.some((c) => x >= c.bbox[0] && x <= c.bbox[2] && y >= c.bbox[1] && y <= c.bbox[3] && inGeometry(x, y, c.geom)),
    ).length;
    const urban = urbanHits / pts.length;
    let coastKm = Infinity;
    for (const p of coast) coastKm = Math.min(coastKm, kmBetween([clon, clat], p));
    const county = counties.find((c) => inGeometry(clon, clat, c.geometry))?.properties.county
      ?? counties.find((c) => pts.some(([x, y]) => inGeometry(x, y, c.geometry)))?.properties.county
      ?? null;
    let near = null, nd = Infinity;
    for (const p of places) {
      const d = kmBetween([clon, clat], p.center) - (p.type === 'cdp' ? 0 : 2) - Math.log10((p.population ?? 0) + 1);
      if (d < nd) [nd, near] = [d, p.name];
    }

    // Heuristic fuel class (placeholder for real fuels data).
    const n = hash01(row, col);
    let fuel;
    if (urban >= 0.4) fuel = 'urban';
    else if (
      (clat >= 34.35 && clat < 35.8 && clon > -118.3 && elev < 1500) || // Mojave
      (clat >= 33.9 && clat < 34.35 && clon > -116.6 && elev < 1300) || // Joshua Tree / Morongo
      (clat < 33.9 && clon > -116.45 && elev < 1000) || // Colorado Desert
      (clat >= 35.8 && clat < 37.5 && clon > -118.0 && elev < 1300) // Death Valley / Owens
    ) fuel = 'desert';
    else if (clat < 33.45 && clon > -116.1 && elev < 60) fuel = 'agriculture';
    else if (elev < 130 && coastKm > 35 && clat > 34.9 && clat < 40.7 && clon > -122.6 && clon < -118.8) fuel = 'agriculture';
    else if (clon > -118.5 && clat >= 35.8 && clat < 38.6 && elev < 2300) fuel = 'shrub';
    else if (elev > 1300 || (clat > 39.4 && elev > 450) || (coastKm < 35 && clat > 38.4)) fuel = 'forest';
    else if (clat < 36.4 && elev >= 150) fuel = n < 0.75 ? 'shrub' : 'grass';
    else if (elev >= 450) fuel = n < 0.55 ? 'forest' : 'shrub';
    else if (elev >= 60) fuel = n < 0.6 ? 'grass' : 'shrub';
    else fuel = urban > 0.15 ? 'urban' : 'grass';
    const baseDensity = { forest: 0.78, shrub: 0.64, grass: 0.46, agriculture: 0.34, urban: 0.16, desert: 0.1 }[fuel];
    const vegDensity = Math.min(0.95, Math.max(0.03, baseDensity + (hash01(col, row) - 0.5) * 0.18));

    return {
      type: 'Feature',
      id: `ca-cell-${String(i + 1).padStart(4, '0')}`,
      properties: {
        cell_id: `ca-cell-${String(i + 1).padStart(4, '0')}`,
        lon: round(clon), lat: round(clat),
        county, near,
        elev_m: Math.round(elev),
        slope_deg: round(slope, 1),
        coast_km: Math.round(coastKm),
        urban_frac: round(urban, 2),
        hist_count: histCount[i],
        hist_frp: Math.round(histFrp[i]),
        fuel,
        veg_density: round(vegDensity, 2),
      },
      geometry: f.geometry,
    };
  });

  // Border / island cells whose samples miss every county polygon: borrow the nearest cell's county.
  for (const f of features) {
    if (f.properties.county) continue;
    let bd = Infinity;
    for (const o of features) {
      if (!o.properties.county) continue;
      const d = kmBetween([f.properties.lon, f.properties.lat], [o.properties.lon, o.properties.lat]);
      if (d < bd) [bd, f.properties.county] = [d, o.properties.county];
    }
  }

  await fs.mkdir(path.join(DATA, 'grid'), { recursive: true });
  const fc = {
    type: 'FeatureCollection',
    metadata: {
      generated_at: new Date().toISOString(),
      purpose: 'SAMPLE grid for the offline demo provider — not an ML output',
      cell_size_km: HEX_KM * 2,
      shape: 'hexagon',
      sources: {
        elevation: 'AWS Terrain Tiles (Terrarium) z8',
        history: 'NASA FIRMS VIIRS S-NPP 2024-2025 (repo CSVs), nominal/high confidence, type 0',
        fuel: 'heuristic placeholder',
      },
    },
    features,
  };
  await fs.writeFile(path.join(DATA, 'grid/cells.geojson'), JSON.stringify(fc));
  const tally = features.reduce((m, f) => ((m[f.properties.fuel] = (m[f.properties.fuel] ?? 0) + 1), m), {});
  console.log('fuel classes', tally);
  console.log(`wrote grid/cells.geojson ${((await fs.stat(path.join(DATA, 'grid/cells.geojson'))).size / 1024).toFixed(0)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
