import { afterEach, beforeEach, expect, test } from 'bun:test';
import { handleResponses } from '../../src/server/responses';
import { capRequestExecutionBudgetSends, capturePhysicalSendRecovery, createPhysicalSendReporter, createRequestExecutionBudget, type SingleUseDispatchPermit } from '../../src/lib/request-execution-budget';
import { fetchWithResetRetry, fetchWithTransientRetry, REPLAY_REFUSAL_MESSAGE } from '../../src/lib/upstream-retry';
import { acquireOwnedSpendHome } from '../helpers/owned-spend-home';
import { codexWsPool } from '../../src/server/responses/codex-ws-pool';
import { setCodexWsIncrementalUpload } from '../../src/server/responses/codex-ws-incremental';
import { setCodexWsReuseAcrossTurns } from '../../src/config/codex-ws-reuse-setting';
import { saveCodexAccountCredential } from '../../src/codex/account-store';
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } from '../../src/lib/spend-reservation-ledger';
import { createRequestSpendTracker } from '../../src/server/responses/request-spend';
import { estimateTokens } from '../../src/lib/token-estimate';
import type { RequestLogContext } from '../../src/server/request-log';
import type { OcxConfig } from '../../src/types';

const original = globalThis.WebSocket;
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const message = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture answer' }] };
const missing = { type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'fixture cache miss' } };
const config = { port: 0, defaultProvider: 'openai', providers: { openai: {
  adapter: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', authMode: 'forward', codexAccountMode: 'direct',
} } } as OcxConfig;
const account = 'fixture-pool-account';
const identityId = 'pabcdef';
const poolConfig: OcxConfig = { ...config,
  activeCodexAccountId: account, autoSwitchThreshold: 0, codexAccounts: [{ id: account, logLabel: identityId }],
  providers: { openai: { ...config.providers.openai!, codexAccountMode: 'pool' } },
  combos: { spend: { strategy: 'failover', targets: [{ provider: 'openai', model: 'fixture' }] } },
};
let saved: Record<string, string | undefined>;
let release: () => void;
class Socket extends EventTarget {
  static all: Socket[] = [];
  static miss: unknown;
  readyState = 0;
  frames: Record<string, any>[] = [];
  constructor(_url: string, options?: { headers?: Record<string, string> }) {
    super();
    if (options?.headers?.authorization === 'Bearer fixture-rejected-access') {
      throw new Error('fixture rejected upgrade');
    }
    Socket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  emit(payload: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) })); }
  send(text: string) {
    const frame = JSON.parse(text); this.frames.push(frame);
    queueMicrotask(() => {
      if (frame.previous_response_id) { this.emit(Socket.miss); return; }
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
  Socket.miss = missing;
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
async function run(input: unknown[], sendBudget: ReturnType<typeof budget>, initialPermit?: SingleUseDispatchPermit, runConfig = config,
  model = 'fixture', log: RequestLogContext = { model: '', provider: '' }) {
  const req = new Request('http://localhost/v1/responses', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture-account', 'thread-id': 'fixture-thread' },
    body: JSON.stringify({ model, input, stream: true, store: false,
      client_metadata: { thread_id: 'fixture-thread', turn_id: 'fixture-turn' } }) });
  return handleResponses(req, runConfig, log, { codexWsRuntimeIdentity: '1.4.4', sendBudget,
    ...(initialPermit ? { comboInitialSend: { permit: initialPermit } } : {}),
    admission: { kind: 'configured', source: 'dedicated', keyId: 'fixture-caller', contextPrincipalId: 'fixture-caller' } });
}

async function warmCombo() {
  saveCodexAccountCredential(account, { accessToken: 'fixture-pool-access', refreshToken: 'fixture-pool-refresh',
    expiresAt: Date.now() + 300_000, chatgptAccountId: 'fixture-account' });
  const initial = [message('fixture prefix '.repeat(100))];
  const warm = await run(initial, budget(1, false), undefined, poolConfig);
  expect(await warm.text()).toContain('response.completed');
  expect(Socket.all).toHaveLength(1);
  return [...initial, answer, message('next')];
}

test.each([
  ['ordinary miss', missing, undefined],
  ['retryable false', { ...missing, response: { retryable: false } }, 'upstream_response_refused'],
  ['header veto', { ...missing, headers: { 'X-Should-Retry': 'false', 'Retry-After': '30' } }, 'upstream_response_refused'],
  ['recognized refusal', { ...missing, last_error: { code: 'upstream_reset_replay_refused' } }, 'upstream_reset_replay_refused'],
  ['root refusal code', { ...missing, code: 'upstream_response_refused' }, 'upstream_response_refused'],
] as const)('cache-miss recovery honors %s before admission', async (_label, frame, code) => {
  const input = await warmCombo();
  Socket.miss = frame;
  const shared = budget(3, true);
  const log: RequestLogContext = { model: '', provider: '' };
  const response = await run(input, shared, undefined, poolConfig, 'fixture', log);
  const body = await response.text();
  const frames = Socket.all.flatMap(socket => socket.frames).slice(1);
  expect(frames[0]?.previous_response_id).toBe('fixture-response-1');
  expect({ sends: frames.length, charged: shared.used, started: shared.physicalStarted,
    recorded: log.activeAttempt?.sendCount, status: response.status }).toEqual(code
    ? { sends: 1, charged: 1, started: 1, recorded: 1, status: 429 }
    : { sends: 2, charged: 2, started: 2, recorded: 1, status: 200 });
  if (code) {
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(response.headers.get('retry-after')).toBeNull();
    expect(JSON.parse(body).error).toMatchObject({ code, message: REPLAY_REFUSAL_MESSAGE });
  } else {
    expect(frames[1]?.previous_response_id).toBeUndefined();
    expect(body).toContain('response.completed');
  }
});

test.each([1, 2])('stored credential replay accounts for admitted cache recovery (replay slots=%s)', async replaySlots => {
  const prefix = [message('fixture prefix '.repeat(100))];
  const input = [...prefix, answer, message('next')];
  const saveToken = (accessToken: string) => saveCodexAccountCredential(account, {
    accessToken, refreshToken: 'fixture-pool-refresh', expiresAt: Date.now() + 300_000,
    chatgptAccountId: 'fixture-account',
  });
  saveToken('fixture-rejected-access');
  const shared = budget(1 + replaySlots, true);
  const log: RequestLogContext = { model: '', provider: '' };
  const originalFetch = globalThis.fetch;
  let sendsBeforeReplay = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-rejected-access');
    sendsBeforeReplay = shared.physicalStarted;
    // Publish the replacement as the rejected request completes, avoiding any real refresh call.
    saveToken('fixture-pool-access');
    const warm = await run(prefix, budget(1, false), undefined, poolConfig);
    expect(await warm.text()).toContain('response.completed');
    return Response.json({ error: { code: 'invalid_token' } }, { status: 401 });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  try {
    const response = await run(input, shared, undefined, poolConfig, 'fixture', log);
    const body = await response.text();
    const frames = Socket.all.flatMap(socket => socket.frames);
    expect(sendsBeforeReplay).toBe(1);
    expect(frames[1]?.previous_response_id).toBe('fixture-response-1');
    expect(frames).toHaveLength(1 + replaySlots);
    expect(body).toContain(replaySlots === 2 ? 'response.completed' : 'previous_response_not_found');
    expect(shared.used - sendsBeforeReplay).toBe(replaySlots);
    expect(log.activeAttempt?.sendCount).toBe(replaySlots);
  } finally { globalThis.fetch = originalFetch; }
});

for (const { pool, ceiling, recovered, maxTrackedSends } of [
  { pool: 100, ceiling: 10, recovered: false },
  { pool: 100, ceiling: 20, recovered: true },
  { pool: undefined, ceiling: 10, recovered: false },
  { pool: undefined, ceiling: 20, recovered: true },
  { pool: undefined, ceiling: 20, recovered: false, maxTrackedSends: 2 },
  { pool: undefined, ceiling: undefined, recovered: true },
]) {
  test(`Combo cache-miss resend requires fresh spend on its selected account (pool=${pool}, ceiling=${ceiling}, capacity=${maxTrackedSends})`, async () => {
    const input = await warmCombo();

    const ledger = createSpendReservationLedger({ salt: 'fixture-spend', journal: { read: () => [], append: () => {} },
      policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: pool }, identity: { maxTokens: ceiling },
        ...(maxTrackedSends === undefined ? {} : { maxTrackedSends }) } });
    const log: RequestLogContext = { model: '', provider: '', spendInputEstimateTokens: 10 };
    const tracker = createRequestSpendTracker(log, undefined, ledger);
    const shared = createRequestExecutionBudget(undefined, undefined, tracker);
    const response = await run(input, shared, undefined, poolConfig, 'combo/spend', log);
    const body = await response.text();
    const frames = Socket.all.flatMap(socket => socket.frames);
    expect(frames[1]?.previous_response_id).toBe('fixture-response-1');
    expect(frames).toHaveLength(recovered ? 3 : 2);
    if (recovered) expect(frames[2]!.input).toEqual(input);
    expect(response.status).toBe(recovered ? 200 : 400);
    expect(body).toContain(recovered ? 'response.completed' : 'previous_response_not_found');
    expect(shared.used).toBe(recovered ? 2 : 1);
    expect(shared.physicalStarted).toBe(pool !== undefined ? (recovered ? 2 : 1) : 0);
    expect(ledger.snapshot('identity', identityId)?.reserved).toBe(recovered && ceiling !== undefined ? 20 : 10);
    expect(ledger.snapshot('pool', 'openai')?.reserved).toBe(recovered ? 20 : 10);
    tracker.settle(recovered ? { inputTokens: 7 } : undefined);
    await ledger.waitForReporterDrain();
    const settled = recovered ? 7 : 0;
    expect(ledger.snapshot('identity', identityId)).toMatchObject({ reserved: 0, settled, unresolved: ceiling === undefined ? 0 : 10 });
    expect(ledger.snapshot('pool', 'openai')).toMatchObject({ reserved: 0, settled, unresolved: 10 });
  });
}

for (const recovered of [false, true]) {
  test(`unseeded Combo prices both sends under an identity-only ceiling (recovered=${recovered})`, async () => {
    const input = await warmCombo();
    const estimated = estimateTokens(JSON.stringify({ ...Socket.all[0]!.frames[0], input }), 'fixture');
    expect(estimated).toBeGreaterThan(0);
    const ledger = createSpendReservationLedger({ salt: 'fixture-spend', journal: { read: () => [], append: () => {} },
      policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, identity: { maxTokens: (recovered ? 2 : 1) * estimated } } });
    const log: RequestLogContext = { model: '', provider: '' };
    const tracker = createRequestSpendTracker(log, undefined, ledger);
    const shared = createRequestExecutionBudget(undefined, undefined, tracker);

    const response = await run(input, shared, undefined, poolConfig, 'combo/spend', log);
    const body = await response.text();
    const frames = Socket.all.flatMap(socket => socket.frames);
    expect(frames[1]?.previous_response_id).toBe('fixture-response-1');
    expect(frames).toHaveLength(recovered ? 3 : 2);
    expect(response.status).toBe(recovered ? 200 : 400);
    expect(body).toContain(recovered ? 'response.completed' : 'previous_response_not_found');
    expect(shared.used).toBe(recovered ? 2 : 1);
    expect(ledger.snapshot('identity', identityId)?.reserved).toBe((recovered ? 2 : 1) * estimated);
    expect(ledger.snapshot('pool', 'openai')?.reserved ?? 0).toBe(recovered ? estimated : 0);
    if (recovered) expect(frames[2]!.input).toEqual(input);

    tracker.settle(recovered ? { inputTokens: 7 } : undefined);
    await ledger.waitForReporterDrain();
    expect(ledger.snapshot('identity', identityId)).toMatchObject({ reserved: 0, settled: recovered ? 7 : 0, unresolved: estimated });
  });
}

test('recovery with no input estimate cannot reserve another send', () => {
  const ledger = createSpendReservationLedger({ salt: 'fixture-spend', journal: { read: () => [], append: () => {} },
    policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 100 } } });
  const tracker = createRequestSpendTracker({ provider: 'openai' }, undefined, ledger);
  const shared = createRequestExecutionBudget(undefined, undefined, tracker);

  expect(shared.reserveDispatch({ sendClass: 'transient', targetKey: 'openai/fixture', incrementalRecovery: {} }))
    .toEqual({ allowed: false, reason: 'spend-exhausted' });
  expect(shared.used).toBe(0);
  expect(ledger.snapshot('pool', 'openai')).toBeUndefined();
});

for (const maxTokens of [11, 12]) {
  test(`cache-miss recovery prices the prepared input under an explicit compact send cap (pool=${maxTokens})`, async () => {
    const ledger = createSpendReservationLedger({ salt: 'fixture-spend', journal: { read: () => [], append: () => {} },
      policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens } } });
    const tracker = createRequestSpendTracker({ provider: 'openai', spendOutputCeilingTokens: 1 }, undefined, ledger);
    const shared = capRequestExecutionBudgetSends(createRequestExecutionBudget(undefined, undefined, tracker), 2)!;
    const refusal = new Response('fixture cache miss', { status: 400 });
    let resends = 0;
    const response = await fetchWithTransientRetry(async () => {
      const recovered = await capturePhysicalSendRecovery()!(async dispatch => {
        dispatch();
        resends++;
      }, 10);
      return recovered ? new Response('recovered') : refusal;
    }, { attempts: 3, onSendsConsumed: createPhysicalSendReporter(shared, () => ({ poolId: 'openai' })) });

    const recovered = maxTokens === 12;
    expect(response.status).toBe(recovered ? 200 : 400);
    expect(resends).toBe(recovered ? 1 : 0);
    expect(shared.used).toBe(recovered ? 2 : 1);
    expect(shared.physicalStarted).toBe(shared.used);
    expect(ledger.snapshot('pool', 'openai')?.reserved).toBe(recovered ? 12 : 1);
    tracker.settle(undefined);
    await ledger.waitForReporterDrain();
    expect(ledger.snapshot('pool', 'openai')?.unresolved).toBe(recovered ? 12 : 1);
  });
}

for (const retry of [fetchWithResetRetry, fetchWithTransientRetry]) {
  test(`${retry.name} refuses recovery when its only slot funded the delta`, async () => {
    const shared = budget(4, false);
    let recoverySends = 0;
    const refused = new Response('fixture cache miss', { status: 400 });
    const result = await retry(async () => {
      const recovered = await capturePhysicalSendRecovery()!(async dispatch => {
        dispatch();
        recoverySends++;
      });
      return recovered ? new Response('unexpected recovery') : refused;
    }, { attempts: 1, onSendsConsumed: createPhysicalSendReporter(shared, () => ({ poolId: 'fixture' })) });
    expect(result).toBe(refused);
    expect(recoverySends).toBe(0);
    expect(shared.used).toBe(1);
  });
}
for (const enforced of [false, true]) for (const prepaid of [false, true]) {
  for (const [cap, expectedSends] of [[2, 2], [3, 3], [4, 3]] as const) for (const failure of ['503', 'reset'] as const) {
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
        expect(httpSends).toBe(expectedSends - 1);
        expect(Socket.all.flatMap(socket => socket.frames)).toHaveLength(2);
        expect(shared.used).toBe(expectedSends);
        if (enforced) expect(shared.physicalStarted).toBe(expectedSends);
        expect(response.status).toBe(failure === '503' ? 503 : 429);
        expect(body).toContain(failure === '503' ? 'fixture transient' : 'upstream_reset_replay_refused');
        permit?.release();
        expect(shared.used).toBe(expectedSends);
      } finally { globalThis.fetch = fetchBefore; permit?.release(); }
    });
  }
}
for (const lane of ['Codex HTTP-only', 'non-Codex'] as const) {
  for (const refused of [false, true]) {
    test(`${lane} combo prepaid receipt follows physical HTTP dispatch (refused=${refused})`, async () => {
      let sends = 0;
      let workflowStarts = 0;
      const shared = createRequestExecutionBudget({ maxTotalModelSends: 3, baseSendAllowance: 3,
        finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, undefined,
      { charge: () => true, refund: () => {}, startRequest: () => {}, beforePhysicalSend: () => { workflowStarts++; return true; } });
      const booking = shared.reserveDispatch({ sendClass: 'initial', targetKey: 'fixture-target', countedExternally: true });
      if (!booking.allowed) throw new Error('fixture reservation refused');
      const execute = (async () => {
        sends++;
        return new Response('fixture wire response', { status: 418 });
      }) as typeof fetch;
      const provider = { ...config.providers.openai!, upstreamWebsocket: false, fetch: execute,
        ...(lane === 'non-Codex' ? { baseUrl: 'https://fixture.invalid/v1', authMode: 'key' as const, apiKey: 'fixture' } : {}),
        ...(refused ? { proxy: 'http://egress.invalid:3128' } : {}),
      };
      try {
        const response = await run([message('fixture input')], shared, booking.permit,
          { ...config, providers: { openai: provider } });
        const body = await response.text();
        if (refused) expect(body).toContain('egress');
        else expect(body).toContain('fixture wire response');
        booking.permit.release();
        expect(Socket.all).toHaveLength(0);
        expect(sends).toBe(refused ? 0 : 1);
        expect(workflowStarts).toBe(refused ? 0 : 1);
        expect(shared.used).toBe(refused ? 0 : 1);
      } finally { booking.permit.release(); }
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
for (const ceiling of [1, 2]) test(`a cache-miss recovery claims the workflow send ceiling at physical admission (\`#8149\`, ceiling=${ceiling})`, async () => {
  const initial = [message('fixture prefix '.repeat(100))];
  await (await run(initial, budget(1, false))).text();
  let claims = 0;
  const shared = createRequestExecutionBudget({ maxTotalModelSends: 3, baseSendAllowance: 3,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, undefined,
  { charge: () => true, refund: () => {}, startRequest: () => {}, beforePhysicalSend: () => ++claims <= ceiling });
  const response = await run([...initial, answer, message('next')], shared);
  const body = await response.text();
  // The delta claims one root send; the full recovery must claim its own before it leaves.
  expect(claims).toBe(2);
  expect(Socket.all[0]!.frames).toHaveLength(ceiling === 1 ? 2 : 3);
  expect(response.status).toBe(ceiling === 1 ? 400 : 200);
  expect(body).toContain(ceiling === 1 ? 'previous_response_not_found' : 'response.completed');
});
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
