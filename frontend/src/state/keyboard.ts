import { fitCalifornia } from '../map/mapRef';
import { toggleReplay } from './replay';
import { closeOverlays, getState, goLive, setState, stepTime, togglePlay, toggleLayer } from './store';

export const SHORTCUTS: [string, string][] = [
  ['/', 'Search places'],
  ['[  ]', 'Previous / next hour'],
  ['Shift + [  ]', 'Previous / next day'],
  ['P', 'Play / pause the forecast'],
  ['L', 'Back to live'],
  ['3', 'Toggle 2D / 3D'],
  ['T', 'Toggle Default / Terrain map'],
  ['W', 'Toggle wind'],
  ['R', 'Replay recent hotspots'],
  ['H', 'California overview'],
  ['A', 'Ask FireWatch AI'],
  ['Esc', 'Close panels'],
  ['Arrows, + / −', 'Pan and zoom (map focused)'],
];

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export function bindKeyboard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (typing(e.target) && (e.target as HTMLElement).closest('.search')) return; // search handles its own Esc
      if (closeOverlays()) e.preventDefault();
      return;
    }
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const s = getState();
    switch (e.key) {
      case '/':
        e.preventDefault();
        document.querySelector<HTMLInputElement>('#place-search')?.focus();
        break;
      case '[':
        stepTime(-1);
        break;
      case ']':
        stepTime(1);
        break;
      case '{':
        stepTime(-24);
        break;
      case '}':
        stepTime(24);
        break;
      case 'p':
      case 'P':
        togglePlay();
        break;
      case 'l':
      case 'L':
        goLive();
        break;
      case '3':
        setState({ view: s.view === '3d' ? '2d' : '3d' });
        break;
      case 't':
      case 'T':
        setState({ basemap: s.basemap === 'terrain' ? 'default' : 'terrain' });
        break;
      case 'w':
      case 'W':
        toggleLayer('wind');
        break;
      case 'r':
      case 'R':
        toggleReplay();
        break;
      case 'h':
      case 'H':
        fitCalifornia();
        break;
      case 'a':
      case 'A':
        setState({ chatOpen: true });
        break;
      case '?':
        setState({ aboutOpen: true });
        break;
      default:
        return;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
