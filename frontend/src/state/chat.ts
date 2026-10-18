import { CHAT_MAX_CHARS, CHAT_MAX_TURNS_SENT } from '../config';
import { answerOffline } from '../lib/assistant';
import { placeTitle } from '../lib/search';
import { formatStamp, toIso } from '../lib/time';
import type { ChatRequest } from '../types';
import { remote } from './data';
import { getState, setState, useStore, validTimeOf, type ChatContext, type ChatMessage } from './store';

let seq = 0;
let requestNumber = 0;
let active: AbortController | null = null;
const msg = (m: Omit<ChatMessage, 'id' | 'at'>): ChatMessage => ({ ...m, context_key: m.context_key ?? selectionKey(), id: `m${++seq}`, at: Date.now() });

/** Backend AI does not depend on operational ML predictions. */
export const chatMode = (): 'api' | 'offline' => remote ? 'api' : 'offline';
export function currentChatContext(): ChatContext | null {
  const s = getState();
  const place = s.highlight?.place;
  const context = s.chat.context ?? (place ? { label: placeTitle(place), placeId: place.id, lngLat: place.center } : null);
  return context ? { ...context, label: `${context.label.split(' · ')[0]} · ${formatStamp(validTimeOf(s))}` } : null;
}
const selectionKey = () => `${getState().highlight?.place.id ?? ''}|${validTimeOf(getState())}`;

export function cancelChat(reason?: string) {
  ++requestNumber;
  active?.abort();
  active = null;
  setState(s => ({ chat: { ...s.chat, pending: false,
    messages: reason && s.chat.pending ? [...s.chat.messages, msg({ role: 'assistant', content: reason, mode: 'error' })] : s.chat.messages } }));
}

// Follow the single map selection/timeline; a stale request cannot acquire new context.
useStore.subscribe(s => `${s.highlight?.place.id ?? ''}|${validTimeOf(s)}`, (_key, previous) => {
  const s = getState();
  if (s.chat.pending) cancelChat('Location or forecast hour changed. Ask again using the current context.');
  if (previous.split('|')[0] !== (s.highlight?.place.id ?? '')) {
    const p = s.highlight?.place;
    setState(st => ({ chat: { ...st.chat, context: p ? { label: placeTitle(p), placeId: p.id, lngLat: p.center } : null } }));
  }
});

export async function sendChat(text: string) {
  const message = text.trim().slice(0, CHAT_MAX_CHARS);
  if (!message || getState().chat.pending) return;
  const s = getState(), context = currentChatContext(), hour = validTimeOf(s), key = selectionKey();
  const token = ++requestNumber;
  active?.abort();
  const ctrl = new AbortController(); active = ctrl;
  const history = s.chat.messages.filter(m => m.mode !== 'error' && m.context_key === key).slice(-CHAT_MAX_TURNS_SENT)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1800) }));
  const label = context?.label ?? `California · ${formatStamp(hour)}`;
  setState(st => ({ chat: { ...st.chat, pending: true, messages: [...st.chat.messages.slice(-39), msg({ role: 'user', content: message, context_label: label })] } }));
  const current = () => token === requestNumber && key === selectionKey() && !ctrl.signal.aborted;
  const push = (m: ChatMessage) => {
    if (current()) setState(st => ({ chat: { ...st.chat, pending: false, messages: [...st.chat.messages, m].slice(-40) } }));
  };
  if (remote) {
    const req: ChatRequest = { message, location_id: context?.placeId ?? null, cell_id: context?.cellId ?? null,
      valid_at: toIso(hour), conversation: history };
    try {
      const res = await remote.chat(req, ctrl.signal);
      if (!current()) return;
      if (res.location?.id) setState(st => ({ chat: { ...st.chat, context: {
        label: res.location!.name, placeId: res.location!.id, lngLat: res.location!.center,
      } } }));
      push(msg({ role: 'assistant', content: res.answer, grounding: res.grounding, sources: res.sources,
        limitations: res.limitations, suggested_questions: res.suggested_questions, model: res.model,
        context_label: res.location ? `${res.location.name} · ${res.requested_time ? formatStamp(Date.parse(res.requested_time)) : formatStamp(hour)}` : label, mode: 'api' }));
    } catch (error) {
      push(msg({ role: 'assistant', content: `The backend AI service is unavailable. ${error instanceof Error ? error.message : 'Please retry.'}`,
        retry_text: message, context_label: label, mode: 'error' }));
    }
    return;
  }
  try {
    const res = await answerOffline(message, s, context, hour);
    push(msg({ role: 'assistant', content: `Demo/offline summary — online research is unavailable.\n\n${res.answer}`,
      grounding: res.grounding, context_label: label, mode: 'offline' }));
  } catch {
    push(msg({ role: 'assistant', content: 'The offline assistant could not answer from the loaded sample data.', mode: 'error', retry_text: message }));
  }
}

export const clearChat = () => { cancelChat(); setState(s => ({ chat: { ...s.chat, messages: [] } })); };
export const clearChatContext = () => { cancelChat(); setState(s => ({ chat: { ...s.chat, context: null } })); };
