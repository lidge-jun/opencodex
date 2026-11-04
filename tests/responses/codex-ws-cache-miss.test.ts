import { afterEach, beforeEach, expect, test } from 'bun:test';
import { codexWsUpstreamFetch } from '../../src/server/responses/ws-upstream';
import { codexWsPool } from '../../src/server/responses/codex-ws-pool';
import { setCodexWsIncrementalUpload } from '../../src/server/responses/codex-ws-incremental';
import { setCodexWsReuseAcrossTurns } from '../../src/config/codex-ws-reuse-setting';

const url = 'https://chatgpt.com/backend-api/codex/responses';
const message = (role: string, text: string) => ({ role, content: text });
const initial = [message('user', 'retained private history '.repeat(100))];
const answer = message('assistant', 'answer');
const follow = [...initial, answer, message('user', 'next')];
const missing = { type: 'error', error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'expired' } };
const original = globalThis.WebSocket;
const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
let saved: Record<string, string | undefined>;
let respond: (socket: Socket, frame: any) => void;
class Socket extends EventTarget {
  static all: Socket[] = [];
  readyState = 0;
  frames: any[] = [];
  constructor(..._args: any[]) {
    super(); Socket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  emit(payload: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })); }
  complete() {
    const id = `response-${Socket.all.indexOf(this)}-${this.frames.length}`;
    this.emit({ type: 'response.created', response: { id } });
    this.emit({ type: 'response.completed', response: { id, status: 'completed', output: [answer] } });
  }
  send(text: string) {
    const frame = JSON.parse(text); this.frames.push(frame);
    queueMicrotask(() => respond(this, frame));
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  ref() {}
  unref() {}
}
beforeEach(() => {
  saved = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  Socket.all = [];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  setCodexWsIncrementalUpload(true); setCodexWsReuseAcrossTurns(true);
  respond = (socket, frame) => frame.previous_response_id ? socket.emit(missing) : socket.complete();
});
afterEach(() => {
  codexWsPool.dispose(); setCodexWsIncrementalUpload(false); setCodexWsReuseAcrossTurns(false);
  globalThis.WebSocket = original;
  for (const key of proxyKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});
const fallback = (async () => { throw new Error('unexpected HTTP fallback'); }) as typeof fetch;
function run(input = follow, caller = 'principal:alice', extra: Record<string, unknown> = {},
  dispatch?: () => void, signal?: AbortSignal, http = fallback, guard?: () => void, pace?: () => Promise<void>) {
  return codexWsUpstreamFetch(url, { method: 'POST', signal,
    headers: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture', 'thread-id': 'thread' },
    body: JSON.stringify({ model: 'fixture-model', stream: true, store: false,
      client_metadata: { thread_id: 'thread', turn_id: 'turn' }, input, ...extra }) },
  http, '1.4.4', undefined, guard, undefined, pace, dispatch, undefined, undefined, caller);
}
async function seed(input = initial) { expect(await (await run(input)).text()).toContain('response.completed'); }

test('a proxy delta cache miss resends the exact full create once and seeds its completed history', async () => {
  await seed(); let dispatches = 0; let guards = 0;
  const response = await run(follow, 'principal:alice', {}, () => dispatches++, undefined, fallback, () => guards++);
  expect(await response.text()).toContain('response.completed');
  expect(Socket.all).toHaveLength(1);
  const frames = Socket.all[0]!.frames;
  expect(frames).toHaveLength(3);
  expect(frames[1].input).toEqual([follow[2]]);
  expect(frames[1].previous_response_id).toBe('response-0-1');
  expect(frames[2]).toEqual({ ...frames[0], input: follow });
  expect(dispatches).toBe(2); expect(guards).toBe(3);
  await (await run([...follow, answer, message('user', 'third')])).text();
  expect(frames[3].previous_response_id).toBe('response-0-3');
});

test('a caller-supplied previous_response_id is surfaced without replay', async () => {
  const text = await (await run([message('user', 'explicit')], 'principal:alice', { previous_response_id: 'caller-owned' })).text();
  expect(text).toContain('previous_response_not_found');
  expect(Socket.all.flatMap(socket => socket.frames)).toHaveLength(1);
});

test('recovery never loops when the full create is also refused', async () => {
  await seed(); respond = socket => socket.emit(missing);
  expect(await (await run()).text()).toContain('previous_response_not_found');
  expect(Socket.all[0]!.frames).toHaveLength(3);
});

for (const wrapper of [{ status: '400' }, { status: 400, status_code: 400 }, { status: null }, { status: 500 }]) {
  test(`an invalid or non-refusal status cannot authorize recovery: ${JSON.stringify(wrapper)}`, async () => {
    await seed(); respond = socket => socket.emit({ ...missing, ...wrapper });
    await (await run()).text();
    expect(Socket.all[0]!.frames).toHaveLength(2);
  });
}

test('a wrapped 400 cache miss recovers without projecting the intermediate refusal', async () => {
  await seed(); respond = (socket, frame) => frame.previous_response_id
    ? socket.emit({ ...missing, status: 400 }) : socket.complete();
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('response.completed');
  expect(Socket.all[0]!.frames).toHaveLength(3);
});

test('client cancellation after a delta send cannot authorize recovery', async () => {
  await seed(); const controller = new AbortController();
  respond = socket => { controller.abort(); socket.emit(missing); };
  await expect(run(follow, 'principal:alice', {}, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(Socket.all[0]!.frames).toHaveLength(2);
});

test('an unknown delivery close cannot resend a delta', async () => {
  await seed(); respond = socket => socket.close();
  expect((await run()).status).toBe(502);
  expect(Socket.all[0]!.frames).toHaveLength(2);
});

test('recovery reacquires pacing and checks cancellation after that wait', async () => {
  await seed(); const controller = new AbortController(); let waits = 0;
  await expect(run(follow, 'principal:alice', {}, undefined, controller.signal, fallback, undefined,
    async () => { waits++; controller.abort(); })).rejects.toMatchObject({ name: 'AbortError' });
  expect(waits).toBe(1);
  expect(Socket.all[0]!.frames).toHaveLength(2);
});

test('another admitted caller cannot inherit a recovered prefix', async () => {
  await seed(); expect(await (await run()).text()).toContain('response.completed');
  await (await run([...follow, answer, message('user', 'bob')], 'principal:bob')).text();
  expect(Socket.all).toHaveLength(2);
  expect(Socket.all[1]!.frames[0].previous_response_id).toBeUndefined();
  expect(Socket.all[1]!.frames[0].input).toEqual([...follow, answer, message('user', 'bob')]);
});

test('a miss after response output commitment cannot resend the create', async () => {
  await seed(); respond = socket => { socket.emit({ type: 'response.created', response: { id: 'started' } }); socket.emit(missing); };
  expect(await (await run()).text()).toContain('previous_response_not_found');
  expect(Socket.all[0]!.frames).toHaveLength(2);
});

test('a foreign stream cache miss cannot authorize a resend', async () => {
  await seed(); respond = socket => socket.emit({ ...missing, stream_id: 'foreign' });
  const response = await run();
  expect(response.status).toBe(502);
  expect(Socket.all[0]!.frames).toHaveLength(2);
});

test('recovery rechecks dispatch admission before a second physical create', async () => {
  await seed(); let guards = 0;
  const response = await run(follow, 'principal:alice', {}, undefined, undefined, fallback,
    () => { if (++guards === 3) throw new Error('admission revoked'); });
  expect(response.status).toBe(502);
  expect(guards).toBe(3);
  expect(Socket.all[0]!.frames).toHaveLength(2);
});

test('an oversized retained full create recovers over HTTP with its original complete body', async () => {
  const big = [message('user', 'a'.repeat(8 * 1024 * 1024))]; await seed(big);
  const input = [...big, answer, message('user', 'b'.repeat(8 * 1024 * 1024))];
  let sends = 0;
  const http = (async (target: unknown, init?: RequestInit) => {
    sends++; expect(target).toBe(url);
    const body = JSON.parse(init!.body as string);
    expect(body.input).toEqual(input); expect(body.previous_response_id).toBeUndefined();
    return new Response('full HTTP response');
  }) as typeof fetch;
  expect(await (await run(input, 'principal:alice', {}, undefined, undefined, http)).text()).toBe('full HTTP response');
  expect(sends).toBe(1); expect(Socket.all[0]!.frames).toHaveLength(2);
  expect(Socket.all[0]!.readyState).toBe(3);
});
