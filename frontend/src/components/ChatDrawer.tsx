import { useEffect, useRef, useState } from 'react';
import { MapPin, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { CHAT_MAX_CHARS, OFFICIAL_LINKS } from '../config';
import { contextFor } from '../state/actions';
import { chatMode, clearChat, clearChatContext, currentChatContext, sendChat } from '../state/chat';
import { setState, useStore, validTimeOf } from '../state/store';
import { formatStamp, parseTime } from '../lib/time';
import { Markdown, usePresence } from './ui';
import { ChatSources, safeSourceUrl } from './chat/ChatSources';

const DATASET_LABEL: Record<string, string> = { risk: 'Risk forecast', weather: 'Weather', fires: 'Satellite hotspots', incidents: 'Incidents' };

function suggestions(hasContext: boolean): string[] {
  return hasContext
    ? ['What is the weather tomorrow?', 'How strong will the winds be tomorrow?', 'Are wildfire predictions and explanations available?', 'Show recent cached satellite detections in this area.']
    : ['What are the California fire weather warnings?', 'What caused the Camp Fire?', 'How does FireWatch predict wildfire risk?', 'What wildfire data is available?'];
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
  const place = useStore((s) => s.highlight?.place);
  useStore(validTimeOf);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mode = chatMode();
  const context = currentChatContext();
  const presence = usePresence(open || null);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 50);
  }, [open]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [chat.messages.length, chat.pending]);

  if (!open && !presence.closing) return <ChatButton />;

  const ctxFromSelection = contextFor(selection);
  const showUseSelection = ctxFromSelection && ['placeId', 'cellId', 'detectionId', 'incidentId', 'groupId'].some(key =>
    ctxFromSelection[key as keyof typeof ctxFromSelection] !== context?.[key as keyof typeof ctxFromSelection]);
  const submit = (q?: string) => {
    const value = (q ?? text).trim();
    if (!value) return;
    setText('');
    void sendChat(value);
  };

  return (
    <section className={`chat${presence.closing ? ' is-closing' : ''}`} role="dialog" aria-modal="false" aria-label="FireWatch AI assistant">
      <header className="chat__head">
        <span className="chat__logo">
          <Sparkles size={16} />
        </span>
        <div className="chat__titles">
          <h2>FireWatch AI</h2>
          <span className={`chat__mode chat__mode--${mode}`}>{mode === 'api' ? 'Backend assistant · FireWatch + sourced research' : 'Demo/offline assistant · no online research'}</span>
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
        {context ? (
          <span className="chip">
            <MapPin size={13} /> {context.label}
            {!place && <button type="button" aria-label="Remove location context" onClick={clearChatContext}>
              <X size={12} />
            </button>}
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
            <p>Ask about California wildfire activity, fire weather, risk or wildfire history. Available FireWatch data comes first; online answers require a configured backend and verified sources.</p>
          </div>
        )}
        {chat.messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}${m.mode === 'error' ? ' msg--error' : ''}`}>
            {m.context_label && <div className="msg__context">{m.context_label}</div>}
            <div className="msg__bubble">{m.role === 'assistant' ? <Markdown text={m.content} allowedLinks={(m.sources ?? []).map(safeSourceUrl).filter((url): url is string => !!url)} /> : m.content}</div>
            {m.model && <div className="msg__context">Model: {m.model}</div>}
            {m.sources?.length ? <ChatSources sources={m.sources} /> : null}
            {m.limitations?.length ? <ul className="msg__limitations">{m.limitations.map((value, i) => <li key={i}>{value}</li>)}</ul> : null}
            {m.retry_text && <button type="button" className="chip chip--ghost" disabled={chat.pending} onClick={() => void sendChat(m.retry_text!)}>Retry message</button>}
            {!m.sources?.length && m.grounding && m.grounding.length > 0 && (
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

      {!chat.pending && (chat.messages.length < 2 || !!chat.messages.at(-1)?.suggested_questions?.length) && (
        <div className="chat__suggest">
          {(chat.messages.at(-1)?.suggested_questions?.length ? chat.messages.at(-1)!.suggested_questions! : suggestions(!!context)).map((q) => (
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
          placeholder={context ? `Ask about ${context.label.split(' · ')[0]}…` : 'Ask about fires, risk, wind…'}
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
