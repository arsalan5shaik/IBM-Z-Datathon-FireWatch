import { CHAT_MAX_CHARS, CHAT_MAX_TURNS_SENT } from '../config';
import { answerOffline } from '../lib/assistant';
import { toIso } from '../lib/time';
import type { ChatRequest } from '../types';
import { remote } from './data';
import { getState, setState, validTimeOf, type ChatMessage } from './store';

let seq = 0;
const msg = (m: Omit<ChatMessage, 'id' | 'at'>): ChatMessage => ({ ...m, id: `m${++seq}`, at: Date.now() });

/** Whether answers come from the backend LLM or the built-in offline assistant. */
export const chatMode = (): 'api' | 'offline' => (remote && getState().risk.origin === 'api' ? 'api' : 'offline');

export async function sendChat(text: string) {
  const message = text.trim().slice(0, CHAT_MAX_CHARS);
  if (!message || getState().chat.pending) return;
  const s = getState();
  const ctx = s.chat.context;
  const validAt = validTimeOf(s);
  const history = s.chat.messages.filter((m) => m.mode !== 'error').slice(-CHAT_MAX_TURNS_SENT).map((m) => ({ role: m.role, content: m.content }));
  setState((st) => ({ chat: { ...st.chat, pending: true, messages: [...st.chat.messages, msg({ role: 'user', content: message })] } }));

  const push = (m: ChatMessage) => setState((st) => ({ chat: { ...st.chat, pending: false, messages: [...st.chat.messages, m] } }));

  if (chatMode() === 'api' && remote) {
    const req: ChatRequest = {
      message,
      location_id: ctx?.placeId ?? null,
      cell_id: ctx?.cellId ?? null,
      detection_id: ctx?.detectionId ?? null,
      incident_id: ctx?.incidentId ?? null,
      valid_at: toIso(validAt),
      conversation: history,
    };
    try {
      const res = await remote.chat(req);
      push(msg({ role: 'assistant', content: res.answer, grounding: res.grounding, mode: 'api' }));
      return;
    } catch {
      // Fall through to the offline assistant so the user still gets a grounded answer.
      try {
        const res = await answerOffline(message, getState(), ctx, validAt);
        push(
          msg({
            role: 'assistant',
            content: `_The FireWatch AI service is unavailable, so here is an offline summary of the loaded data._\n\n${res.answer}`,
            grounding: res.grounding,
            mode: 'offline',
          }),
        );
      } catch {
        push(msg({ role: 'assistant', content: 'The AI assistant is unavailable right now. The map and forecast still work.', mode: 'error' }));
      }
      return;
    }
  }

  try {
    // Small delay so the typing indicator is perceptible and the UI feels consistent with the API path.
    const [res] = await Promise.all([answerOffline(message, getState(), ctx, validAt), new Promise((r) => setTimeout(r, 350))]);
    push(msg({ role: 'assistant', content: res.answer, grounding: res.grounding, mode: 'offline' }));
  } catch {
    push(msg({ role: 'assistant', content: 'Sorry — I couldn’t answer that from the loaded data.', mode: 'error' }));
  }
}

export const clearChat = () => setState((s) => ({ chat: { ...s.chat, messages: [] } }));
export const clearChatContext = () => setState((s) => ({ chat: { ...s.chat, context: null } }));
