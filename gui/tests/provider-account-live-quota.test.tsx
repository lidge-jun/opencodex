import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProviderAccountPools, type Config } from "../src/hooks/useProviderAccountPools";
import { writeQuotaLiveRefreshPref } from "../src/quota-live-refresh-pref";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null;
let pools: ReturnType<typeof useProviderAccountPools>;
let requests: string[];
let respond: (url: string) => Promise<Response>;
let intervals: Map<number, { run: () => void; delay: number }>;
const noop = async () => {};
const before = { fiveHourPercent: 21, weeklyPercent: 34, updatedAt: 1_700_000_000_000 };
const after = { fiveHourPercent: 40, weeklyPercent: 50, updatedAt: 1_700_000_060_000 };
const config: Config = {
  port: 0,
  defaultProvider: "fixture",
  providers: {
    fixture: { adapter: "anthropic", baseUrl: "https://fixture.invalid", authMode: "oauth" },
    keyed: { adapter: "openai", baseUrl: "https://keyed.invalid", hasApiKey: true },
  },
};
const rows = (quota?: typeof before) => ["a", "b"].map(id => ({ id, masked: id, active: id === "a", quotaMode: "probe" as const, ...(quota ? { quota } : {}) }));
const roster = (quota?: typeof before) => Response.json({ activeAccountId: "a", activeId: "a", accounts: rows(quota), keys: rows(quota) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function Harness({ provider }: { provider: string | null }) {
  const aliveRef = useRef(true);
  const current = useProviderAccountPools({ apiBase: "/live", config, aliveRef, t: key => key,
    oauthStatus: {}, notify: () => {}, fetchConfig: noop, fetchOauth: noop,
    fetchProviderQuotas: noop, codexActiveNeedsReauth: false, liveQuotaProvider: provider });
  useLayoutEffect(() => { pools = current; }, [current]);
  return null;
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function mount(provider: string | null = "fixture") {
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  await act(async () => { root = createRoot(host as unknown as HTMLElement); root.render(<Harness provider={provider} />); });
  await settle();
  await settle();
  requests = [];
}

/** Fire every armed interval once, as the browser would when its delay elapses. */
async function fire() {
  await act(async () => { for (const timer of [...intervals.values()]) timer.run(); });
  await settle();
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(win.document, "visibilityState", { configurable: true, get: () => state });
  win.document.dispatchEvent(new win.Event("visibilitychange"));
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  intervals = new Map();
  let nextId = 0;
  win.setInterval = ((run: () => void, delay: number) => { intervals.set(++nextId, { run, delay }); return nextId; }) as typeof win.setInterval;
  win.clearInterval = ((id: number) => { intervals.delete(id); }) as typeof win.clearInterval;
  requests = [];
  respond = async url => roster(url.includes("quota=1") ? before : undefined);
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: (input: RequestInfo | URL) => {
    requests.push(String(input));
    return respond(String(input));
  } });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  win.close();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("a live tick re-reads the selected provider's account quota without forcing it or showing a load", async () => {
  await mount();
  expect(pools.accountSets.fixture.accounts[0].quota).toEqual(before);
  expect([...intervals.values()].map(timer => timer.delay)).toEqual([15_000]);
  const quota = deferred<Response>();
  respond = async () => quota.promise;
  await fire();
  expect(requests).toEqual(["/live/api/oauth/accounts?provider=fixture&quota=1"]);
  expect(requests[0]).not.toContain("refresh=1");
  // While the background read is out, the rows stay as they were: no skeleton, no pending bars.
  expect(pools.accountLoadStates.fixture).toBe("ready");
  expect(pools.accountSets.fixture.accounts[0]).toMatchObject({ quota: before, quotaPending: false });
  await act(async () => { quota.resolve(roster(after)); });
  await settle();
  expect(pools.accountSets.fixture.accounts.map(row => row.quota)).toEqual([after, after]);
  expect(pools.accountLoadStates.fixture).toBe("ready");
});

test("an API-key pool ticks through its own non-forced quota read", async () => {
  await mount("keyed");
  await fire();
  expect(requests).toEqual(["/live/api/providers/keys?name=keyed&quota=1"]);
});

test("a tick never overlaps a read that is already in flight", async () => {
  await mount();
  const manual = deferred<Response>();
  respond = async url => url.includes("quota=1") ? roster(after) : manual.promise;
  let refreshed!: Promise<boolean>;
  await act(async () => { refreshed = pools.fetchAccountSets(["fixture"], true); });
  expect(requests).toEqual(["/live/api/oauth/accounts?provider=fixture"]);
  await fire();
  expect(requests).toEqual(["/live/api/oauth/accounts?provider=fixture"]);
  await act(async () => { manual.resolve(roster()); expect(await refreshed).toBe(true); });
  expect(requests).toEqual(["/live/api/oauth/accounts?provider=fixture", "/live/api/oauth/accounts?provider=fixture&quota=1&refresh=1"]);
  requests = [];
  await fire();
  expect(requests).toEqual(["/live/api/oauth/accounts?provider=fixture&quota=1"]);
});

test("a hidden dashboard holds no live timer, and showing it again makes up one tick", async () => {
  await mount();
  setVisibility("hidden");
  expect(intervals.size).toBe(0);
  await fire();
  expect(requests).toEqual([]);
  await act(async () => { setVisibility("visible"); });
  await settle();
  expect(requests).toEqual(["/live/api/oauth/accounts?provider=fixture&quota=1"]);
  expect(intervals.size).toBe(1);
});

test("a failed tick keeps the bars on screen and raises no error", async () => {
  await mount();
  respond = async () => new Response(null, { status: 503 });
  await fire();
  expect(requests).toHaveLength(1);
  expect(pools.accountLoadStates.fixture).toBe("ready");
  expect(pools.accountSets.fixture.accounts[0]).toMatchObject({ quota: before, quotaPending: false, quotaUnavailable: false });
});

test("off holds no timer, the cadence follows the preference, and unmount stops it", async () => {
  await mount();
  await act(async () => { writeQuotaLiveRefreshPref({ enabled: false, intervalSeconds: 15 }); });
  expect(intervals.size).toBe(0);
  await act(async () => { writeQuotaLiveRefreshPref({ enabled: true, intervalSeconds: 40 }); });
  expect([...intervals.values()].map(timer => timer.delay)).toEqual([40_000]);
  await act(async () => { root?.unmount(); });
  root = null;
  expect(intervals.size).toBe(0);
});

test("no provider on screen means no live read", async () => {
  await mount(null);
  await fire();
  expect(requests).toEqual([]);
});
