import { Pause, Play, RotateCcw, Satellite, X } from 'lucide-react';
import { useMemo } from 'react';
import { seekReplay, stopReplay, toggleReplay } from '../state/replay';
import { useStore } from '../state/store';
import { formatStamp, relativeTime } from '../lib/time';

/** Floating controls for the hotspot replay (shown only while a replay is active). */
export function ReplayBar() {
  const replay = useStore((s) => s.replay);
  const detections = useStore((s) => s.fires.data?.detections);
  const now = useStore((s) => s.now);
  const times = useMemo(() => (detections ?? []).map((d) => Date.parse(d.acquired_at)).sort((a, b) => a - b), [detections]);
  if (!replay) return null;
  const frac = replay.progress;
  let shown = 0;
  for (const t of times) if (t >= replay.from && t <= replay.at) shown++;
  const done = !replay.playing && replay.progress >= 1;
  return (
    <div className="replay" role="region" aria-label="Hotspot replay">
      <span className="replay__icon" aria-hidden>
        <Satellite size={16} />
      </span>
      <button type="button" className="replay__play" aria-label={replay.playing ? 'Pause replay' : done ? 'Replay again' : 'Resume replay'} onClick={toggleReplay}>
        {replay.playing ? <Pause size={16} fill="currentColor" /> : done ? <RotateCcw size={16} /> : <Play size={16} fill="currentColor" />}
      </button>
      <div className="replay__main">
        <div className="replay__text">
          <strong>{formatStamp(replay.at)}</strong>
          <span>
            {shown.toLocaleString()} detection{shown === 1 ? '' : 's'} · {relativeTime(replay.at, now)}
          </span>
        </div>
        <input
          className="replay__range"
          type="range"
          min={0}
          max={1000}
          value={Math.round(frac * 1000)}
          aria-label="Replay position"
          aria-valuetext={formatStamp(replay.at)}
          onChange={(e) => seekReplay(Number(e.target.value) / 1000)}
          style={{ ['--p' as string]: frac }}
        />
        <small className="replay__note">Past satellite detections by acquisition time · not fire spread</small>
      </div>
      <button type="button" className="icon-btn icon-btn--sm" aria-label="Close replay" onClick={stopReplay}>
        <X size={16} />
      </button>
    </div>
  );
}
