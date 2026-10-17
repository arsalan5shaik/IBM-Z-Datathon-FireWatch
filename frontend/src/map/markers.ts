import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { FireGroup, Incident } from '../types';
import { HOUR_MS, relativeTime } from '../lib/time';
import { select } from '../state/store';

const FLAME_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.6 1.5c.8 3.5-1 5.5-2.9 7.4C7.9 10.8 6 12.8 6 15.8 6 20 9.1 23 12.7 23S19.5 20.1 19.5 16c0-2.8-1.4-4.7-2.9-6.1.2 1.7-.3 3.1-1.6 3.8.4-3.2-.7-6.6-2.5-8.7 0 0 .2-2 .1-3.5z" fill="currentColor"/><path d="M13 14.2c1.3 1.2 2.4 2.6 2.4 4.3 0 1.8-1.2 3-2.7 3s-2.7-1.3-2.7-2.9c0-1.7 1.4-2.8 2.3-3.9.3.8.8 1.3 1.3 1.5-.1-.7-.3-1.4-.6-2z" fill="#FFE66D"/></svg>';

interface Entry {
  marker: Marker;
  el: HTMLElement;
  key: string;
}

/**
 * Flame badges for groups of satellite detections (like the reference design).
 * HTML markers are cheap for a few dozen groups and keep CSS pulse animations off the GL canvas.
 */
export class FireMarkers {
  private entries = new Map<string, Entry>();
  constructor(private map: MapLibreMap) {}

  update(groups: FireGroup[], incidents: Incident[], now: number, visible: boolean, selectedId: string | null) {
    const byIncident = new Map(incidents.map((i) => [i.id, i]));
    const wanted = new Set<string>();
    for (const g of groups) {
      if (g.count < 3 && !g.incidentId) continue;
      wanted.add(g.id);
      const incident = g.incidentId ? byIncident.get(g.incidentId) : undefined;
      const fresh = now - g.latest < 3 * HOUR_MS;
      const size = g.count >= 60 ? 'lg' : g.count >= 15 ? 'md' : 'sm';
      const name = incident?.name ?? 'Hotspot cluster';
      const key = `${size}|${fresh}|${name}|${g.count}|${selectedId === g.id || selectedId === g.incidentId}`;
      let entry = this.entries.get(g.id);
      if (!entry) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'fw-flame';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const id = el.dataset.incident;
          select(id ? { kind: 'incident', incidentId: id } : { kind: 'group', groupId: el.dataset.group! });
        });
        const marker = new Marker({ element: el, anchor: 'center' }).setLngLat(g.center).addTo(this.map);
        entry = { marker, el, key: '' };
        this.entries.set(g.id, entry);
      }
      entry.marker.setLngLat(g.center);
      const el = entry.el;
      el.dataset.group = g.id;
      if (g.incidentId) el.dataset.incident = g.incidentId;
      else delete el.dataset.incident;
      el.title = `${name} · ${g.count} detections · latest ${relativeTime(g.latest, now)}`;
      el.setAttribute('aria-label', `${name}: ${g.count} satellite detections, latest ${relativeTime(g.latest, now)}`);
      if (entry.key !== key) {
        entry.key = key;
        // classList (not className): MapLibre's own `maplibregl-marker` classes must survive.
        el.classList.remove('fw-flame--sm', 'fw-flame--md', 'fw-flame--lg');
        el.classList.add(`fw-flame--${size}`);
        el.classList.toggle('is-fresh', fresh);
        el.classList.toggle('is-selected', key.endsWith('true'));
        el.innerHTML = `<span class="fw-flame__pulse"></span><span class="fw-flame__badge">${FLAME_SVG}</span><span class="fw-flame__label">${escapeHtml(name)}</span>`;
      }
    }
    for (const [id, entry] of this.entries)
      if (!wanted.has(id)) {
        entry.marker.remove();
        this.entries.delete(id);
      }
    this.map.getContainer().classList.toggle('fw-hide-flames', !visible);
  }

  destroy() {
    for (const e of this.entries.values()) e.marker.remove();
    this.entries.clear();
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
