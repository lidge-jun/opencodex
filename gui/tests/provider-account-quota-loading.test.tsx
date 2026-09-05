import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProviderAccountPools, type OAuthAccount, type ApiKeyEntry } from "../src/hooks/useProviderAccountPools";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let root: Root | null;
let host: HTMLElement;
let pools: ReturnType<typeof useProviderAccountPools>;
let requests: Array<{ url: string; signal?: AbortSignal | null }>;
let respond: (url: string, signal?: AbortSignal | null) => Promise<Response>;
const noop = async () => {};
const reading = { fiveHourPercent: 21, weeklyPercent: 34, updatedAt: 1_700_000_000_000 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Harness({ apiBase = "/quota-hook" }: { apiBase?: string }) {
  const aliveRef = useRef(true);
  const currentPools = useProviderAccountPools({ apiBase, config: null, aliveRef, t: key => key,
    oauthStatus: {}, notify: () => {}, fetchConfig: noop, fetchOauth: noop,
    fetchProviderQuotas: noop, codexActiveNeedsReauth: false });
  useLayoutEffect(() => { pools = currentPools; }, [currentPools]);
  return null;
}
beforeEach(async () => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  requests = [];
  respond = async () => Response.json({ accounts: [], keys: [] });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), signal: init?.signal });
    return respond(String(input), init?.signal);
  } });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  await act(async () => { root = createRoot(host); root.render(<Harness />); });
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); root = null; });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM.close();
});

test("cheap probe rows paint with same-ID last-good; forced enrichment awaits and HTTP failure clears pending", async () => {
  const account: OAuthAccount = { id: "same", active: true, quotaMode: "probe", quota: reading };
  await act(async () => { pools.setAccountSets({ oauth: { activeAccountId: "same", accounts: [account, { ...account, id: "removed" }] } }); });
  const quota = deferred<Response>();
  const started = deferred<void>();
  respond = async url => {
    if (url.includes("quota=1")) { started.resolve(); return quota.promise; }
    return Response.json({ activeAccountId: "new", accounts: [
      { id: "same", active: false, quotaMode: "probe" }, { id: "new", active: true, quotaMode: "probe" },
    ] });
  };
  let result!: Promise<boolean>;
  let settled = false;
  await act(async () => { result = pools.fetchAccountSets(["oauth"], true); void result.then(() => { settled = true; }); await started.promise; });
  expect(pools.accountLoadStates.oauth).toBe("ready");
  expect(pools.accountSets.oauth.accounts.map(row => row.id)).toEqual(["same", "new"]);
  expect(pools.accountSets.oauth.accounts[0]).toMatchObject({ quota: reading, quotaPending: true });
  expect(pools.accountSets.oauth.accounts[1].quota).toBeUndefined();
  expect(settled).toBe(false);
  expect(requests[1].url).toContain("&quota=1&refresh=1");
  expect(requests.every(request => request.signal instanceof AbortSignal)).toBe(true);
  await act(async () => { quota.resolve(new Response(null, { status: 503 })); expect(await result).toBe(false); });
  expect(pools.accountSets.oauth.accounts[0]).toMatchObject({ quota: reading, quotaPending: false, quotaUnavailable: true });
  expect(pools.accountSets.oauth.accounts[1]).toMatchObject({ quotaPending: false, quotaUnavailable: true });
});

test("key subset refresh preserves other providers, clears old failure on success, and never calls OAuth", async () => {
  const key: ApiKeyEntry = { id: "key-a", masked: "masked", active: true, quotaMode: "probe", quota: reading, quotaUnavailable: true };
  await act(async () => { pools.setKeyPools({ first: [key], untouched: [{ ...key, id: "other" }] }); });
  const quota = deferred<Response>();
  const started = deferred<void>();
  respond = async url => {
    if (url.includes("quota=1")) { started.resolve(); return quota.promise; }
    return Response.json({ keys: [{ id: "key-a", masked: "masked", active: true, quotaMode: "probe" }] });
  };
  let result!: Promise<boolean>;
  await act(async () => { result = pools.fetchKeyPools(["first"], true); await started.promise; });
  expect(pools.keyPools.untouched[0].id).toBe("other");
  expect(pools.keyPools.first[0]).toMatchObject({ quota: reading, quotaPending: true, quotaUnavailable: false });
  await act(async () => {
    quota.resolve(Response.json({ keys: [{ id: "key-a", masked: "masked", active: true, quotaMode: "probe", quota: { ...reading, fiveHourPercent: 55 } }] }));
    expect(await result).toBe(true);
  });
  expect(pools.keyPools.first[0]).toMatchObject({ quotaPending: false, quotaUnavailable: false, quota: { fiveHourPercent: 55 } });
  expect(requests.every(request => request.url.includes("/api/providers/keys"))).toBe(true);
});

test("unsupported and unknown-mode rows do not enrich; passive missing observations never spin", async () => {
  for (const quotaMode of ["unsupported", undefined, "future-mode"]) {
    requests = [];
    respond = async () => Response.json({ keys: [{ id: "key", masked: "masked", active: true, quotaMode }] });
    await act(async () => { expect(await pools.fetchKeyPools(["keys"], true)).toBe(true); });
    expect(requests).toHaveLength(1);
    expect(pools.keyPools.keys[0].quotaPending).not.toBe(true);
    if (quotaMode !== "unsupported") {
      expect(pools.keyPools.keys[0].quotaPending).toBeUndefined();
      expect(pools.keyPools.keys[0].quotaUnavailable).toBeUndefined();
    }
  }
  const started = deferred<void>();
  const quota = deferred<Response>();
  respond = async url => {
    if (url.includes("quota=1")) { started.resolve(); return quota.promise; }
    return Response.json({ accounts: [{ id: "passive", active: true, quotaMode: "passive" }] });
  };
  await act(async () => { expect(await pools.fetchAccountSets(["passive"])).toBe(true); await started.promise; });
  expect(pools.accountSets.passive.accounts[0]).toMatchObject({ quotaMode: "passive", quotaPending: false });
  await act(async () => { quota.resolve(Response.json({ accounts: [{ id: "passive", active: true, quotaMode: "passive", quota: null }] })); });
  expect(pools.accountSets.passive.accounts[0].quota).toBeNull();
});

test("stale generations settle false and cannot overwrite a newer roster", async () => {
  const old = deferred<Response>();
  let call = 0;
  respond = async () => ++call === 1 ? old.promise : Response.json({ keys: [{ id: "new", active: true, masked: "new", quotaMode: "unsupported" }] });
  let first!: Promise<boolean>;
  await act(async () => { first = pools.fetchKeyPools(["keys"], true); });
  await act(async () => { expect(await pools.fetchKeyPools(["keys"], true)).toBe(true); });
  await act(async () => { old.resolve(Response.json({ keys: [{ id: "old", masked: "old", active: true, quotaMode: "unsupported" }] })); expect(await first).toBe(false); });
  expect(pools.keyPools.keys.map(row => row.id)).toEqual(["new"]);
});

test("one unavailable enriched account fails forced refresh and preserves its own last-good quota", async () => {
  respond = async url => Response.json({ accounts: [{ id: "account", active: true, quotaMode: "probe",
    ...(url.includes("quota=1") ? { quotaUnavailable: true } : { quota: reading }),
  }] });
  await act(async () => { expect(await pools.fetchAccountSets(["oauth"], true)).toBe(false); });
  expect(pools.accountSets.oauth.accounts[0]).toMatchObject({ quota: reading, quotaPending: false, quotaUnavailable: true });
});

test("explicit null in a failed enriched reading invalidates last-good for OAuth and keys", async () => {
  await act(async () => {
    pools.setAccountSets({ oauth: { activeAccountId: "account", accounts: [
      { id: "account", active: true, quotaMode: "probe", quota: reading },
    ] } });
    pools.setKeyPools({ keys: [
      { id: "key", active: true, masked: "masked", quotaMode: "probe", quota: reading },
    ] });
  });
  respond = async url => {
    const invalidation = url.includes("quota=1") ? { quota: null, quotaUnavailable: true } : {};
    return Response.json(url.includes("/api/oauth/accounts")
      ? { activeAccountId: "account", accounts: [{ id: "account", active: true, quotaMode: "probe", ...invalidation }] }
      : { keys: [{ id: "key", active: true, masked: "masked", quotaMode: "probe", ...invalidation }] });
  };
  await act(async () => {
    expect(await pools.fetchAccountSets(["oauth"], true)).toBe(false);
    expect(await pools.fetchKeyPools(["keys"], true)).toBe(false);
  });
  expect(pools.accountSets.oauth.accounts[0]).toMatchObject({ quota: null, quotaUnavailable: true, quotaPending: false });
  expect(pools.keyPools.keys[0]).toMatchObject({ quota: null, quotaUnavailable: true, quotaPending: false });
});

test("unmount aborts bounded roster reads and returns false", async () => {
  const started = deferred<void>();
  respond = async (_url, signal) => new Promise<Response>((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    started.resolve();
  });
  let result!: Promise<boolean>;
  await act(async () => { result = pools.fetchAccountSets(["oauth"], true); await started.promise; });
  await act(async () => { root!.unmount(); root = null; expect(await result).toBe(false); });
});

test("a hanging fetch reaches its deadline, preserves last-good and clears probe pending", async () => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  jest.useFakeTimers();
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  try {
    await act(async () => { pools.setKeyPools({ keys: [{ id: "key", active: true, masked: "masked", quotaMode: "probe", quota: reading }] }); });
    const started = deferred<void>();
    respond = async (url, signal) => {
      if (!url.includes("quota=1")) return Response.json({ keys: [{ id: "key", active: true, masked: "masked", quotaMode: "probe" }] });
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
        started.resolve();
      });
    };
    let result!: Promise<boolean>;
    await act(async () => { result = pools.fetchKeyPools(["keys"], true); await started.promise; });
    expect(pools.keyPools.keys[0].quotaPending).toBe(true);
    await act(async () => { jest.advanceTimersByTime(20_000); expect(await result).toBe(false); });
    expect(pools.keyPools.keys[0]).toMatchObject({ quota: reading, quotaPending: false, quotaUnavailable: true });
  } finally {
    jest.useRealTimers();
    if (timeoutDescriptor) Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    else Reflect.deleteProperty(AbortSignal, "timeout");
  }
});
