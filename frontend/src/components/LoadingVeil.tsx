import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { FlameLogo } from './TopBar';

/** Splash until the map is ready; a full-screen message if WebGL isn't available. */
export function LoadingVeil() {
  const ready = useStore((s) => s.map.ready);
  const webglError = useStore((s) => s.map.webglError);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setGone(true), 450);
    return () => clearTimeout(t);
  }, [ready]);

  if (webglError)
    return (
      <div className="veil veil--error" role="alert">
        <FlameLogo size={44} />
        <h1>The map can’t be displayed</h1>
        <p>FireWatch needs WebGL. Try a current version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is turned on.</p>
      </div>
    );
  if (gone) return null;
  return (
    <div className={`veil${ready ? ' is-done' : ''}`} aria-hidden={ready}>
      <FlameLogo size={44} />
      <div className="veil__name">FireWatch</div>
      <div className="veil__bar">
        <span />
      </div>
    </div>
  );
}
