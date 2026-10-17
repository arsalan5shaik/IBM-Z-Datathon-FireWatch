import { useStore } from '../state/store';
import { CellPanel, PlacePanel } from './panels/RiskPanels';
import { HotspotPanel, IncidentPanel } from './panels/FirePanels';

/** Right slide-over (desktop) / bottom sheet (mobile). Only rendered when something is selected. */
export function DetailPanel() {
  const sel = useStore((s) => s.selection);
  if (!sel) return null;
  switch (sel.kind) {
    case 'cell':
      return <CellPanel key={sel.cellId} cellId={sel.cellId} lngLat={sel.lngLat} />;
    case 'place':
      return <PlacePanel key={sel.place.id} place={sel.place} />;
    case 'hotspot':
      return <HotspotPanel key={sel.detectionId} detectionId={sel.detectionId} />;
    case 'incident':
      return <IncidentPanel key={sel.incidentId} incidentId={sel.incidentId} />;
    case 'group':
      return <IncidentPanel key={sel.groupId} groupId={sel.groupId} />;
  }
}
