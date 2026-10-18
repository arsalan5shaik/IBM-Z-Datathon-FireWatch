import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Compass, Flame, Layers, Leaf, Loader2, Minus, Navigation, Plus, Radar, Shapes, Thermometer, Wind, X } from 'lucide-react';
import { API_BASE, LOOKBACK_OPTIONS } from '../config';
import { prefersReducedMotion } from '../map/motion';
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
  const motion = useStore(useShallow((s) => ({ smoothMotion: s.smoothMotion, windFlow: s.windFlow, statewideView: s.statewideView, skyline: s.skyline, dayNight: s.dayNight, view: s.view })));
  const osReduced = prefersReducedMotion();
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
      <div className="popover__group">
        <h3 className="popover__label">Motion &amp; effects</h3>
        <ul className="layer-rows layer-rows--compact">
          <li className={`layer-row${motion.smoothMotion && !osReduced ? ' is-on' : ''}${osReduced ? ' is-disabled' : ''}`}>
            <label className="layer-row__text" htmlFor="pref-motion">
              <span>Smooth motion</span>
              <small>{osReduced ? 'Off: your device asks for reduced motion' : 'Animated transitions between hours and layers'}</small>
            </label>
            <Switch id="pref-motion" checked={motion.smoothMotion && !osReduced} onChange={(v) => !osReduced && setState({ smoothMotion: v })} label="Smooth motion" />
          </li>
          <li className={`layer-row${motion.windFlow ? ' is-on' : ''}`}>
            <label className="layer-row__text" htmlFor="pref-flow">
              <span>Animated wind flow</span>
              <small>Streaks drift downwind with the wind layer</small>
            </label>
            <Switch id="pref-flow" checked={motion.windFlow} onChange={(v) => setState({ windFlow: v, ...(v ? { layers: { ...layers, wind: true } } : {}) })} label="Animated wind flow" />
          </li>
          <li className={`layer-row${motion.dayNight ? ' is-on' : ''}`}>
            <label className="layer-row__text" htmlFor="pref-night">
              <span>Day &amp; night</span>
              <small>Shade night at the selected hour</small>
            </label>
            <Switch id="pref-night" checked={motion.dayNight} onChange={(v) => setState({ dayNight: v })} label="Day and night shading" />
          </li>
          <li className={`layer-row${motion.skyline ? ' is-on' : ''}`}>
            <label className="layer-row__text" htmlFor="pref-skyline">
              <span>3D risk skyline</span>
              <small>{motion.view === '3d' ? 'Raise cells by risk score' : 'Raise cells by risk score (switches to 3D)'}</small>
            </label>
            <Switch id="pref-skyline" checked={motion.skyline} onChange={(v) => setState({ skyline: v, ...(v ? { view: '3d' as const } : {}) })} label="3D risk skyline" />
          </li>
        </ul>
        {!API_BASE && layers.risk && (
          <>
            <h3 className="popover__label popover__label--sub">Statewide view</h3>
            <Segmented
              label="Statewide risk view"
              size="sm"
              value={motion.statewideView}
              options={[
                { value: 'surface', label: 'Smooth', title: 'Smoothed surface at state zoom; model cells when zoomed in' },
                { value: 'coarse', label: 'Coarse', title: 'Larger cells at state zoom' },
                { value: 'cells', label: 'Cells', title: 'Model cells at every zoom' },
              ]}
              onChange={(v) => setState({ statewideView: v })}
            />
          </>
        )}
      </div>
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
