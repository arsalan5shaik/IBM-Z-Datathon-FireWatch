import { setState, useStore } from '../state/store';
import { useEffect, useState, type CSSProperties } from 'react';

const CELL = 'CA3K_X-0038_Y-0002';
const ENDPOINT = `/api/v1/erc/cells/${CELL}`;

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

export function ERCV6Panel() {
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [selected, setSelected] = useState(0);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const chatOpen = useStore((state) => state.chatOpen);
  const [restoreChat, setRestoreChat] = useState(false);

  // Automatically hide V6 data while opening the chatbot.
  useEffect(() => {
    setExpanded(!chatOpen);
  }, [chatOpen]);

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const response = await fetch(ENDPOINT, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Forecast API: HTTP ${response.status}`);
        const data = (await response.json()) as Forecast;
        if (active) {
          setForecast((previous) =>
            previous?.snapshot_id === data.snapshot_id ? previous : data
          );
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
  }, []);

  const day = forecast?.predictions[selected];

  useEffect(() => {
    if (!forecast || !day) return;

    const controller = new AbortController();
    setExplanation(null);

    const params = new URLSearchParams({
      date: day.valid_date,
      snapshot_id: forecast.snapshot_id,
    });

    fetch(`${ENDPOINT}/explain?${params}`, { signal: controller.signal })
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
  }, [forecast, day]);

  const panelStyle: CSSProperties = {
    position: 'fixed',
    top: 175,
    right: 18,
    zIndex: 900,
    width: 310,
    maxWidth: 'calc(100vw - 36px)',
    maxHeight: 'calc(100vh - 195px)',
    overflowY: 'auto',
    background: '#111d2b',
    color: '#f1f5f9',
    border: '1px solid #334155',
    borderRadius: 14,
    boxShadow: '0 12px 38px #0008',
    padding: 16,
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 13,
  };

  function openV6() {
    if (chatOpen) {
      setRestoreChat(true);
      setState({ chatOpen: false });
    }
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
      <button
        type="button"
        aria-label="Open FireWatch V6 data"
        aria-expanded={false}
        onClick={openV6}
        style={{
          position: 'fixed',
          top: 245,
          right: 0,
          zIndex: 1200,
          background: '#f97316',
          color: '#fff',
          padding: '14px 7px',
          border: 'none',
          borderRadius: '9px 0 0 9px',
          fontWeight: 800,
          fontSize: 11,
          cursor: 'pointer',
          boxShadow: '0 5px 20px #0005',
          writingMode: 'vertical-rl',
        }}
      >
        V6 DATA ◀
      </button>
    );
  }

  return (
    <aside style={panelStyle} aria-label="Experimental Stockton ERC-G forecast">
      <button
        type="button"
        onClick={closeV6}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: '#fb923c',
          fontWeight: 800,
          cursor: 'pointer',
          textAlign: 'left',
          padding: 0,
        }}
      >
        FIREWATCH V6 · {expanded ? 'MINIMIZE −' : 'EXPAND +'}
      </button>
      {expanded && (<>

      <h3 style={{ margin: '8px 0 4px', fontSize: 19 }}>
        Stockton, CA
      </h3>

      <p style={{ color: '#94a3b8', fontSize: 11, marginTop: 0 }}>
        Experimental daily ERC-G · One grid cell · Not fire probability
      </p>

      {loading && <p>Loading live forecasts...</p>}
      {error && <p style={{ color: '#fca5a5' }}>{error}</p>}

      {forecast && (
        <>
          <div style={{
            display: 'flex',
            gap: 5,
            margin: '14px 0',
            flexWrap: 'wrap',
          }}>
            {forecast.predictions.map((item, index) => (
              <button
                key={item.valid_date}
                type="button"
                onClick={() => setSelected(index)}
                style={{
                  flex: 1,
                  minWidth: 35,
                  padding: '9px 2px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  background: selected === index ? '#f97316' : '#28384b',
                  color: 'white',
                  border: 'none',
                }}
              >
                D{item.lead_day}
              </button>
            ))}
          </div>

          {day && (
            <div style={{
              background: '#1c2b3d',
              borderRadius: 10,
              padding: 14,
            }}>
              <div style={{ color: '#cbd5e1' }}>
                {day.valid_date}
              </div>

              <div style={{
                fontSize: 36,
                fontWeight: 800,
                color: '#fb923c',
              }}>
                {day.erc_g_display.toFixed(2)}
              </div>

              <div style={{ color: '#94a3b8' }}>
                ERC-G index · Daily estimate
              </div>
            </div>
          )}

          <h4 style={{ marginBottom: 8 }}>
            Model explanation (TreeSHAP)
          </h4>

          {!explanation && (
            <p style={{ color: '#94a3b8' }}>
              Loading explanation...
            </p>
          )}

          {explanation &&
            [...explanation.features]
              .sort((a, b) =>
                Math.abs(b.shap_value) - Math.abs(a.shap_value)
              )
              .slice(0, 6)
              .map((feature) => (
                <div
                  key={feature.name}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    margin: '9px 0',
                  }}
                >
                  <span>{feature.name.replaceAll('_', ' ')}</span>

                  <strong style={{
                    color: feature.shap_value >= 0
                      ? '#fda4af'
                      : '#93c5fd',
                  }}>
                    {feature.shap_value > 0 ? '+' : ''}
                    {feature.shap_value.toFixed(2)}
                  </strong>
                </div>
              ))}

          <div style={{
            borderTop: '1px solid #334155',
            marginTop: 14,
            paddingTop: 10,
            color: '#94a3b8',
            fontSize: 10,
          }}>
            Weather retrieved: {
              new Date(forecast.retrieved_at_utc).toLocaleString()
            }

            <div>Snapshot: {forecast.snapshot_id}</div>
            <div>Frozen model: {forecast.model_version}</div>

            <div style={{ marginTop: 6 }}>
              Experimental estimate. Forecast accuracy and
              danger thresholds not validated.
            </div>
          </div>
        </>
      )}
      </>)}
    </aside>
  );
}
