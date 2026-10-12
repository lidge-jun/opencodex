import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LanguageProvider } from '../src/i18n/provider';
import Tray from '../src/pages/Tray';

// #6920: mounted tray routing. The popup must not poll before its targets resolve, and then every
// read and the account switch go to the resolved shared-plane base (hub origin or local relay).
const globals = ['document', 'window', 'navigator', 'localStorage', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: Array<{ url: string; method: string }>;

const routes: Record<string, unknown> = {
  '/api/config': { providers: { openai: {}, oauthp: { authMode: 'oauth' }, keyp: { hasApiKey: true } } },
  '/api/codex-auth/accounts': { activeAccountId: 'a0', accounts: [{ id: 'a0', alias: 'Main', quota: { weeklyPercent: 10 } }, { id: 'a1', alias: 'Second', quota: { weeklyPercent: 20 } }] },
  '/api/codex-auth/active': { activeCodexAccountId: 'a0' },
  '/api/oauth/accounts?provider=oauthp&quota=1': { accounts: [] },
  '/api/providers/keys?name=keyp&quota=1': { keys: [] },
  '/api/companion/settings': { settings: { hiddenProviders: [], models: null, showChart: false, showToday: true, showAccounts: true, showModels: false, showCost: false } },
  '/api/usage?range=today': { summary: { requests: 1 }, models: [] },
  '/api/usage?range=30d': { summary: { requests: 2 }, models: [] },
};

function stubFetch(base: string) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ url, method });
    if (!url.startsWith(base)) return new Response('not found', { status: 404 });
    const path = url.slice(base.length);
    if (method === 'PUT') return Response.json({ ok: true });
    return path in routes ? Response.json(routes[path]) : new Response('not found', { status: 404 });
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: 'http://127.0.0.1:10100/#/tray' });
  Object.defineProperty(testWindow.navigator, 'language', { configurable: true, value: 'en-US' });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    HTMLElement: { configurable: true, value: testWindow.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  container = testWindow.document.createElement('div') as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  requests = [];
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function settle(turns = 30): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

function render(resolveApiBase: (signal: AbortSignal) => Promise<string>, base: string): void {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: stubFetch(base) });
  root = createRoot(container);
  act(() => root!.render(<LanguageProvider><Tray resolveApiBase={resolveApiBase} /></LanguageProvider>));
}

const expectedReads = [
  '/api/config', '/api/codex-auth/accounts', '/api/codex-auth/active',
  '/api/oauth/accounts?provider=oauthp&quota=1', '/api/providers/keys?name=keyp&quota=1',
  '/api/companion/settings', '/api/usage?range=today', '/api/usage?range=30d',
];

for (const base of ['https://hub.example.test', '/api/machine/hub-relay']) {
  test(`nothing is polled before resolution, then every read and the switch use ${base}`, async () => {
    const targets = deferred<string>();
    render(() => targets.promise, base);
    await settle(3);
    expect(requests).toEqual([]);

    targets.resolve(base);
    await settle();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.url.startsWith(`${base}/api/`)).toBe(true);
    expect(new Set(requests.map(request => request.url.slice(base.length)))).toEqual(new Set(expectedReads));

    const use = container.querySelector('button.tray-use') as unknown as HTMLButtonElement | null;
    expect(use).not.toBeNull();
    await act(async () => { use!.click(); });
    await settle();
    expect(requests.filter(request => request.method === 'PUT').map(request => request.url)).toEqual([`${base}/api/codex-auth/active`]);
  });
}

test('a failed target discovery is reported, polls nothing, and Retry resolves again', async () => {
  let attempts = 0;
  render(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('local machine plane unavailable');
    return 'https://hub.example.test';
  }, 'https://hub.example.test');
  await settle(5);
  expect(requests).toEqual([]);
  const alert = container.querySelector('[role="alert"] button') as unknown as HTMLButtonElement | null;
  expect(alert).not.toBeNull();
  await act(async () => { alert!.click(); });
  await settle();
  expect(attempts).toBe(2);
  expect(requests.map(request => request.url)).toContain('https://hub.example.test/api/config');
});

test('unmounting while targets resolve cancels resolution and polls nothing', async () => {
  const targets = deferred<string>();
  let signal: AbortSignal | undefined;
  render(next => { signal = next; return targets.promise; }, 'https://hub.example.test');
  await settle(2);
  act(() => root!.unmount());
  root = null;
  expect(signal?.aborted).toBe(true);
  targets.resolve('https://hub.example.test');
  await settle(5);
  expect(requests).toEqual([]);
});

test('unmounting during an account switch aborts the request and starts no refresh', async () => {
  const base = 'https://hub.example.test';
  render(async () => base, base);
  await settle();
  const reads = stubFetch(base);
  const put = deferred<Response>();
  let putSignal: AbortSignal | undefined;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() !== 'PUT') return reads(input, init);
    requests.push({ url: String(input), method: 'PUT' });
    putSignal = init?.signal ?? undefined;
    return put.promise;
  } });
  const use = container.querySelector('button.tray-use') as unknown as HTMLButtonElement | null;
  expect(use).not.toBeNull();
  await act(async () => { use!.click(); });
  expect(putSignal?.aborted).toBe(false);
  act(() => root!.unmount());
  root = null;
  expect(putSignal?.aborted).toBe(true);
  const settled = requests.length;
  put.resolve(Response.json({ ok: true }));
  await settle(5);
  expect(requests.length).toBe(settled);
});
