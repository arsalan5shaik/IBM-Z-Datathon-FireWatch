import { useStore } from '../state/store';
import type { Selection } from '../types';
import { usePresence } from './ui';
import { CellPanel, PlacePanel } from './panels/RiskPanels';
import { HotspotPanel, IncidentPanel } from './panels/FirePanels';

/** Right slide-over (desktop) / bottom sheet (mobile). Only rendered when something is selected. */
export function DetailPanel() {
  const { shown, closing } = usePresence(useStore((s) => s.selection));
  if (!shown) return null;
  return <div className={`panel-presence${closing ? ' is-closing' : ''}`}>{content(shown)}</div>;
}

function content(sel: Selection) {
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
