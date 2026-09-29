import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProviderAccountPools, type OAuthAccount } from "../src/hooks/useProviderAccountPools";

// A pause is persisted by the PUT alone. Everything after it is a follow-up read, and its
// failure must never be reported as a failed pause (the operator would retry a saved change).

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let root: Root | null = null;
let pools: ReturnType<typeof useProviderAccountPools>;
let notices: Array<{ key: string; ok: boolean }>;
let respond: (url: string, init?: RequestInit) => Promise<Response>;
let fetchOauth: () => Promise<void>;

const row = (id: string, active: boolean, paused = false): OAuthAccount => ({ id, email: `${id}@example.test`, active, paused });

function Harness() {
  const aliveRef = useRef(true);
  const current = useProviderAccountPools({ apiBase: "/pause-hook", config: null, aliveRef, t: key => key,
    oauthStatus: {}, notify: (key: string, ok: boolean) => { notices.push({ key, ok }); },
    fetchConfig: async () => {}, fetchOauth: () => fetchOauth(), fetchProviderQuotas: async () => {},
    codexActiveNeedsReauth: false });
  useLayoutEffect(() => { pools = current; }, [current]);
  return null;
}

beforeEach(async () => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  const win = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init) },
  });
  notices = [];
  fetchOauth = async () => {};
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  await act(async () => { root = createRoot(host as unknown as HTMLElement); root.render(<Harness />); });
  respond = async () => Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  await act(async () => { await pools.fetchAccountSets(["fixture"]); });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("confirmed threshold persists in UI when follow-up read fails; failed writes preserve prior state", async () => {
  let fail = false; const bodies: unknown[] = [];
  respond = async (_url, init) => {
    if (init?.method !== "PUT") return new Response(null, { status: 503 });
    bodies.push(JSON.parse(String(init.body)));
    return fail ? new Response(null, { status: 500 }) : Response.json({ autoSwitchThresholdOverride: 0, autoSwitchThreshold: 70, effectiveAutoSwitchThreshold: 0 });
  };
  await act(async () => { expect(await pools.setAccountThreshold("fixture", row("b", false), 0)).toBe(true); });
  expect(pools.accountSets.fixture.accounts[1]?.autoSwitchThresholdOverride).toBe(0);
  expect(bodies[0]).toEqual({ provider: "fixture", accountId: "b", threshold: 0 });
  fail = true;
  await act(async () => { expect(await pools.setAccountThreshold("fixture", row("b", false), null)).toBe(false); });
  expect(pools.accountSets.fixture.accounts[1]?.autoSwitchThresholdOverride).toBe(0);
  expect(notices.some(notice => notice.key === "accountPool.autoSwitchUpdateFailed")).toBe(true);
});

test("pending threshold owns its roster generation and blocks conflicting pause", async () => {
  let settle!: (response: Response) => void; let writes = 0;
  respond = async (_url, init) => {
    if (init?.method !== "PUT") return new Response(null, { status: 503 });
    writes++; return new Promise(resolve => { settle = resolve; });
  };
  let pending!: Promise<boolean>;
  await act(async () => { pending = pools.setAccountThreshold("fixture", row("b", false), 40); });
  await act(async () => { await pools.pauseAccount("fixture", row("b", false), true); });
  expect(writes).toBe(1);
  await act(async () => { settle(Response.json({ autoSwitchThresholdOverride: 40, autoSwitchThreshold: 70, effectiveAutoSwitchThreshold: 40 })); await pending; });
  expect(pools.accountSets.fixture.accounts[1]?.autoSwitchThresholdOverride).toBe(40);
});

test("a confirmed pool threshold invalidates an older roster while later external changes still win", async () => {
  let settleStale!: (response: Response) => void;
  let reads = 0;
  const urls: string[] = [];
  respond = async (url, init) => {
    if (init?.method === "PUT") return new Response(null, { status: 500 });
    urls.push(url);
    reads++;
    if (reads === 1) return new Promise(resolve => { settleStale = resolve; });
    const threshold = reads <= 3 ? 70 : 55;
    return Response.json({ activeAccountId: "a", accounts: [
      { ...row("a", true), quotaMode: "probe", autoSwitchThresholdOverride: null, autoSwitchThreshold: threshold, effectiveAutoSwitchThreshold: threshold },
      { ...row("b", false), quotaMode: "probe", autoSwitchThresholdOverride: 40, autoSwitchThreshold: threshold, effectiveAutoSwitchThreshold: 40 },
    ] });
  };

  let stale!: Promise<boolean>;
  await act(async () => { stale = pools.refreshAccountRosters({ provider: "fixture", kind: "oauth" }); });
  await act(async () => { expect(await pools.setAccountPoolThreshold("fixture", 70)).toBe(true); });
  await act(async () => { await Promise.resolve(); });
  expect(urls.some(url => url.includes("quota=1"))).toBe(true);
  expect(pools.accountSets.fixture.accounts[0]?.autoSwitchThreshold).toBe(70);
  expect(pools.accountSets.fixture.accounts[1]?.effectiveAutoSwitchThreshold).toBe(40);

  await act(async () => {
    settleStale(Response.json({ activeAccountId: "a", accounts: [
      { ...row("a", true), quotaMode: "probe", autoSwitchThresholdOverride: null, autoSwitchThreshold: 65, effectiveAutoSwitchThreshold: 65 },
      { ...row("b", false), quotaMode: "probe", autoSwitchThresholdOverride: 40, autoSwitchThreshold: 65, effectiveAutoSwitchThreshold: 40 },
    ] }));
    await stale;
  });
  expect(pools.accountSets.fixture.accounts[0]?.autoSwitchThreshold).toBe(70);

  await act(async () => { expect(await pools.refreshAccountRosters({ provider: "fixture", kind: "oauth" })).toBe(true); });
  expect(pools.accountSets.fixture.accounts[0]?.autoSwitchThreshold).toBe(55);
});

test("a stalled account threshold write is aborted when the hook unmounts", async () => {
  let aborted = false;
  respond = async (_url, init) => new Promise((_resolve, reject) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true });
  });
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = pools.setAccountThreshold("fixture", row("b", false), 40);
    await Promise.resolve();
  });
  await act(async () => { root?.unmount(); root = null; });
  expect(await pending).toBe(false);
  expect(aborted).toBe(true);
});

test("a saved pause stays visible and only the failed roster refresh is reported", async () => {
  respond = async (_url, init) => init?.method === "PUT"
    ? Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false })
    : new Response(null, { status: 503 });
  await act(async () => { await pools.pauseAccount("fixture", row("b", false), true); });
  expect(pools.accountSets.fixture.accounts.find(account => account.id === "b")?.paused).toBe(true);
  expect(notices).toEqual([
    { key: "codexAuth.pauseSucceeded", ok: true },
    { key: "pws.accountsLoadFailed", ok: false },
  ]);
  expect(pools.pausingAccount).toBeNull();
});

test("a follow-up read that throws after an active-account change is not a pause failure", async () => {
  respond = async (_url, init) => init?.method === "PUT"
    ? Response.json({ ok: true, activeAccountId: "b", activeAccountChanged: true })
    : Response.json({ activeAccountId: "b", accounts: [row("a", false, true), row("b", true)] });
  fetchOauth = async () => { throw new Error("status read failed"); };
  await act(async () => { await pools.pauseAccount("fixture", row("a", true), true); });
  expect(pools.accountSets.fixture.activeAccountId).toBe("b");
  expect(notices.map(notice => notice.key)).toEqual(["codexAuth.pauseSucceeded", "pws.accountsLoadFailed"]);
  expect(notices.some(notice => notice.key === "codexAuth.pauseFailed")).toBe(false);
});

test("a rejected save reports the pause failure and leaves the row unpaused", async () => {
  respond = async (_url, init) => init?.method === "PUT"
    ? Response.json({ error: "account not found" }, { status: 404 })
    : Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  await act(async () => { await pools.pauseAccount("fixture", row("b", false), true); });
  expect(pools.accountSets.fixture.accounts.find(account => account.id === "b")?.paused).toBe(false);
  expect(notices).toEqual([{ key: "codexAuth.pauseFailed", ok: false }]);
});
