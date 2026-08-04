import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useCodexAccountPool, type CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";

/**
 * WP3 behavioural contract. The sibling .ts file pins source-level invariants; this one
 * exercises the controller at runtime, because a shared-state claim proven only by
 * substring checks is not proven at all.
 */

// NOTE: `fetch` is deliberately absent. A sibling suite installs its own fetch router
// inside individual tests without restoring it, so writing a captured fetch back here
// would clobber that router and make results depend on file order.
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let calls: string[] = [];
let originalFetch: typeof globalThis.fetch;
let accounts: unknown[] = [];
let threshold = 80;
let nextAccountsResponseGate: Promise<void> | null = null;
let pauseResponseActiveId: string | null = null;
let bulkPausedAccountIds: string[] = ["a2"];
let bulkResponseActiveId: string | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  originalFetch = globalThis.fetch;
  calls = [];
  nextAccountsResponseGate = null;
  pauseResponseActiveId = null;
  bulkPausedAccountIds = ["a2"];
  bulkResponseActiveId = null;
  accounts = [{ id: "a1", email: "account-one", isMain: true, paused: false, hasCredential: true, quota: null }];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const path = String(url).split("/api/")[1] ?? String(url);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "codex-auth/accounts/pause") {
        const body = JSON.parse(String(init?.body)) as { id: string; paused: boolean };
        accounts = accounts.map(account => (
          typeof account === "object" && account !== null && "id" in account
            && (account.id === body.id || (body.id === "__main__" && "isMain" in account && account.isMain === true))
            ? { ...account, paused: body.paused }
            : account
        ));
        return { ok: true, json: async () => ({ activeCodexAccountId: pauseResponseActiveId }) } as unknown as Response;
      }
      if (path === "codex-auth/accounts/pause-exhausted") {
        const pausedIds = new Set(bulkPausedAccountIds);
        accounts = accounts.map(account => (
          typeof account === "object" && account !== null && "id" in account
            && (pausedIds.has(String(account.id)) || (pausedIds.has("__main__") && "isMain" in account && account.isMain === true))
            ? { ...account, paused: true }
            : account
        ));
        return {
          ok: true,
          json: async () => ({
            pausedAccountIds: bulkPausedAccountIds,
            pausedCount: bulkPausedAccountIds.length,
            activeCodexAccountId: bulkResponseActiveId,
          }),
        } as unknown as Response;
      }
      if (path.startsWith("codex-auth/accounts")) {
        const gate = nextAccountsResponseGate;
        nextAccountsResponseGate = null;
        if (gate) await gate;
        return { ok: true, json: async () => ({ accounts }) } as unknown as Response;
      }
      if (path.startsWith("codex-auth/active")) {
        return { ok: true, json: async () => ({ activeCodexAccountId: null, autoSwitchThreshold: threshold }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  // Unmount first, while this file's window/timers are still the active globals:
  // otherwise React cleanup runs against a swapped-out window and the controller's
  // 30s interval outlives the suite, firing into whatever runs next.
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  // Tear the window down: leaving it alive kept this file's timers and document
  // reachable, which made a sibling suite in the same process fail depending on order.
  await win.happyDOM?.close?.();
});

/** Mounts the hook and exposes the live controller. */
async function mountController(enabled = true) {
  const seen: { current: CodexAccountPoolController | null } = { current: null };
  function Probe() {
    seen.current = useCodexAccountPool("", enabled);
    return null;
  }
  // Lazy import: see the note on the Root type import above.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Probe />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return seen;
}

test("the controller loads once on mount", async () => {
  const seen = await mountController();
  expect(seen.current).not.toBeNull();
  expect(calls.filter(c => c.includes("codex-auth/accounts")).length).toBe(1);
  expect(seen.current!.accounts.length).toBe(1);
  expect(seen.current!.loadState).toBe("ready");
});

test("an inert controller issues no requests at all", async () => {
  await mountController(false);
  expect(calls.length).toBe(0);
});

test("pausing an account writes the persisted endpoint and updates shared state", async () => {
  const seen = await mountController();

  await act(async () => {
    expect(await seen.current!.setAccountPaused("a1", true)).toEqual({ ok: true });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(calls).toContain("PUT codex-auth/accounts/pause");
  expect(seen.current!.accounts[0]?.paused).toBe(true);
  expect(seen.current!.activeId).toBeNull();
});

test("pausing the main sentinel updates its distinct account row before reload", async () => {
  const seen = await mountController();
  let releaseReload!: () => void;
  nextAccountsResponseGate = new Promise<void>(resolve => { releaseReload = resolve; });

  await act(async () => {
    expect(await seen.current!.setAccountPaused("__main__", true)).toEqual({ ok: true });
  });

  expect(calls).toContain("PUT codex-auth/accounts/pause");
  expect(seen.current!.accounts.find(account => account.isMain)?.id).toBe("a1");
  expect(seen.current!.accounts.find(account => account.isMain)?.paused).toBe(true);

  await act(async () => {
    releaseReload();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});

test("pausing stores the actual fallback account returned by the API", async () => {
  accounts = [
    { id: "a1", email: "main", isMain: true, paused: false, hasCredential: true, quota: null },
    { id: "a2", email: "next", isMain: false, paused: false, hasCredential: true, quota: null },
  ];
  pauseResponseActiveId = "a2";
  const seen = await mountController();

  await act(async () => {
    expect(await seen.current!.setAccountPaused("__main__", true)).toEqual({ ok: true });
  });

  expect(seen.current!.activeId).toBe("a2");
});

test("a paused main account does not contribute active reauth state", async () => {
  accounts = [
    { id: "a1", email: "main", isMain: true, paused: true, hasCredential: true, needsReauth: true, quota: null },
    { id: "a2", email: "next", isMain: false, paused: false, hasCredential: true, quota: null },
  ];
  const seen = await mountController();

  expect(seen.current!.activeId).toBeNull();
  expect(seen.current!.activeNeedsReauth).toBe(false);
});

test("bulk pausing writes one endpoint and updates every returned account", async () => {
  accounts = [
    { id: "a1", email: "account-one", isMain: true, paused: false, hasCredential: true, quota: null },
    { id: "a2", email: "account-two", isMain: false, paused: false, hasCredential: true, quota: null },
  ];
  const seen = await mountController();

  await act(async () => {
    expect(await seen.current!.pauseExhaustedAccounts()).toEqual({ ok: true, pausedCount: 1 });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(calls).toContain("PUT codex-auth/accounts/pause-exhausted");
  expect(seen.current!.accounts.find(account => account.id === "a2")?.paused).toBe(true);
  expect(seen.current!.pausingExhausted).toBe(false);
});

test("bulk pausing translates the main sentinel to its distinct account row", async () => {
  accounts = [
    { id: "a1", email: "main", isMain: true, paused: false, hasCredential: true, quota: null },
    { id: "a2", email: "pool", isMain: false, paused: false, hasCredential: true, quota: null },
  ];
  bulkPausedAccountIds = ["__main__"];
  bulkResponseActiveId = "a2";
  const seen = await mountController();
  let releaseReload!: () => void;
  nextAccountsResponseGate = new Promise<void>(resolve => { releaseReload = resolve; });

  await act(async () => {
    expect(await seen.current!.pauseExhaustedAccounts()).toEqual({ ok: true, pausedCount: 1 });
  });

  expect(seen.current!.accounts.find(account => account.isMain)?.id).toBe("a1");
  expect(seen.current!.accounts.find(account => account.isMain)?.paused).toBe(true);
  expect(seen.current!.activeId).toBe("a2");

  await act(async () => {
    releaseReload();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  expect(seen.current!.accounts.find(account => account.isMain)?.paused).toBe(true);
  expect(seen.current!.activeId).toBe("a2");
});

test("two pause holders both have to release before polling resumes", async () => {
  const seen = await mountController();
  const controller = seen.current!;

  let first: ReturnType<CodexAccountPoolController["pauseRefresh"]>;
  let second: ReturnType<CodexAccountPoolController["pauseRefresh"]>;
  await act(async () => { first = controller.pauseRefresh(); });
  await act(async () => { second = controller.pauseRefresh(); });

  const afterPause = calls.length;
  // Releasing one lease must not resume: a reason-string Set would fail here.
  await act(async () => { seen.current!.resumeRefresh(first!); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(calls.length).toBe(afterPause);

  // Releasing the last lease must not retro-fire a load either.
  await act(async () => { seen.current!.resumeRefresh(second!); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(calls.length).toBe(afterPause);

  // An unknown token is harmless.
  await act(async () => { seen.current!.resumeRefresh({} as typeof first); });
  expect(calls.length).toBe(afterPause);
});

test("the last genuine threshold read is cached for surfaces that mount later", async () => {
  const seen = await mountController();
  // A real /active read succeeded during the initial load.
  expect(seen.current!.readLastThreshold()).toBe(80);
});

test("subscribing never fabricates a server read", async () => {
  const seen = await mountController();
  const received: unknown[] = [];

  await act(async () => {
    seen.current!.subscribeLoadObserver({
      beginActiveRead: () => 1,
      acceptActiveRead: (value) => { received.push(value); },
      rejectActiveRead: () => {},
    });
  });

  // Subscribing stays silent: useCodexAutoSwitch treats every acceptActiveRead as
  // belonging to a read that genuinely started at that revision, so synthesising one
  // corrupts its editing/saving disposition and overwrites drafts. Late surfaces seed
  // themselves through readLastThreshold() + hydrateServerValue() instead, which applies
  // only while uninitialized.
  expect(received).toEqual([]);

  // And a real load does reach the subscriber.
  await act(async () => { await seen.current!.load(); });
  expect(received).toEqual([{ activeCodexAccountId: null, autoSwitchThreshold: 80 }]);
});

test("a mutation updates the one shared controller state", async () => {
  const seen = await mountController();
  accounts = [
    { id: "a1", email: "account-one", isMain: true, hasCredential: true, quota: null },
    { id: "a2", email: "account-two", isMain: false, hasCredential: true, quota: null },
  ];

  await act(async () => { await seen.current!.switchAccount("a2"); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(calls).toContain("PUT codex-auth/active");
  expect(seen.current!.activeId).toBe("a2");
  // The reconciliation reload landed on the same controller instance.
  expect(seen.current!.accounts.map(a => a.id)).toEqual(["a1", "a2"]);
});

/**
 * WP2 (260730_gui_hydration_loading_unify/010): the forced quota refresh keeps rows on screen and
 * deliberately does not touch `loadState`, so `refreshing` is the only signal a surface can use to
 * show that a slow wait is in progress. It counts requests rather than tracking one, because the
 * initial load, the 30s poll and an explicit action can overlap.
 */
test("refreshing stays true until the newest load settles, not the first", async () => {
  const seen = await mountController();
  expect(seen.current!.refreshing).toBe(false);
  expect(seen.current!.initialLoading).toBe(false);

  let releaseForced!: () => void;
  nextAccountsResponseGate = new Promise<void>(resolve => { releaseForced = resolve; });

  // Start the slow forced refresh, then let a plain load finish underneath it.
  let forced: Promise<boolean>;
  await act(async () => {
    forced = seen.current!.load(true);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(seen.current!.refreshing).toBe(true);
  // The forced path must not blank the surface.
  expect(seen.current!.loadState).toBe("ready");
  expect(seen.current!.accounts.length).toBe(1);

  await act(async () => { await seen.current!.load(); });
  // An older/other load settling must not clear the indicator while the forced one is in flight.
  expect(seen.current!.refreshing).toBe(true);

  await act(async () => { releaseForced(); await forced!; });
  expect(seen.current!.refreshing).toBe(false);
});

test("a first attempt that fails settles initialLoading instead of hanging on the skeleton", async () => {
  // Install the failing router BEFORE the first mount: the point is a cold failure, and a
  // controller that already succeeded keeps its rows by design.
  const failing = async (url: string, init?: RequestInit) => {
    const path = String(url).split("/api/")[1] ?? String(url);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.startsWith("codex-auth/accounts")) return { ok: false, status: 500 } as unknown as Response;
    if (path.startsWith("codex-auth/active")) {
      return { ok: true, json: async () => ({ activeCodexAccountId: null, autoSwitchThreshold: threshold }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: failing });

  const seen: { current: CodexAccountPoolController | null } = { current: null };
  function Probe() {
    // A fresh apiBase keeps this cold: the module-level last-good map is keyed by it.
    seen.current = useCodexAccountPool(`cold-${Date.now()}`, true);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Probe />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  // The attempt settled, so the surface shows its failure rather than an endless skeleton.
  expect(seen.current!.initialLoading).toBe(false);
  expect(seen.current!.refreshing).toBe(false);
  expect(seen.current!.loadState).toBe("error");
});
