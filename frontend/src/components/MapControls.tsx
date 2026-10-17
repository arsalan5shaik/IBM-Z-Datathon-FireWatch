import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Compass, Flame, Layers, Leaf, Loader2, Minus, Navigation, Plus, Radar, Shapes, Thermometer, Wind, X } from 'lucide-react';
import { LOOKBACK_OPTIONS } from '../config';
import { locateMe } from '../state/actions';
import { setState, toggleLayer, useStore, type Dataset } from '../state/store';
import { resetNorth, zoomBy } from '../map/mapRef';
import type { BasemapStyle, LayerKey } from '../types';
import { Segmented, Spinner, Switch } from './ui';

function StyleThumb({ kind }: { kind: BasemapStyle }) {
  return <span className={`style-thumb style-thumb--${kind}`} aria-hidden />;
}

export function StyleOptions() {
  const basemap = useStore((s) => s.basemap);
  return (
    <div className="style-options" role="radiogroup" aria-label="Map style">
      {(['default', 'terrain'] as const).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={basemap === k} className={basemap === k ? 'is-active' : ''} onClick={() => setState({ basemap: k })}>
          <StyleThumb kind={k} />
          <span>{k === 'default' ? 'Default' : 'Terrain'}</span>
        </button>
      ))}
    </div>
  );
}

function DataState({ ds }: { ds: Dataset<unknown> }) {
  if (ds.state === 'loading' && !ds.data) return <Spinner label="Loading" />;
  if (ds.state === 'error') return <span className="layer-row__err">Unavailable</span>;
  return null;
}

const ROWS: { key: LayerKey; label: string; sub: string; Icon: typeof Flame }[] = [
  { key: 'fires', label: 'Live fires', sub: 'NASA satellite hotspots', Icon: Flame },
  { key: 'risk', label: '7-day risk', sub: 'Hourly forecast (experimental)', Icon: Radar },
  { key: 'perimeters', label: 'Fire perimeters', sub: 'Official, where available', Icon: Shapes },
  { key: 'wind', label: 'Wind', sub: 'Direction & speed for the selected hour', Icon: Wind },
  { key: 'weather', label: 'Weather', sub: 'Temperature & humidity labels', Icon: Thermometer },
  { key: 'vegetation', label: 'Vegetation', sub: 'Fuel types used by the model', Icon: Leaf },
];

function LayersPopover({ onClose }: { onClose: () => void }) {
  const layers = useStore((s) => s.layers);
  const lookback = useStore((s) => s.lookbackHours);
  const opacity = useStore((s) => s.riskOpacity);
  const units = useStore((s) => s.units);
  const datasets = useStore(useShallow((s) => ({ fires: s.fires, risk: s.risk, perimeters: s.incidents, wind: s.weather, weather: s.weather, vegetation: s.risk })));
  const vegAvailable = useStore((s) => !s.risk.data || s.risk.data.cells.some((c) => c.properties.fuel));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, [role="switch"]')?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest('[data-layers-toggle]')) onClose();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  return (
    <div className="popover layers-pop" ref={ref} role="dialog" aria-label="Map layers">
      <div className="popover__head">
        <h2>Map</h2>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Close layers" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <StyleOptions />
      <h3 className="popover__label">Overlays</h3>
      <ul className="layer-rows">
        {ROWS.map(({ key, label, sub, Icon }) => {
          const disabled = key === 'vegetation' && !vegAvailable;
          return (
            <li key={key} className={`layer-row${layers[key] ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
              <span className={`layer-row__icon layer-row__icon--${key}`}>
                <Icon size={16} />
              </span>
              <label className="layer-row__text" htmlFor={`layer-${key}`}>
                <span>{label}</span>
                <small>{disabled ? 'Not provided by the forecast API' : sub}</small>
              </label>
              <DataState ds={datasets[key] as Dataset<unknown>} />
              <Switch id={`layer-${key}`} checked={layers[key] && !disabled} onChange={() => !disabled && toggleLayer(key)} label={label} />
            </li>
          );
        })}
      </ul>
      {layers.fires && (
        <div className="popover__group">
          <h3 className="popover__label">Hotspots from the last</h3>
          <Segmented
            label="Hotspot lookback window"
            size="sm"
            value={lookback}
            options={LOOKBACK_OPTIONS.map((h) => ({ value: h, label: `${h} h` }))}
            onChange={(v) => setState({ lookbackHours: v })}
          />
        </div>
      )}
      {layers.risk && (
        <div className="popover__group">
          <h3 className="popover__label">
            Risk layer opacity <span>{Math.round(opacity * 100)}%</span>
          </h3>
          <input
            className="range"
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={opacity}
            aria-label="Risk layer opacity"
            onChange={(e) => setState({ riskOpacity: Number(e.target.value) })}
          />
        </div>
      )}
      <div className="popover__group popover__group--row">
        <h3 className="popover__label">Units</h3>
        <Segmented
          label="Units"
          size="sm"
          value={units}
          options={[
            { value: 'us', label: '°F · mph' },
            { value: 'metric', label: '°C · km/h' },
          ]}
          onChange={(v) => setState({ units: v })}
        />
      </div>
    </div>
  );
}

function LocateButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="ctrl"
      aria-label="Show my location"
      data-tip="My location"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await locateMe();
        setBusy(false);
      }}
    >
      {busy ? <Loader2 size={18} className="spin" /> : <Navigation size={18} />}
    </button>
  );
}

export function MapControls() {
  const view = useStore((s) => s.view);
  const wind = useStore((s) => s.layers.wind);
  const layersOpen = useStore((s) => s.layersOpen);
  const bearing = useStore((s) => s.map.bearing);
  const terrainError = useStore((s) => s.map.terrainError);
  const close = () => setState({ layersOpen: false });

  return (
    <nav className="controls" aria-label="Map controls">
      <div className="ctrl-card seg-vertical" role="radiogroup" aria-label="Map perspective">
        {(['2d', '3d'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={view === v}
            className={view === v ? 'is-active' : ''}
            onClick={() => setState({ view: v })}
            title={v === '3d' ? (terrainError ? '3D view (terrain unavailable — tilted map)' : 'Subtle 3D terrain view') : 'Flat top-down view'}
          >
            {v.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="ctrl-anchor">
        <button
          type="button"
          className={`ctrl${layersOpen ? ' is-on' : ''}`}
          aria-label="Map style and layers"
          aria-expanded={layersOpen}
          data-layers-toggle
          data-tip="Layers"
          onClick={() => setState({ layersOpen: !layersOpen, calendarOpen: false })}
        >
          <Layers size={18} />
        </button>
        {layersOpen && <LayersPopover onClose={close} />}
      </div>
      <button type="button" className={`ctrl${wind ? ' is-on' : ''}`} aria-label="Wind" aria-pressed={wind} data-tip={wind ? 'Hide wind' : 'Show wind'} onClick={() => toggleLayer('wind')}>
        <Wind size={18} />
      </button>
      <LocateButton />
      <div className="ctrl-card ctrl-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1)}>
          <Plus size={18} />
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)}>
          <Minus size={18} />
        </button>
      </div>
      {Math.abs(bearing) > 0.5 && (
        <button type="button" className="ctrl" aria-label="Reset map to north" data-tip="Reset north" onClick={resetNorth}>
          <Compass size={18} style={{ transform: `rotate(${-bearing - 45}deg)` }} />
        </button>
      )}
    </nav>
  );
}
