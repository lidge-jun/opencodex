import { afterEach, beforeEach, expect, test } from 'bun:test';
import { handleResponses } from '../../src/server/responses';
import { createRequestExecutionBudget, type SingleUseDispatchPermit } from '../../src/lib/request-execution-budget';
import { acquireOwnedSpendHome } from '../helpers/owned-spend-home';
import { codexWsPool } from '../../src/server/responses/codex-ws-pool';
import { setCodexWsIncrementalUpload } from '../../src/server/responses/codex-ws-incremental';
import { setCodexWsReuseAcrossTurns } from '../../src/config/codex-ws-reuse-setting';
import type { OcxConfig } from '../../src/types';

const original = globalThis.WebSocket;
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const message = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture answer' }] };
const missing = { type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'fixture cache miss' } };
const config = { port: 0, defaultProvider: 'openai', providers: { openai: {
  adapter: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', authMode: 'forward', codexAccountMode: 'direct',
} } } as OcxConfig;
let saved: Record<string, string | undefined>;
let release: () => void;
class Socket extends EventTarget {
  static all: Socket[] = [];
  readyState = 0;
  frames: Record<string, any>[] = [];
  constructor(..._args: any[]) {
    super(); Socket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  emit(payload: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })); }
  send(text: string) {
    const frame = JSON.parse(text); this.frames.push(frame);
    queueMicrotask(() => {
      if (frame.previous_response_id) { this.emit(missing); return; }
      const id = `fixture-response-${this.frames.length}`;
      this.emit({ type: 'response.created', response: { id } });
      this.emit({ type: 'response.completed', response: { id, status: 'completed', output: [answer] } });
    });
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  ref() {}
  unref() {}
}
beforeEach(() => {
  release = acquireOwnedSpendHome();
  saved = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  Socket.all = []; globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  setCodexWsIncrementalUpload(true); setCodexWsReuseAcrossTurns(true);
});
afterEach(() => {
  codexWsPool.dispose(); setCodexWsIncrementalUpload(false); setCodexWsReuseAcrossTurns(false);
  globalThis.WebSocket = original;
  for (const key of proxyKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  release();
});
function budget(cap: number, enforced: boolean) {
  return createRequestExecutionBudget({ maxTotalModelSends: cap, baseSendAllowance: cap,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, undefined,
  enforced ? { enforced: true, charge: () => true, refund: () => {}, ensureSeed: () => ({}),
    beginReporter: () => ({ start: () => {}, rebindTarget: () => true, report: () => {}, close: () => {} }) } : undefined);
}
async function run(input: unknown[], sendBudget: ReturnType<typeof budget>, initialPermit?: SingleUseDispatchPermit, runConfig = config) {
  const req = new Request('http://localhost/v1/responses', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture-account', 'thread-id': 'fixture-thread' },
    body: JSON.stringify({ model: 'fixture', input, stream: true, store: false,
      client_metadata: { thread_id: 'fixture-thread', turn_id: 'fixture-turn' } }) });
  return handleResponses(req, runConfig, { model: '', provider: '' }, { codexWsRuntimeIdentity: '1.4.4', sendBudget,
    ...(initialPermit ? { comboInitialSend: { permit: initialPermit } } : {}),
    admission: { kind: 'loopback', source: 'loopback' } });
}
for (const enforced of [false, true]) for (const prepaid of [false, true]) {
  for (const cap of [2, 3]) for (const failure of ['503', 'reset'] as const) {
    test(`providerFetch bounds failed HTTP recovery (cap=${cap}, failure=${failure}, enforced=${enforced}, prepaid=${prepaid})`, async () => {
      const initial = [message('a'.repeat(8 * 1024 * 1024))];
      expect(await (await run(initial, budget(1, enforced))).text()).toContain('response.completed');
      const shared = budget(cap, enforced);
      const booking = prepaid ? shared.reserveDispatch({ sendClass: 'initial', targetKey: 'fixture-target', countedExternally: true }) : undefined;
      if (booking && !booking.allowed) throw new Error('fixture initial reservation refused');
      const permit = booking?.allowed ? booking.permit : undefined;
      let httpSends = 0;
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = Object.assign(async () => {
        httpSends++;
        if (failure === 'reset') throw Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' });
        return new Response('fixture transient', { status: 503 });
      }, { preconnect: fetchBefore.preconnect }) as typeof fetch;
      try {
        const runConfig = { ...config, providers: { openai: { ...config.providers.openai!, retryOnReset: {} } } };
        const response = await run([...initial, answer, message('b'.repeat(8 * 1024 * 1024))], shared, permit, runConfig);
        const body = await response.text();
        expect(httpSends).toBe(cap - 1);
        expect(Socket.all.flatMap(socket => socket.frames)).toHaveLength(2);
        expect(shared.used).toBe(cap);
        if (enforced) expect(shared.physicalStarted).toBe(cap);
        expect(response.status).toBe(failure === '503' ? 503 : 429);
        expect(body).toContain(failure === '503' ? 'fixture transient' : 'upstream_reset_replay_refused');
        permit?.release();
        expect(shared.used).toBe(cap);
      } finally { globalThis.fetch = fetchBefore; permit?.release(); }
    });
  }
}
for (const enforced of [false, true]) for (const failure of ['503', 'reset'] as const) {
  test(`providerFetch keeps ordinary HTTP retries at two sends (failure=${failure}, enforced=${enforced})`, async () => {
    setCodexWsIncrementalUpload(false);
    let httpSends = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => {
      httpSends++;
      if (failure === 'reset') throw Object.assign(new Error('fixture reset'), { code: 'ECONNRESET' });
      return new Response('fixture transient', { status: 503 });
    }, { preconnect: fetchBefore.preconnect }) as typeof fetch;
    try {
      const shared = budget(2, enforced);
      const runConfig = { ...config, providers: { openai: { ...config.providers.openai!, retryOnReset: {} } } };
      const response = await run([message('a'.repeat(17 * 1024 * 1024))], shared, undefined, runConfig);
      const body = await response.text();
      expect(httpSends).toBe(2);
      expect(Socket.all).toHaveLength(0);
      expect(shared.used).toBe(2);
      if (enforced) expect(shared.physicalStarted).toBe(2);
      expect(response.status).toBe(failure === '503' ? 503 : 429);
      expect(body).toContain(failure === '503' ? 'fixture transient' : 'upstream_reset_replay_refused');
    } finally { globalThis.fetch = fetchBefore; }
  });
}
for (const enforced of [false, true]) {
  for (const cap of [1, 2]) test(`providerFetch retains a combo's prepaid budget during recovery (cap=${cap}, enforced=${enforced})`, async () => {
    const initial = [message('fixture prefix '.repeat(100))];
    await (await run(initial, budget(1, enforced))).text();
    const shared = budget(cap, enforced);
    const booking = shared.reserveDispatch({ sendClass: 'initial', targetKey: 'fixture-target', countedExternally: true });
    expect(booking.allowed).toBe(true);
    if (!booking.allowed) throw new Error('fixture initial reservation refused');
    const response = await run([...initial, answer, message('next')], shared, booking.permit);
    const body = await response.text();
    expect(response.status).toBe(cap === 1 ? 400 : 200);
    expect(body).toContain(cap === 1 ? 'previous_response_not_found' : 'response.completed');
    expect(Socket.all[0]!.frames).toHaveLength(cap + 1);
    expect(shared.used).toBe(cap);
    if (enforced) expect(shared.physicalStarted).toBe(cap);
    booking.permit.release();
    expect(shared.used).toBe(cap);
  });
  test(`providerFetch refuses a cache-miss resend at one send (enforced=${enforced})`, async () => {
    const initial = [message('fixture prefix '.repeat(100))];
    expect(await (await run(initial, budget(1, enforced))).text()).toContain('response.completed');
    const shared = budget(1, enforced);
    const response = await run([...initial, answer, message('next')], shared);
    const body = await response.text();
    expect(Socket.all[0]!.frames).toHaveLength(2);
    expect(response.status).toBe(400);
    expect(body).toContain('previous_response_not_found');
    expect(shared.used).toBe(1);
    if (enforced) expect(shared.physicalStarted).toBe(1);
  });
  test(`providerFetch charges both delta and full recovery exactly once (enforced=${enforced})`, async () => {
    const initial = [message('fixture prefix '.repeat(100))];
    await (await run(initial, budget(1, enforced))).text();
    const shared = budget(2, enforced);
    const input = [...initial, answer, message('next')];
    const response = await run(input, shared);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('response.completed');
    expect(Socket.all[0]!.frames).toHaveLength(3);
    expect(Socket.all[0]!.frames[2]!.input).toEqual(input);
    expect(shared.used).toBe(2);
    if (enforced) expect(shared.physicalStarted).toBe(2);
  });
  test(`providerFetch refuses oversized HTTP recovery at one send (enforced=${enforced})`, async () => {
    const initial = [message('a'.repeat(8 * 1024 * 1024))];
    await (await run(initial, budget(1, enforced))).text();
    let httpSends = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => { httpSends++; return new Response('unexpected recovery'); }, { preconnect: fetchBefore.preconnect }) as typeof fetch;
    try {
      const shared = budget(1, enforced);
      const response = await run([...initial, answer, message('b'.repeat(8 * 1024 * 1024))], shared);
      const body = await response.text();
      expect(httpSends).toBe(0);
      expect(response.status).toBe(400);
      expect(body).toContain('previous_response_not_found');
      expect(Socket.all[0]!.frames).toHaveLength(2);
      expect(shared.used).toBe(1);
      if (enforced) expect(shared.physicalStarted).toBe(1);
    } finally { globalThis.fetch = fetchBefore; }
  });
  test(`providerFetch charges oversized HTTP recovery exactly once (enforced=${enforced})`, async () => {
    const initial = [message('a'.repeat(8 * 1024 * 1024))];
    await (await run(initial, budget(1, enforced))).text();
    let httpSends = 0;
    const fetchBefore = globalThis.fetch;
    const input = [...initial, answer, message('b'.repeat(8 * 1024 * 1024))];
    globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
      httpSends++;
      const body = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array));
      expect(body.input).toEqual(input);
      expect(body.previous_response_id).toBeUndefined();
      return new Response('full HTTP recovery', { headers: { 'content-type': 'text/event-stream' } });
    }, { preconnect: fetchBefore.preconnect }) as typeof fetch;
    try {
      const shared = budget(2, enforced);
      const response = await run(input, shared);
      expect(await response.text()).toContain('full HTTP recovery');
      expect(httpSends).toBe(1);
      expect(Socket.all[0]!.frames).toHaveLength(2);
      expect(shared.used).toBe(2);
      if (enforced) expect(shared.physicalStarted).toBe(2);
    } finally { globalThis.fetch = fetchBefore; }
  });
}
