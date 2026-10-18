/**
 * Animated wind flow: short-lived streaks advected through the forecast wind field, drawn on a
 * transparent canvas stacked just above the map canvas (below markers and UI). Particles live in
 * geographic coordinates, so they stay pinned to the ground while the map pans, tilts or rotates,
 * and they always travel downwind. Hour changes blend the old and new fields instead of jumping.
 *
 * The streak speed is a display scale (faster wind → faster, brighter streaks), not a physical
 * velocity. The layer pauses entirely when hidden, when the tab is in the background, or when the
 * user prefers reduced motion — the static arrows remain the accessible reading of the wind.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { sampleField, type WindField } from '../lib/windField';
import { degPerPixel } from '../lib/windGrid';

const RAD = Math.PI / 180;
/** Screen pixels per frame: a small floor keeps light air visibly drifting (display scale only). */
const pxPerFrame = (kmh: number) => Math.min(3.2, 0.18 + kmh * 0.05);
const MAX_AGE = 110;
const BINS = 6;
const BIN_MAX_KMH = 60;

/**
 * Streak colours by speed bin, tuned for contrast on the light basemap (deep blues, more opaque
 * for stronger wind) and lightened for dark backgrounds.
 */
const STREAK_RAMP: [number, number, number][] = [
  [59, 130, 246],
  [37, 99, 235],
  [29, 78, 216],
  [30, 64, 175],
  [49, 46, 129],
  [30, 27, 75],
];
function binColors(dark: boolean): string[] {
  return STREAK_RAMP.map((rgb, b) => {
    const alpha = 0.5 + (0.42 * b) / (BINS - 1);
    const [r, g, bl] = dark ? rgb.map((v) => Math.round(v + (255 - v) * 0.6)) : rgb;
    return `rgba(${r}, ${g}, ${bl}, ${alpha.toFixed(2)})`;
  });
}

export class WindFlow {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private field: WindField | null = null;
  private prevField: WindField | null = null;
  private blendStart = 0;
  private blendMs = 700;
  private lon = new Float32Array(0);
  private lat = new Float32Array(0);
  private age = new Uint16Array(0);
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private raf = 0;
  private visible = false;
  private reproject = true;
  private colors = binColors(false);
  private dpr = 1;
  private readonly offs: (() => void)[] = [];
  private readonly tmpA: [number, number] = [0, 0];
  private readonly tmpB: [number, number] = [0, 0];

  constructor(private readonly map: MapLibreMap, private readonly enabled: () => boolean) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fw-wind-flow';
    this.canvas.setAttribute('aria-hidden', 'true');
    const gl = map.getCanvas();
    gl.parentElement!.insertBefore(this.canvas, gl.nextSibling);
    this.ctx = this.canvas.getContext('2d')!;
    const onMove = () => {
      // Trails drawn in old screen positions would smear: wipe them, keep the particles.
      this.reproject = true;
      this.clear();
    };
    const onZoomEnd = () => this.seed();
    const onResize = () => {
      this.resize();
      this.seed();
    };
    const onVisibility = () => this.loop();
    map.on('move', onMove);
    map.on('zoomend', onZoomEnd);
    map.on('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    this.offs.push(
      () => map.off('move', onMove),
      () => map.off('zoomend', onZoomEnd),
      () => map.off('resize', onResize),
      () => document.removeEventListener('visibilitychange', onVisibility),
    );
    this.resize();
  }

  private resize() {
    const c = this.map.getCanvas();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.reproject = true;
  }

  setTheme(dark: boolean) {
    this.colors = binColors(dark);
  }

  /** New field for the selected hour; blends from the previous one over `ms`. */
  setField(field: WindField | null, ms = 700) {
    if (field && this.field && ms > 0) {
      this.prevField = this.field;
      this.blendStart = performance.now();
      this.blendMs = ms;
    } else this.prevField = null;
    const first = !this.field;
    this.field = field;
    if (first && field) this.seed();
    this.loop();
  }

  setVisible(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    this.canvas.classList.toggle('is-on', on);
    if (on) this.seed();
    this.loop();
  }

  private clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private running() {
    return this.visible && !!this.field && this.enabled() && document.visibilityState === 'visible';
  }

  private loop() {
    if (!this.running()) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (!this.visible || !this.enabled()) this.clear();
      return;
    }
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      if (!this.running()) return this.loop();
      this.step();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Particle count scales with screen area (fewer on phones). */
  private count() {
    const c = this.map.getCanvas();
    const area = c.clientWidth * c.clientHeight;
    const density = window.innerWidth < 700 ? 2600 : 1700;
    return Math.max(300, Math.min(2800, Math.round(area / density)));
  }

  private respawn(i: number, bounds: [number, number, number, number]) {
    const [w, s, e, n] = bounds;
    for (let tries = 0; tries < 4; tries++) {
      const lon = w + Math.random() * (e - w);
      const lat = s + Math.random() * (n - s);
      if (this.field && sampleField(this.field, lon, lat, this.tmpA)) {
        this.lon[i] = lon;
        this.lat[i] = lat;
        this.age[i] = Math.floor(Math.random() * MAX_AGE);
        const p = this.map.project([lon, lat]);
        this.px[i] = p.x;
        this.py[i] = p.y;
        return;
      }
    }
    this.lon[i] = NaN;
    this.age[i] = MAX_AGE;
  }

  private viewBounds(): [number, number, number, number] {
    const b = this.map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }

  seed() {
    const n = this.count();
    this.lon = new Float32Array(n);
    this.lat = new Float32Array(n);
    this.age = new Uint16Array(n);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.clear();
    if (!this.field) return;
    const bounds = this.viewBounds();
    for (let i = 0; i < n; i++) this.respawn(i, bounds);
    this.reproject = false;
  }

  private sample(lon: number, lat: number): boolean {
    const f = this.field!;
    if (!sampleField(f, lon, lat, this.tmpA)) return false;
    const prev = this.prevField;
    if (!prev) return true;
    const k = Math.min(1, (performance.now() - this.blendStart) / this.blendMs);
    if (k >= 1) {
      this.prevField = null;
      return true;
    }
    if (!sampleField(prev, lon, lat, this.tmpB)) return true;
    this.tmpA[0] = this.tmpB[0] + (this.tmpA[0] - this.tmpB[0]) * k;
    this.tmpA[1] = this.tmpB[1] + (this.tmpA[1] - this.tmpB[1]) * k;
    return true;
  }

  private step() {
    const ctx = this.ctx;
    const n = this.lon.length;
    const bounds = this.viewBounds();
    const zoom = this.map.getZoom();
    const dppLon = degPerPixel(zoom);
    if (this.reproject) {
      for (let i = 0; i < n; i++) {
        if (Number.isNaN(this.lon[i])) continue;
        const p = this.map.project([this.lon[i], this.lat[i]]);
        this.px[i] = p.x;
        this.py[i] = p.y;
      }
      this.reproject = false;
    }
    // Fade existing trails.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.93)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineWidth = zoom > 9 ? 2.2 : zoom > 7 ? 1.8 : 1.5;
    ctx.lineCap = 'round';
    const paths: Path2D[] = Array.from({ length: BINS }, () => new Path2D());
    const used = new Uint8Array(BINS);
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(this.lon[i]) || this.age[i] >= MAX_AGE) {
        this.respawn(i, bounds);
        continue;
      }
      const lon = this.lon[i], lat = this.lat[i];
      if (!this.sample(lon, lat)) {
        this.age[i] = MAX_AGE;
        continue;
      }
      const [u, v] = this.tmpA;
      const kmh = Math.hypot(u, v);
      // Pixels this frame → degrees (Mercator: latitude degrees per pixel shrink with cos φ).
      const scale = kmh > 1e-6 ? pxPerFrame(kmh) / kmh : 0;
      const nlon = lon + u * scale * dppLon;
      const nlat = lat + v * scale * dppLon * Math.cos(lat * RAD);
      const p = this.map.project([nlon, nlat]);
      const x0 = this.px[i], y0 = this.py[i];
      this.lon[i] = nlon;
      this.lat[i] = nlat;
      this.px[i] = p.x;
      this.py[i] = p.y;
      this.age[i]++;
      if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) {
        this.age[i] = MAX_AGE;
        continue;
      }
      const b = Math.min(BINS - 1, Math.floor((kmh / BIN_MAX_KMH) * BINS));
      paths[b].moveTo(x0, y0);
      paths[b].lineTo(p.x, p.y);
      used[b] = 1;
    }
    for (let b = 0; b < BINS; b++) {
      if (!used[b]) continue;
      ctx.strokeStyle = this.colors[b];
      ctx.stroke(paths[b]);
    }
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.offs.forEach((f) => f());
    this.canvas.remove();
  }
}
