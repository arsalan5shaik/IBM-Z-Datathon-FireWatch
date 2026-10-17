import { setState, useStore } from '../state/store';

/** Quick Default / Terrain switch (top-right), mirroring the option in the Layers popover. */
export function StyleSwitch() {
  const basemap = useStore((s) => s.basemap);
  return (
    <div className="style-switch ctrl-card seg-vertical" role="radiogroup" aria-label="Map style">
      {(['default', 'terrain'] as const).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={basemap === k} className={basemap === k ? 'is-active' : ''} onClick={() => setState({ basemap: k })}>
          {k === 'default' ? 'Default' : 'Terrain'}
        </button>
      ))}
    </div>
  );
}
