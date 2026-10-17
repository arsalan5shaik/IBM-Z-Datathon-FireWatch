import { useEffect, useRef, useState } from 'react';
import { MapPin, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { CHAT_MAX_CHARS, OFFICIAL_LINKS } from '../config';
import { contextFor } from '../state/actions';
import { chatMode, clearChat, clearChatContext, sendChat } from '../state/chat';
import { setState, useStore } from '../state/store';
import { formatStamp, parseTime } from '../lib/time';
import { Markdown } from './ui';

const DATASET_LABEL: Record<string, string> = { risk: 'Risk forecast', weather: 'Weather', fires: 'Satellite hotspots', incidents: 'Incidents' };

function suggestions(hasContext: boolean): string[] {
  return hasContext
    ? ['Why is the risk here what it is?', 'When is the peak risk this week?', 'How is wind affecting this area?', 'Are there active fires nearby?']
    : ['Where is the highest risk right now?', 'What live fires are burning in California?', 'Why is Stockton high risk on Day 4?', 'How does the forecast model work?'];
}

export function ChatButton() {
  const open = useStore((s) => s.chatOpen);
  if (open) return null;
  return (
    <button type="button" className="ai-fab" onClick={() => setState((s) => ({ chatOpen: true, chat: { ...s.chat, context: s.chat.context ?? contextFor(s.selection) } }))}>
      <Sparkles size={17} /> <span>Ask FireWatch AI</span>
    </button>
  );
}

export function ChatDrawer() {
  const open = useStore((s) => s.chatOpen);
  const chat = useStore((s) => s.chat);
  const selection = useStore((s) => s.selection);
  const riskOrigin = useStore((s) => s.risk.origin);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mode = riskOrigin ? chatMode() : 'offline';

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 50);
  }, [open]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [chat.messages.length, chat.pending]);

  if (!open) return <ChatButton />;

  const ctxFromSelection = contextFor(selection);
  const showUseSelection = ctxFromSelection && ctxFromSelection.label !== chat.context?.label;
  const submit = (q?: string) => {
    const value = (q ?? text).trim();
    if (!value) return;
    setText('');
    void sendChat(value);
  };

  return (
    <section className="chat" role="dialog" aria-modal="false" aria-label="FireWatch AI assistant">
      <header className="chat__head">
        <span className="chat__logo">
          <Sparkles size={16} />
        </span>
        <div className="chat__titles">
          <h2>FireWatch AI</h2>
          <span className={`chat__mode chat__mode--${mode}`}>{mode === 'api' ? 'Answers from FireWatch data' : 'Offline assistant · uses loaded data'}</span>
        </div>
        {chat.messages.length > 0 && (
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Start a new conversation" title="New conversation" onClick={clearChat}>
            <RotateCcw size={16} />
          </button>
        )}
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Close assistant" onClick={() => setState({ chatOpen: false })}>
          <X size={17} />
        </button>
      </header>

      <div className="chat__context">
        {chat.context ? (
          <span className="chip">
            <MapPin size={13} /> {chat.context.label}
            <button type="button" aria-label="Remove location context" onClick={clearChatContext}>
              <X size={12} />
            </button>
          </span>
        ) : (
          <span className="chat__context-empty">No place selected — ask about California, or name a place.</span>
        )}
        {showUseSelection && (
          <button type="button" className="chip chip--ghost" onClick={() => setState((s) => ({ chat: { ...s.chat, context: ctxFromSelection } }))}>
            Use selection: {ctxFromSelection.label}
          </button>
        )}
      </div>

      <div className="chat__list" ref={list} aria-live="polite">
        {chat.messages.length === 0 && (
          <div className="chat__intro">
            <p>Ask about live fires, the hourly 7-day risk forecast, wind, or why the model scores an area the way it does. Answers use FireWatch’s data only.</p>
          </div>
        )}
        {chat.messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}${m.mode === 'error' ? ' msg--error' : ''}`}>
            <div className="msg__bubble">{m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}</div>
            {m.grounding && m.grounding.length > 0 && (
              <div className="msg__sources">
                Sources:{' '}
                {m.grounding
                  .map((g) => {
                    const at = parseTime(g.as_of);
                    return `${DATASET_LABEL[g.dataset] ?? g.dataset}${at ? ` (${formatStamp(at)})` : ''}`;
                  })
                  .join(' · ')}
              </div>
            )}
          </div>
        ))}
        {chat.pending && (
          <div className="msg msg--assistant">
            <div className="msg__bubble msg__typing" aria-label="Assistant is typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {!chat.pending && chat.messages.length < 2 && (
        <div className="chat__suggest">
          {suggestions(!!chat.context).map((q) => (
            <button key={q} type="button" onClick={() => submit(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          value={text}
          maxLength={CHAT_MAX_CHARS}
          placeholder={chat.context ? `Ask about ${chat.context.label.split(' · ')[0]}…` : 'Ask about fires, risk, wind…'}
          aria-label="Message FireWatch AI"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" className="chat__send" aria-label="Send" disabled={!text.trim() || chat.pending}>
          <Send size={16} />
        </button>
      </form>
      {text.length > CHAT_MAX_CHARS - 80 && (
        <div className="chat__count">
          {text.length}/{CHAT_MAX_CHARS}
        </div>
      )}
      <footer className="chat__foot">
        Not for emergency decisions. In danger, call 911 ·{' '}
        <a href={OFFICIAL_LINKS[0].href} target="_blank" rel="noopener noreferrer">
          {OFFICIAL_LINKS[0].label}
        </a>
      </footer>
    </section>
  );
}
