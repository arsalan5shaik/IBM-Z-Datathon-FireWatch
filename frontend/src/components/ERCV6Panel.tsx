import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Minus } from 'lucide-react';
import { API_BASE } from '../config';
import { setState, useStore } from '../state/store';

const CELL = 'CA3K_X-0038_Y-0002';

type Prediction = {
  valid_date: string;
  lead_day: number;
  erc_g_raw: number;
  erc_g_display: number;
  data_status: string;
};

type Forecast = {
  snapshot_id: string;
  model_version: string;
  retrieved_at_utc: string;
  predictions: Prediction[];
};

type Explanation = {
  baseline: number;
  prediction_raw: number;
  additivity_error: number;
  features: {
    name: string;
    value: number;
    shap_value: number;
  }[];
};

/** Tween a displayed number towards `target` so day changes count rather than jump. */
function useAnimatedNumber(target: number | null, ms = 380): number | null {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (target == null) return setValue(null);
    const start = from.current ?? target;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || start === target) {
      from.current = target;
      return setValue(target);
    }
    const t0 = performance.now();
    let id = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - k) ** 3;
      const v = start + (target - start) * e;
      from.current = v;
      setValue(v);
      if (k < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [target, ms]);
  return value;
}

/**
 * Experimental V6 ERC-G forecast for one grid cell (Stockton), served by the FireWatch API.
 * Without a configured backend (public sample demo) there is no V6 data, so the card stays hidden.
 */
export function ERCV6Panel() {
  if (!API_BASE) return null;
  return <ERCV6Card base={API_BASE} />;
}

function ERCV6Card({ base }: { base: string }) {
  const endpoint = `${base}/erc/cells/${CELL}`;
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [selected, setSelected] = useState(0);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const chatOpen = useStore((state) => state.chatOpen);
  const panelOpen = useStore((state) => !!state.selection);
  const [restoreChat, setRestoreChat] = useState(false);

  // Step aside while the assistant or the details panel occupies the right side.
  useEffect(() => {
    setExpanded(!chatOpen && !panelOpen);
  }, [chatOpen, panelOpen]);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const response = await fetch(endpoint, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Forecast API returned HTTP ${response.status}`);
        if (!(response.headers.get('content-type') ?? '').includes('json')) throw new Error('The V6 forecast service is not available on this server');
        const data = (await response.json()) as Forecast;
        if (active) {
          setForecast((previous) => (previous?.snapshot_id === data.snapshot_id ? previous : data));
          setError('');
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Forecast unavailable');
          setLoading(false);
        }
      }
    }

    void refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [endpoint]);

  const day = forecast?.predictions[selected];
  const shown = useAnimatedNumber(day ? day.erc_g_display : null);

  useEffect(() => {
    if (!forecast || !day) return;

    const controller = new AbortController();
    setExplanation(null);

    const params = new URLSearchParams({
      date: day.valid_date,
      snapshot_id: forecast.snapshot_id,
    });

    fetch(`${endpoint}/explain?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`SHAP HTTP ${response.status}`);
        return response.json() as Promise<Explanation>;
      })
      .then((data) => {
        if (!controller.signal.aborted) setExplanation(data);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          console.error('SHAP unavailable', err);
        }
      });

    return () => controller.abort();
  }, [forecast, day, endpoint]);

  function openV6() {
    if (chatOpen) {
      setRestoreChat(true);
      setState({ chatOpen: false });
    }
    if (panelOpen) setState({ selection: null });
    setExpanded(true);
  }

  function closeV6() {
    setExpanded(false);
    if (restoreChat) {
      setRestoreChat(false);
      setState({ chatOpen: true });
    }
  }

  if (!expanded) {
    return (
      <button type="button" className={`v6-tab${error ? ' is-error' : ''}`} aria-label="Open FireWatch V6 data" aria-expanded={false} onClick={openV6}>
        <ChevronLeft size={14} aria-hidden />
        <span>V6 ERC-G</span>
      </button>
    );
  }

  const features = explanation ? [...explanation.features].sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value)).slice(0, 6) : [];
  const maxShap = Math.max(0.01, ...features.map((f) => Math.abs(f.shap_value)));

  return (
    <aside className="v6" aria-label="Experimental Stockton ERC-G forecast">
      <header className="v6__head">
        <span className="v6__eyebrow">FireWatch V6 · experimental</span>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Minimize V6 data" onClick={closeV6}>
          <Minus size={15} />
        </button>
      </header>
      <h3 className="v6__title">Stockton, CA</h3>
      <p className="v6__sub">Daily ERC-G · one grid cell · not a fire probability</p>

      {loading && (
        <div className="v6__skeleton" aria-label="Loading V6 forecast">
          <span />
          <span />
          <span />
        </div>
      )}
      {error && !forecast && <p className="v6__error">V6 forecast unavailable. {error}.</p>}

      {forecast && (
        <>
          <div className="v6__days" role="tablist" aria-label="Forecast day">
            {forecast.predictions.map((item, index) => (
              <button key={item.valid_date} type="button" role="tab" aria-selected={selected === index} className={selected === index ? 'is-active' : ''} onClick={() => setSelected(index)}>
                D{item.lead_day}
              </button>
            ))}
          </div>

          {day && (
            <div className="v6__value">
              <div className="v6__date">{day.valid_date}</div>
              <div className="v6__number">{shown != null ? shown.toFixed(2) : '–'}</div>
              <div className="v6__caption">ERC-G index · daily estimate</div>
            </div>
          )}

          <h4 className="v6__h4">Model explanation (TreeSHAP)</h4>
          {!explanation && (
            <div className="v6__skeleton v6__skeleton--rows" aria-label="Loading explanation">
              <span />
              <span />
              <span />
              <span />
            </div>
          )}
          {features.map((feature) => {
            const up = feature.shap_value >= 0;
            return (
              <div key={feature.name} className="v6__shap">
                <span className="v6__shap-name">{feature.name.replaceAll('_', ' ')}</span>
                <span className="v6__shap-track" aria-hidden>
                  <span className={`v6__shap-bar ${up ? 'is-up' : 'is-down'}`} style={{ width: `${(Math.abs(feature.shap_value) / maxShap) * 100}%` }} />
                </span>
                <strong className={up ? 'is-up' : 'is-down'}>
                  {up ? '+' : ''}
                  {feature.shap_value.toFixed(2)}
                </strong>
              </div>
            );
          })}

          <footer className="v6__foot">
            <div>Weather retrieved: {new Date(forecast.retrieved_at_utc).toLocaleString()}</div>
            <div>Snapshot: {forecast.snapshot_id}</div>
            <div>Frozen model: {forecast.model_version}</div>
            <div className="v6__note">Experimental estimate. Forecast accuracy and danger thresholds not validated.</div>
          </footer>
        </>
      )}
    </aside>
  );
}
