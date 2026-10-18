import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { FireGroup, Incident } from '../types';
import { padBbox, type BBox, type LngLat } from '../lib/geo';
import { HOUR_MS, relativeTime } from '../lib/time';
import { select } from '../state/store';
import { fitBbox } from './mapRef';
import { MOTION, easeOutCubic, motionOn, tween } from './motion';

const FLAME_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.6 1.5c.8 3.5-1 5.5-2.9 7.4C7.9 10.8 6 12.8 6 15.8 6 20 9.1 23 12.7 23S19.5 20.1 19.5 16c0-2.8-1.4-4.7-2.9-6.1.2 1.7-.3 3.1-1.6 3.8.4-3.2-.7-6.6-2.5-8.7 0 0 .2-2 .1-3.5z" fill="currentColor"/><path d="M13 14.2c1.3 1.2 2.4 2.6 2.4 4.3 0 1.8-1.2 3-2.7 3s-2.7-1.3-2.7-2.9c0-1.7 1.4-2.8 2.3-3.9.3.8.8 1.3 1.3 1.5-.1-.7-.3-1.4-.6-2z" fill="#FFE66D"/></svg>';

/** Groups merged at the current zoom (screen-space greedy clustering). */
export interface Cluster {
  id: string;
  center: LngLat;
  count: number;
  groups: FireGroup[];
  bbox: BBox;
  latest: number;
}

const RAD = Math.PI / 180;
const worldPx = ([lon, lat]: LngLat, z: number): [number, number] => {
  const scale = 512 * 2 ** z;
  const s = Math.sin(Math.max(-85, Math.min(85, lat)) * RAD);
  return [((lon + 180) / 360) * scale, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale];
};

/**
 * Merge groups whose markers would overlap at zoom `z` (largest first, so the dominant fire keeps
 * its position). Above z10 every group stands alone. Cluster ids are the anchor group's id, so the
 * same fire keeps its marker across zoom levels.
 */
export function clusterGroups(groups: FireGroup[], z: number, radiusPx = 52): Cluster[] {
  const sorted = [...groups].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  if (z >= 10) return sorted.map((g) => ({ id: g.id, center: g.center, count: g.count, groups: [g], bbox: g.bbox, latest: g.latest }));
  const px = sorted.map((g) => worldPx(g.center, z));
  const used = new Uint8Array(sorted.length);
  const out: Cluster[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const members = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      if (Math.hypot(px[j][0] - px[i][0], px[j][1] - px[i][1]) <= radiusPx) {
        used[j] = 1;
        members.push(sorted[j]);
      }
    }
    const count = members.reduce((s, g) => s + g.count, 0);
    const center: LngLat = members.length === 1 ? members[0].center : [members.reduce((s, g) => s + g.center[0] * g.count, 0) / count, members.reduce((s, g) => s + g.center[1] * g.count, 0) / count];
    out.push({
      id: sorted[i].id,
      center,
      count,
      groups: members,
      bbox: [Math.min(...members.map((g) => g.bbox[0])), Math.min(...members.map((g) => g.bbox[1])), Math.max(...members.map((g) => g.bbox[2])), Math.max(...members.map((g) => g.bbox[3]))],
      latest: Math.max(...members.map((g) => g.latest)),
    });
  }
  return out;
}

interface Entry {
  marker: Marker;
  el: HTMLButtonElement;
  key: string;
  pos: LngLat;
  move: () => void;
  leaving: boolean;
}

/**
 * Flame badges for fire groups. HTML markers are cheap for a few dozen groups and keep CSS
 * animations off the GL canvas. They cluster by zoom, and splitting / merging is animated:
 * children slide out of their parent's position and merge back into it.
 */
export class FireMarkers {
  private entries = new Map<string, Entry>();
  private groups: FireGroup[] = [];
  private incidents: Incident[] = [];
  private now = Date.now();
  private visible = true;
  private selectedId: string | null = null;
  private zoomBucket: number;
  /** group id → cluster id at the last render. */
  private clusterOf = new Map<string, string>();
  private lastClusters = new Map<string, Cluster>();

  constructor(private map: MapLibreMap) {
    this.zoomBucket = Math.round(map.getZoom());
  }

  update(groups: FireGroup[], incidents: Incident[], now: number, visible: boolean, selectedId: string | null) {
    this.groups = groups;
    this.incidents = incidents;
    this.now = now;
    this.visible = visible;
    this.selectedId = selectedId;
    this.render(false);
  }

  setZoom(zoom: number) {
    const b = Math.round(zoom);
    if (b === this.zoomBucket) return;
    this.zoomBucket = b;
    this.render(true);
  }

  private glide(entry: Entry, to: LngLat, duration: number = MOTION.slow) {
    entry.move();
    const from = entry.pos;
    if (from[0] === to[0] && from[1] === to[1]) return;
    entry.move = tween(
      duration,
      (k) => {
        entry.pos = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
        entry.marker.setLngLat(entry.pos);
      },
      { easing: easeOutCubic },
    );
  }

  private remove(id: string, entry: Entry, toward?: LngLat) {
    if (entry.leaving) return;
    entry.leaving = true;
    this.entries.delete(id);
    if (!motionOn()) {
      entry.move();
      entry.marker.remove();
      return;
    }
    if (toward) this.glide(entry, toward, MOTION.base);
    entry.el.classList.add('is-leaving');
    setTimeout(() => {
      entry.move();
      entry.marker.remove();
    }, MOTION.base + 60);
  }

  private render(zoomChanged: boolean) {
    const byIncident = new Map(this.incidents.map((i) => [i.id, i]));
    const eligible = this.groups.filter((g) => g.count >= 3 || g.incidentId);
    const clusters = clusterGroups(eligible, this.zoomBucket);
    const nextOf = new Map<string, string>();
    for (const c of clusters) for (const g of c.groups) nextOf.set(g.id, c.id);
    const animate = motionOn();
    const wanted = new Set(clusters.map((c) => c.id));

    for (const c of clusters) {
      const anchor = c.groups[0];
      const single = c.groups.length === 1;
      const incident = single && anchor.incidentId ? byIncident.get(anchor.incidentId) : undefined;
      const fresh = this.now - c.latest < 3 * HOUR_MS;
      const size = c.count >= 60 ? 'lg' : c.count >= 15 ? 'md' : 'sm';
      const name = single ? (incident?.name ?? 'Hotspot cluster') : `${c.groups.length} fire areas`;
      const selected = c.groups.some((g) => this.selectedId === g.id || (g.incidentId && this.selectedId === g.incidentId));
      const key = `${size}|${fresh}|${name}|${c.count}|${selected}|${single}`;
      let entry = this.entries.get(c.id);
      if (!entry) {
        // Born where its parent (or previous cluster) was, then slides to its own place.
        const prevId = this.clusterOf.get(anchor.id);
        const origin = zoomChanged && animate && prevId ? this.lastClusters.get(prevId)?.center : undefined;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'fw-flame';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const cluster = this.lastClusters.get(el.dataset.cluster ?? '');
          if (cluster && cluster.groups.length > 1) {
            fitBbox(padBbox(cluster.bbox, 4), Math.min(13, this.zoomBucket + 3));
            return;
          }
          const id = el.dataset.incident;
          select(id ? { kind: 'incident', incidentId: id } : { kind: 'group', groupId: el.dataset.group! });
        });
        const pos = origin ?? c.center;
        const marker = new Marker({ element: el, anchor: 'center' }).setLngLat(pos).addTo(this.map);
        entry = { marker, el, key: '', pos, move: () => undefined, leaving: false };
        this.entries.set(c.id, entry);
        if (animate) {
          el.classList.add('is-entering');
          requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-entering')));
        }
      }
      this.glide(entry, c.center, zoomChanged ? MOTION.slow : MOTION.base);
      const el = entry.el;
      el.dataset.cluster = c.id;
      el.dataset.group = anchor.id;
      if (single && anchor.incidentId) el.dataset.incident = anchor.incidentId;
      else delete el.dataset.incident;
      const summary = single
        ? `${name} · ${c.count} detections · latest ${relativeTime(c.latest, this.now)}`
        : `${c.groups.length} fire areas · ${c.count} detections · latest ${relativeTime(c.latest, this.now)} · click to zoom in`;
      el.title = summary;
      el.setAttribute('aria-label', summary);
      if (entry.key !== key) {
        entry.key = key;
        // classList (not className): MapLibre's own `maplibregl-marker` classes must survive.
        el.classList.remove('fw-flame--sm', 'fw-flame--md', 'fw-flame--lg');
        el.classList.add(`fw-flame--${size}`);
        el.classList.toggle('is-fresh', fresh);
        el.classList.toggle('is-selected', selected);
        el.classList.toggle('is-cluster', !single);
        el.innerHTML = `<span class="fw-flame__body"><span class="fw-flame__pulse"></span><span class="fw-flame__badge">${FLAME_SVG}</span>${single ? '' : `<span class="fw-flame__count">${c.groups.length}</span>`}<span class="fw-flame__label">${escapeHtml(name)}</span></span>`;
      }
    }
    for (const [id, entry] of this.entries)
      if (!wanted.has(id)) {
        // Merging: slide into the cluster that absorbed this one.
        const target = zoomChanged ? clusters.find((c) => c.id === nextOf.get(id))?.center : undefined;
        this.remove(id, entry, target);
      }
    this.clusterOf = nextOf;
    this.lastClusters = new Map(clusters.map((c) => [c.id, c]));
    this.map.getContainer().classList.toggle('fw-hide-flames', !this.visible);
  }

  destroy() {
    for (const e of this.entries.values()) {
      e.move();
      e.marker.remove();
    }
    this.entries.clear();
  }

  /** Marker buttons in reading order (keyboard navigation). */
  elements(): HTMLButtonElement[] {
    return [...this.entries.values()].filter((e) => !e.leaving).map((e) => e.el);
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
