import { Crosshair, ExternalLink, Flame, Satellite, Sparkles } from 'lucide-react';
import { askAbout } from '../../state/actions';
import { cellIndexAt, describePoint } from '../../state/lookups';
import { select, useStore } from '../../state/store';
import { fitBbox, flyToPoint } from '../../map/mapRef';
import { bboxOfGeometry, bboxOfPoints, padBbox, type LngLat } from '../../lib/geo';
import { confidenceLabel, formatAcres, formatFrp, formatPct, plural, sensorLabel } from '../../lib/format';
import { utcLabel } from '../../api/fires';
import { formatStamp, parseTime, relativeTime } from '../../lib/time';
import type { FireGroup, Incident } from '../../types';
import { Note, OriginTag, Section, Stats } from '../ui';
import { NearbyFires, PanelShell } from './shared';

function useLocationLabel(p: LngLat): string {
  const grid = useStore((s) => s.risk.data);
  const index = useStore((s) => s.places.data);
  const i = grid ? cellIndexAt(grid, p) : -1;
  const where = describePoint(index, p, i >= 0 ? grid!.cells[i].properties : null);
  const near = where.near ? `near ${where.near}` : '';
  const county = where.county ? `${where.county} County` : '';
  return [near, county].filter(Boolean).join(', ') || `${p[1].toFixed(4)}, ${p[0].toFixed(4)}`;
}

export function HotspotPanel({ detectionId }: { detectionId: string }) {
  const det = useStore((s) => s.fires.data?.detections.find((d) => d.id === detectionId) ?? null);
  const meta = useStore((s) => s.fires.data?.metadata);
  const origin = useStore((s) => s.fires.origin);
  const incident = useStore((s) => (det?.incident_id ? s.incidents.data?.incidents.find((i) => i.id === det.incident_id) : null) ?? null);
  const now = useStore((s) => s.now);
  const point: LngLat = det ? [det.lon, det.lat] : [0, 0];
  const where = useLocationLabel(point);

  if (!det)
    return (
      <PanelShell icon={<Satellite size={18} />} title="Satellite hotspot">
        <Note>This detection is no longer in the current data window.</Note>
      </PanelShell>
    );
  const at = parseTime(det.acquired_at);
  return (
    <PanelShell
      icon={<Satellite size={18} />}
      title="Satellite hotspot"
      subtitle={`${sensorLabel(det.sensor)} · ${at ? relativeTime(at, now) : 'time unavailable'}`}
      actions={
        <>
          <button type="button" className="btn btn--primary" onClick={() => askAbout('What can you tell me about this hotspot and the area around it?')}>
            <Sparkles size={16} /> Ask AI about this
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => flyToPoint(point, 13)}>
            <Crosshair size={16} /> View on map
          </button>
        </>
      }
      footer={
        <>
          <span>Source: {meta?.source ?? 'NASA FIRMS'}</span>
          <OriginTag origin={origin} />
        </>
      }
    >
      <Stats
        rows={[
          ['Detected', at ? `${formatStamp(at)} (${relativeTime(at, now)})` : 'Unavailable'],
          ['Acquired (UTC)', utcLabel(det.acquired_at)],
          ['Satellite', sensorLabel(det.sensor)],
          ['Confidence', confidenceLabel(det.confidence)],
          ['Fire radiative power', formatFrp(det.frp_mw)],
          ['Overpass', det.daynight === 'D' ? 'Daytime' : det.daynight === 'N' ? 'Nighttime' : 'Unavailable'],
          ['Location', where],
          ['Coordinates', `${det.lat.toFixed(4)}, ${det.lon.toFixed(4)}`],
          [
            'Matched incident',
            incident ? (
              <button type="button" className="link" onClick={() => select({ kind: 'incident', incidentId: incident.id })}>
                {incident.name}
              </button>
            ) : (
              'None matched'
            ),
          ],
        ]}
      />
      <Note>
        A hotspot is a satellite-detected heat signal (roughly a 375 m pixel) — not a confirmed wildfire or fire perimeter. FRP is an intensity proxy, not fire size or
        risk.
      </Note>
      <NearbyFires point={point} km={15} title="Activity nearby" />
    </PanelShell>
  );
}

function SatelliteActivity({ group }: { group: FireGroup | undefined }) {
  const now = useStore((s) => s.now);
  const lookback = useStore((s) => s.lookbackHours);
  if (!group) return <Note>No satellite detections linked to this incident in the last {lookback} hours.</Note>;
  return (
    <Stats
      rows={[
        ['Detections', `${plural(group.count, 'hotspot')} (last ${lookback} h)`],
        ['Latest', `${formatStamp(group.latest)} (${relativeTime(group.latest, now)})`],
        ['Earliest in window', formatStamp(group.earliest)],
        ['Peak FRP', formatFrp(group.maxFrp)],
      ]}
    />
  );
}

export function IncidentPanel({ incidentId, groupId }: { incidentId?: string; groupId?: string }) {
  const incident: Incident | null = useStore((s) => (incidentId ? s.incidents.data?.incidents.find((i) => i.id === incidentId) : null) ?? null);
  const group = useStore((s) => s.derived.groups.find((g) => (groupId ? g.id === groupId : g.incidentId === incidentId)));
  const meta = useStore((s) => s.incidents.data?.metadata);
  const origin = useStore((s) => s.incidents.origin);
  const now = useStore((s) => s.now);
  const center: LngLat = incident?.center ?? group?.center ?? [0, 0];
  const where = useLocationLabel(center);

  if (!incident && !group)
    return (
      <PanelShell icon={<Flame size={18} />} title="Fire activity">
        <Note>This fire activity is no longer in the current data.</Note>
      </PanelShell>
    );

  const bbox = incident?.geometry ? bboxOfGeometry(incident.geometry) : group ? padBbox(group.bbox, 1.5) : bboxOfPoints([center]);
  const updated = parseTime(incident?.updated_at);
  return (
    <PanelShell
      icon={<Flame size={18} />}
      title={incident?.name ?? 'Unnamed hotspot cluster'}
      subtitle={incident ? `${incident.status ?? 'Incident'} · ${where}` : `Not matched to an official incident · ${where}`}
      actions={
        <>
          <button type="button" className="btn btn--primary" onClick={() => askAbout(incident ? `Tell me about the ${incident.name} and conditions around it.` : 'What do you know about this hotspot cluster?')}>
            <Sparkles size={16} /> Ask AI about this
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => fitBbox(bbox, 13)}>
            <Crosshair size={16} /> View on map
          </button>
        </>
      }
      footer={
        <>
          <span>{incident ? `Incident source: ${incident.source}` : 'Grouped from satellite detections within 2.5 km'}</span>
          <OriginTag origin={origin} />
        </>
      }
    >
      {incident && (
        <Section title="Incident record">
          <Stats
            rows={[
              ['Size', formatAcres(incident.acres)],
              ['Containment', incident.containment_pct != null ? formatPct(incident.containment_pct) : 'Unavailable'],
              ['Perimeter', incident.geometry ? `Mapped${updated ? ` · updated ${relativeTime(updated, now)}` : ''}` : 'Not yet mapped'],
              ['Status', incident.status ?? 'Unavailable'],
            ]}
          />
          {incident.url && (
            <a className="link" href={incident.url} target="_blank" rel="noopener noreferrer">
              Official incident page <ExternalLink size={13} />
            </a>
          )}
          <Note>Official perimeters can lag behind current activity. Acreage and containment come only from the incident record{meta?.sample ? ' (sample data)' : ''}.</Note>
        </Section>
      )}
      <Section title="Satellite activity">
        <SatelliteActivity group={group} />
      </Section>
      {!incident && <Note>Clusters group nearby satellite detections for display. They are not official incidents and may include agricultural or industrial heat.</Note>}
      <NearbyFires point={center} km={30} title="Other activity nearby" exclude={incident?.id ?? group?.id} />
    </PanelShell>
  );
}
