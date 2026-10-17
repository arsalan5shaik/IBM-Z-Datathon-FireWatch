import { Fragment, type ReactNode } from 'react';
import { riskColor, riskLabel, riskLevelKey } from '../lib/risk';

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button type="button" role="switch" id={id} aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch__knob" />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`segmented segmented--${size}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'is-active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section">
      <header className="section__head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Stats({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="stats">
      {rows.map(([k, v], i) => (
        <Fragment key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function RiskBadge({ score, size = 'md' }: { score: number; size?: 'sm' | 'md' }) {
  const key = riskLevelKey(score);
  return (
    <span className={`risk-badge risk-badge--${size} risk-badge--${key}`} style={{ ['--c' as string]: riskColor(Math.max(score, 0.2)) }}>
      <span className="risk-badge__dot" />
      {riskLabel(key)}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' | 'info' }) {
  return <p className={`note note--${tone}`}>{children}</p>;
}

/** Tiny, safe markdown subset for assistant replies: **bold**, _italic_, [link](https://…), "• " bullets. */
export function Markdown({ text }: { text: string }) {
  const inline = (s: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /\*\*(.+?)\*\*|_(.+?)_|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      if (m[1]) out.push(<strong key={`${key}-${i++}`}>{m[1]}</strong>);
      else if (m[2]) out.push(<em key={`${key}-${i++}`}>{m[2]}</em>);
      else
        out.push(
          <a key={`${key}-${i++}`} href={m[4]} target="_blank" rel="noopener noreferrer">
            {m[3]}
          </a>,
        );
      last = re.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  return (
    <>
      {text.split(/\n{2,}/).map((block, bi) => {
        const lines = block.split('\n');
        if (lines.every((l) => l.startsWith('• ')))
          return (
            <ul key={bi}>
              {lines.map((l, li) => (
                <li key={li}>{inline(l.slice(2), `${bi}-${li}`)}</li>
              ))}
            </ul>
          );
        const head = lines.filter((l) => !l.startsWith('• '));
        const items = lines.filter((l) => l.startsWith('• '));
        return (
          <Fragment key={bi}>
            <p>
              {head.map((l, li) => (
                <Fragment key={li}>
                  {li > 0 && <br />}
                  {inline(l, `${bi}-h${li}`)}
                </Fragment>
              ))}
            </p>
            {items.length > 0 && (
              <ul>
                {items.map((l, li) => (
                  <li key={li}>{inline(l.slice(2), `${bi}-i${li}`)}</li>
                ))}
              </ul>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

export function OriginTag({ origin }: { origin: 'api' | 'sample' | 'fallback' | null }) {
  if (origin === 'api' || !origin) return null;
  return <span className={`origin-tag origin-tag--${origin}`}>{origin === 'sample' ? 'Sample' : 'Sample · API offline'}</span>;
}
