import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteProvider } from '../api/remote';
import { ChatDrawer } from '../components/ChatDrawer';
import { ChatSources, safeSourceUrl } from '../components/chat/ChatSources';
import { Markdown } from '../components/ui';
import { chatMode, clearChat, currentChatContext, sendChat } from './chat';
import { getState, setState, validTimeOf } from './store';
import type { ChatResponse, ChatSource, PlaceResult } from '../types';

vi.mock('../config', async () => ({ ...await vi.importActual('../config'), API_BASE: 'http://localhost:8000/api/v1' }));
const NOW = Date.parse('2026-10-17T12:00:00Z');
const initial = getState();
const stockton: PlaceResult = { id: 'place-ca-stockton', name: 'Stockton', type: 'city', county: 'San Joaquin', state: 'CA', center: [-121.2881, 37.9498], bbox: [-121.42, 37.86, -121.18, 38.06] };
const sacramento: PlaceResult = { ...stockton, id: 'place-ca-sacramento', name: 'Sacramento', center: [-121.46, 38.57] };
const source: ChatSource = { id: 'research-1-web-1', kind: 'research', title: 'CAL FIRE source', provider: 'fire.ca.gov', url: 'https://www.fire.ca.gov/incidents', retrieved_at: new Date(NOW).toISOString(), published_at: null };
const result = (answer = 'Verified forecast weather'): ChatResponse => ({ answer, grounding: [], sources: [], limitations: [], model: 'gpt-5-mini' });

beforeEach(() => { clearChat(); vi.useFakeTimers(); vi.setSystemTime(NOW); setState({ ...initial, now: NOW, chatOpen: false, highlight: { place: stockton, boundary: null }, chat: { ...initial.chat, messages: [], pending: false, context: null } }); });
afterEach(() => { clearChat(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('FireWatch backend assistant', () => {
  it('uses the backend even when ML risk uses sample data, preserves location/hour and history', async () => {
    const call = vi.spyOn(RemoteProvider.prototype, 'chat').mockResolvedValue(result());
    expect(chatMode()).toBe('api');
    expect(getState().risk.origin).not.toBe('api');
    await sendChat('Stockton weather');
    expect(call.mock.calls[0][0].location_id).toBe(stockton.id);
    expect(Date.parse(call.mock.calls[0][0].valid_at!)).toBe(validTimeOf(getState()));
    expect(call.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(getState().chat.messages.at(-1)?.mode).toBe('api');
    await sendChat('What about tomorrow?');
    expect(call.mock.calls[1][0].conversation.length).toBe(2);
  });

  it('shows loading, then source metadata and model without exposing hidden reasoning', async () => {
    let resolve!: (value: ChatResponse) => void;
    vi.spyOn(RemoteProvider.prototype, 'chat').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = sendChat('Camp Fire history');
    expect(getState().chat.pending).toBe(true);
    resolve({ ...result(), sources: [source] }); await pending;
    expect(getState().chat.pending).toBe(false);
    expect(getState().chat.messages.at(-1)?.sources).toEqual([source]);
  });

  it('never substitutes offline/sample answers when the configured backend fails, and retries', async () => {
    const call = vi.spyOn(RemoteProvider.prototype, 'chat').mockRejectedValueOnce(new Error('Set OPENAI_API_KEY')).mockResolvedValueOnce(result('Recovered'));
    await sendChat('Stockton weather');
    const failed = getState().chat.messages.at(-1)!;
    expect(failed.mode).toBe('error'); expect(failed.content).toContain('OPENAI_API_KEY');
    expect(failed.retry_text).toBe('Stockton weather');
    expect(getState().chat.messages.every(message => message.mode !== 'offline')).toBe(true);
    await sendChat(failed.retry_text!);
    expect(call).toHaveBeenCalledTimes(2); expect(getState().chat.messages.at(-1)?.content).toBe('Recovered');
  });

  it('cancels on Sacramento selection and rejects a late Stockton response', async () => {
    let resolve!: (value: ChatResponse) => void;
    const call = vi.spyOn(RemoteProvider.prototype, 'chat').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = sendChat('Stockton weather');
    setState({ highlight: { place: sacramento, boundary: null } });
    expect(call.mock.calls[0][1]?.aborted).toBe(true);
    resolve(result('Late Stockton response')); await pending;
    expect(getState().chat.messages.some(message => message.content === 'Late Stockton response')).toBe(false);
    expect(getState().chat.pending).toBe(false);
    expect(currentChatContext()?.placeId).toBe(sacramento.id);
  });

  it('clearing a pending conversation prevents a late answer from restoring it', async () => {
    let resolve!: (value: ChatResponse) => void;
    vi.spyOn(RemoteProvider.prototype, 'chat').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = sendChat('Wildfire risk'); clearChat(); resolve(result('Late')); await pending;
    expect(getState().chat.messages).toEqual([]);
  });

  it('cancels requests when the selected forecast hour changes', async () => {
    let resolve!: (value: ChatResponse) => void;
    vi.spyOn(RemoteProvider.prototype, 'chat').mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = sendChat('Wind forecast'); setState({ isLive: false, timeIndex: 1 });
    resolve(result('Old hour')); await pending;
    expect(getState().chat.messages.some(message => message.content === 'Old hour')).toBe(false);
  });

  it('retains an explicitly named chat location until the map selection changes', async () => {
    const call = vi.spyOn(RemoteProvider.prototype, 'chat').mockResolvedValue({ ...result(), location: sacramento });
    await sendChat('Weather in Sacramento'); await sendChat('What about tomorrow?');
    expect(call.mock.calls[1][0].location_id).toBe(sacramento.id);
    setState({ highlight: { place: sacramento, boundary: null } });
    setState({ highlight: { place: stockton, boundary: null } });
    expect(currentChatContext()?.placeId).toBe(stockton.id);
  });

  it('renders launcher, open panel, suggestions, accessible composer, error and retry', () => {
    // Zustand's SSR snapshot intentionally stays at initial state; render each
    // explicit test state here. Real subscription behavior is exercised in Chrome.
    vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
    expect(renderToStaticMarkup(createElement(ChatDrawer))).toContain('Ask FireWatch AI');
    setState(s => ({ chatOpen: true, chat: { ...s.chat, messages: [{ id: 'error', role: 'assistant', content: 'Backend unavailable', mode: 'error', retry_text: 'Weather', at: NOW }] } }));
    const html = renderToStaticMarkup(createElement(ChatDrawer));
    expect(html).toContain('FireWatch AI assistant'); expect(html).toContain('Message FireWatch AI');
    expect(html).toContain('Close assistant'); expect(html).toContain('Retry message');
    expect(html).toContain('Stockton'); expect(html).toContain('Backend unavailable');
  });

  it('renders verified research sources with timestamps and prevents dangerous links/HTML', () => {
    const html = renderToStaticMarkup(createElement(ChatSources, { sources: [source] }));
    expect(html).toContain('External research'); expect(html).toContain('https://www.fire.ca.gov/incidents');
    expect(html).toContain('Published: unknown'); expect(html).toContain('Retrieved:');
    expect(safeSourceUrl({ ...source, url: 'javascript:alert(1)' })).toBeNull();
    expect(safeSourceUrl({ ...source, url: 'https://ca.gov.attacker.test' })).toBeNull();
    const unsafe = renderToStaticMarkup(createElement(Markdown, { text: '<script>alert(1)</script> [invented](https://example.com/fake)', allowedLinks: [] }));
    expect(unsafe).not.toContain('<script>'); expect(unsafe).not.toContain('href=');
    expect(unsafe).toContain('&lt;script&gt;');
  });

  it('uses canonical chat API schema, carries history and parses source metadata', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ...result(), sources: [source] }));
    });
    const response = await new RemoteProvider('http://localhost:8000/api/v1').chat({ message: 'Weather tomorrow', location_id: stockton.id, valid_at: new Date(NOW).toISOString(), conversation: [{ role: 'user', content: 'Weather today' }] });
    expect(body.location_id).toBe(stockton.id); expect(body.selected_hour).toBe(new Date(NOW).toISOString());
    expect(body.history).toHaveLength(1); expect(response.sources?.[0].url).toBe(source.url);
  });

  it('bounds stored messages and history before sending long responses', async () => {
    vi.spyOn(RemoteProvider.prototype, 'chat').mockResolvedValue(result('x'.repeat(12000)));
    await sendChat('Wildfire science');
    await sendChat('Wildfire history');
    const call = vi.mocked(RemoteProvider.prototype.chat);
    expect(call.mock.calls[1][0].conversation.every(message => message.content.length <= 1800)).toBe(true);
    expect(getState().chat.messages.length).toBeLessThanOrEqual(40);
  });
});
