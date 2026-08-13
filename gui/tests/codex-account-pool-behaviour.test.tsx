import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
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
let usageAccounts: unknown[] = [];
let threshold = 80;
let nextAccountsResponseGate: Promise<void> | null = null;
let pauseResponseActiveId: string | null = null;
let bulkPausedAccountIds: string[] = ["a2"];
let bulkResponseActiveId: string | null = null;
let priorityResponseOk = true;
let nextPriorityResponseGate: Promise<void> | null = null;
let nextPauseResponseGate: Promise<void> | null = null;
let nextActiveResponseGate: Promise<void> | null = null;
let nextActivePutGate: Promise<void> | null = null;
let activePinned = false;
let activePinnedAccountId: string | null = null;
let omitPinnedAccountId = false;
let activeGetId: string | null = null;
let deleteCatalogRefreshPending = false;

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
  priorityResponseOk = true;
  nextPriorityResponseGate = null;
  nextPauseResponseGate = null;
  nextActiveResponseGate = null;
  nextActivePutGate = null;
  activePinned = false;
  activePinnedAccountId = null;
  omitPinnedAccountId = false;
  activeGetId = null;
  deleteCatalogRefreshPending = false;
  accounts = [{ id: "a1", email: "account-one", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null }];
  usageAccounts = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const path = String(url).split("/api/")[1] ?? String(url);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.startsWith("usage?")) {
        return { ok: true, json: async () => ({ accounts: usageAccounts }) } as unknown as Response;
      }
      if (path === "codex-auth/accounts/priority") {
        const gate = nextPriorityResponseGate;
        nextPriorityResponseGate = null;
        if (gate) await gate;
        const body = JSON.parse(String(init?.body)) as { id: string; priority: number | null };
        if (!priorityResponseOk) return { ok: false, json: async () => ({}) } as unknown as Response;
        const stored = body.priority ?? 0;
        accounts = accounts.map(account => (
          typeof account === "object" && account !== null && "id" in account
            && (account.id === body.id || (body.id === "__main__" && "isMain" in account && account.isMain === true))
            ? { ...account, priority: stored }
            : account
        ));
        activePinnedAccountId = null;
        return { ok: true, json: async () => ({ ok: true, id: body.id, priority: stored }) } as unknown as Response;
      }
      if (path === "codex-auth/accounts/pause") {
        const gate = nextPauseResponseGate;
        nextPauseResponseGate = null;
        if (gate) await gate;
        const body = JSON.parse(String(init?.body)) as { id: string; paused: boolean };
        accounts = accounts.map(account => (
          typeof account === "object" && account !== null && "id" in account
            && (account.id === body.id || (body.id === "__main__" && "isMain" in account && account.isMain === true))
            ? { ...account, paused: body.paused }
            : account
        ));
        if (body.paused && activePinnedAccountId === body.id) activePinnedAccountId = null;
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
        if (activePinnedAccountId && pausedIds.has(activePinnedAccountId)) activePinnedAccountId = null;
        return {
          ok: true,
          json: async () => ({
            pausedAccountIds: bulkPausedAccountIds,
            pausedCount: bulkPausedAccountIds.length,
            activeCodexAccountId: bulkResponseActiveId,
          }),
        } as unknown as Response;
      }
      if (path.startsWith("codex-auth/accounts") && init?.method === "DELETE") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            catalogRefreshPending: deleteCatalogRefreshPending,
            privateDetail: "private-delete-detail",
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
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { accountId: string | null };
          const putGate = nextActivePutGate;
          nextActivePutGate = null;
          if (putGate) await putGate;
          activePinnedAccountId = body.accountId;
          return {
            ok: true,
            json: async () => ({ activeCodexAccountId: body.accountId }),
          } as unknown as Response;
        }
        const gate = nextActiveResponseGate;
        nextActiveResponseGate = null;
        if (gate) await gate;
        return {
          ok: true,
          json: async () => ({
            activeCodexAccountId: activeGetId,
            pinned: activePinned,
            ...(omitPinnedAccountId ? {} : { pinnedAccountId: activePinnedAccountId }),
            autoSwitchThreshold: threshold,
          }),
        } as unknown as Response;
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
  clearClientResourceStoresForTests();
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

test("the controller joins 30-day usage to accounts by the displayed log label", async () => {
  accounts = [
    { id: "main", email: "main", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
    { id: "pool", email: "pool", logLabel: "pabc123", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
  ];
  usageAccounts = [
    { accountLogLabel: "main", totalTokens: 11, estimatedCostUsd: 0.01, usageCoverageRatio: 1 },
    { accountLogLabel: "pabc123", totalTokens: 22, estimatedCostUsd: 0.02, usageCoverageRatio: 0.5 },
    { accountLogLabel: "legacy-ambiguous", totalTokens: 999, estimatedCostUsd: 9, usageCoverageRatio: 1 },
  ];

  const seen = await mountController();
  expect(seen.current!.accounts.map(account => ({
    label: account.logLabel,
    tokens: account.usage30d?.totalTokens,
  }))).toEqual([
    { label: "main", tokens: 11 },
    { label: "pabc123", tokens: 22 },
  ]);
});

test("account reloads do not refetch the independently polled usage summary", async () => {
  const seen = await mountController();
  expect(calls.filter(call => call.startsWith("GET usage?")).length).toBe(1);

  await act(async () => { await seen.current!.load(); });

  expect(calls.filter(call => call.startsWith("GET usage?")).length).toBe(1);
  expect(calls.filter(call => call.includes("codex-auth/accounts")).length).toBe(2);
});

test("an inert controller issues no requests at all", async () => {
  await mountController(false);
  expect(calls.length).toBe(0);
});

test("account removal returns only the public catalog completion flag", async () => {
  deleteCatalogRefreshPending = true;
  const seen = await mountController();

  await act(async () => {
    expect(await seen.current!.removeAccount("a1")).toEqual({
      ok: true,
      catalogRefreshPending: true,
    });
  });
  expect(calls).toContain("DELETE codex-auth/accounts?id=a1");
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
    { id: "a1", email: "main", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "next", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
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
    { id: "a1", email: "main", isMain: true, paused: true, priority: 0, hasCredential: true, needsReauth: true, quota: null },
    { id: "a2", email: "next", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
  ];
  const seen = await mountController();

  expect(seen.current!.activeId).toBeNull();
  expect(seen.current!.activeNeedsReauth).toBe(false);
});

test("bulk pausing writes one endpoint and updates every returned account", async () => {
  accounts = [
    { id: "a1", email: "account-one", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "account-two", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
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
    { id: "a1", email: "main", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "pool", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
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
  expect(received).toEqual([{
    activeCodexAccountId: null,
    pinned: false,
    pinnedAccountId: null,
    autoSwitchThreshold: 80,
  }]);
});

test("a confirmed selection-order save updates the row before the reload lands", async () => {
  accounts = [
    { id: "a1", email: "main", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "pool", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
  ];
  const seen = await mountController();
  let releaseReload!: () => void;
  nextAccountsResponseGate = new Promise<void>(resolve => { releaseReload = resolve; });

  await act(async () => {
    expect(await seen.current!.setAccountPriority("a2", 2)).toEqual({ ok: true });
  });

  expect(calls).toContain("PUT codex-auth/accounts/priority");
  expect(seen.current!.accounts.find(account => account.id === "a2")?.priority).toBe(2);
  expect(seen.current!.priorityUpdatingId).toBeNull();

  await act(async () => {
    releaseReload();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  // The reload confirms the same value rather than reverting it.
  expect(seen.current!.accounts.find(account => account.id === "a2")?.priority).toBe(2);
});

test("an accepted selection-order write clears the pin before reconciliation lands", async () => {
  activePinnedAccountId = "a1";
  const seen = await mountController();
  expect(seen.current!.activePinnedId).toBe("a1");
  let releaseActive!: () => void;
  nextActiveResponseGate = new Promise<void>(resolve => { releaseActive = resolve; });

  await act(async () => {
    expect(await seen.current!.setAccountPriority("a1", 2)).toEqual({ ok: true });
  });
  expect(seen.current!.activePinnedId).toBeNull();

  await act(async () => {
    releaseActive();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});

test("an order write and a manual switch refuse to overlap in either direction", async () => {
  // Both PUTs move the pin, in opposite directions, and each applies its edge
  // optimistically. Response order is not request order, so overlapping them can leave
  // the client on the inverse of the server's final pin until a reload corrects it.
  accounts = [
    { id: "a1", email: "main", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "pool", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
  ];
  const seen = await mountController();

  let releasePriority!: () => void;
  nextPriorityResponseGate = new Promise<void>(resolve => { releasePriority = resolve; });
  let priorityResult: unknown;
  let switchDuringOrder: unknown;
  await act(async () => {
    const orderWrite = seen.current!.setAccountPriority("a2", 2).then(r => { priorityResult = r; });
    switchDuringOrder = await seen.current!.switchAccount("a1");
    releasePriority();
    await orderWrite;
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(switchDuringOrder).toEqual({ ok: false, reason: "busy" });
  expect(priorityResult).toEqual({ ok: true });

  let releaseSwitch!: () => void;
  nextActivePutGate = new Promise<void>(resolve => { releaseSwitch = resolve; });
  let switchResult: unknown;
  let orderDuringSwitch: unknown;
  await act(async () => {
    const switchWrite = seen.current!.switchAccount("a2").then(r => { switchResult = r; });
    orderDuringSwitch = await seen.current!.setAccountPriority("a2", 1);
    releaseSwitch();
    await switchWrite;
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(orderDuringSwitch).toEqual({ ok: false, reason: "busy" });
  expect(switchResult).toEqual({ ok: true, activeId: "a2" });
  // The refused order write must not have moved the row either.
  expect(seen.current!.accounts.find(account => account.id === "a2")?.priority).toBe(2);
});

test("an accepted manual switch moves the pin before reconciliation lands", async () => {
  activePinnedAccountId = "a1";
  const seen = await mountController();
  let releaseActive!: () => void;
  nextActiveResponseGate = new Promise<void>(resolve => { releaseActive = resolve; });

  await act(async () => {
    expect(await seen.current!.switchAccount("a2")).toEqual({ ok: true, activeId: "a2" });
  });
  expect(seen.current!.activePinnedId).toBe("a2");

  await act(async () => {
    releaseActive();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});

test("the main sentinel writes through to its distinct account row", async () => {
  const seen = await mountController();

  await act(async () => {
    expect(await seen.current!.setAccountPriority("__main__", -1)).toEqual({ ok: true });
  });

  expect(seen.current!.accounts.find(account => account.isMain)?.id).toBe("a1");
  expect(seen.current!.accounts.find(account => account.isMain)?.priority).toBe(-1);
});

test("null resets an account to the default order", async () => {
  accounts = [{ id: "a1", email: "main", isMain: true, paused: false, priority: 2, hasCredential: true, quota: null }];
  const seen = await mountController();
  expect(seen.current!.accounts[0]?.priority).toBe(2);

  await act(async () => {
    expect(await seen.current!.setAccountPriority("a1", null)).toEqual({ ok: true });
  });

  expect(seen.current!.accounts[0]?.priority).toBe(0);
});

test("a rejected save snaps back to the last confirmed order", async () => {
  accounts = [{ id: "a1", email: "main", isMain: true, paused: false, priority: 1, hasCredential: true, quota: null }];
  priorityResponseOk = false;
  const seen = await mountController();

  await act(async () => {
    expect(await seen.current!.setAccountPriority("a1", -2)).toEqual({ ok: false, reason: "request" });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(seen.current!.accounts[0]?.priority).toBe(1);
  expect(seen.current!.priorityUpdatingId).toBeNull();
});

test("an in-flight order save does not block a pause on another account", async () => {
  accounts = [
    { id: "a1", email: "main", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "pool", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
  ];
  const seen = await mountController();

  let releasePriority!: () => void;
  nextPriorityResponseGate = new Promise<void>(resolve => { releasePriority = resolve; });

  let priorityResult: unknown;
  let pauseResult: unknown;
  await act(async () => {
    const priorityWrite = seen.current!.setAccountPriority("a2", 2).then(r => { priorityResult = r; });
    // With one shared mutation ref this comes back rejected as "busy".
    pauseResult = await seen.current!.setAccountPaused("a1", true);
    releasePriority();
    await priorityWrite;
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(pauseResult).toEqual({ ok: true });
  expect(priorityResult).toEqual({ ok: true });
  expect(seen.current!.accounts.find(account => account.id === "a1")?.paused).toBe(true);
  expect(seen.current!.accounts.find(account => account.id === "a2")?.priority).toBe(2);
});

test("an in-flight pause does not block an order save on another account", async () => {
  accounts = [
    { id: "a1", email: "main", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "pool", isMain: false, paused: false, priority: 0, hasCredential: true, quota: null },
  ];
  const seen = await mountController();

  let releasePause!: () => void;
  nextPauseResponseGate = new Promise<void>(resolve => { releasePause = resolve; });

  let pauseResult: unknown;
  let priorityResult: unknown;
  await act(async () => {
    const pauseWrite = seen.current!.setAccountPaused("a1", true).then(r => { pauseResult = r; });
    // The converse of the case above: each write owns its own in-flight ref, so neither
    // direction can starve the other.
    priorityResult = await seen.current!.setAccountPriority("a2", 2);
    releasePause();
    await pauseWrite;
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(priorityResult).toEqual({ ok: true });
  expect(pauseResult).toEqual({ ok: true });
  expect(seen.current!.accounts.find(account => account.id === "a1")?.paused).toBe(true);
  expect(seen.current!.accounts.find(account => account.id === "a2")?.priority).toBe(2);
});

test("a second order save while one is in flight is rejected as busy", async () => {
  const seen = await mountController();
  let releasePriority!: () => void;
  nextPriorityResponseGate = new Promise<void>(resolve => { releasePriority = resolve; });

  await act(async () => {
    const first = seen.current!.setAccountPriority("a1", 2);
    expect(await seen.current!.setAccountPriority("a1", 1)).toEqual({ ok: false, reason: "busy" });
    releasePriority();
    expect(await first).toEqual({ ok: true });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(seen.current!.accounts[0]?.priority).toBe(2);
});

// The controller tracks the pinned ACCOUNT, not /active's `pinned` boolean. That boolean
// answers whether routing is currently on the pinned account, which goes false the moment
// round-robin serves a same-tier sibling even though the pin is still suppressing every
// higher tier — so the badge reads the id and the boolean has no consumer here.
test("the pinned account id follows /active on each load, ignoring the pinned flag", async () => {
  const seen = await mountController();
  expect(seen.current!.activePinnedId).toBeNull();

  activePinnedAccountId = "a1";
  activePinned = false;
  await act(async () => { await seen.current!.load(); });
  expect(seen.current!.activePinnedId).toBe("a1");

  // Releasing the pin clears it again: this is server state, not a local latch.
  activePinnedAccountId = null;
  activePinned = true;
  await act(async () => { await seen.current!.load(); });
  expect(seen.current!.activePinnedId).toBeNull();
});

test("an /active payload with no pinned account id reads as no pin", async () => {
  // An older build's response omits the field entirely; that must not put the string
  // "undefined" on a card, and must not latch a pin that no longer exists.
  const seen = await mountController();
  activePinnedAccountId = "a1";
  await act(async () => { await seen.current!.load(); });
  expect(seen.current!.activePinnedId).toBe("a1");

  omitPinnedAccountId = true;
  await act(async () => { await seen.current!.load(); });
  expect(seen.current!.activePinnedId).toBeNull();
});

test("an account payload without a selection order reads as the default", async () => {
  accounts = [{ id: "a1", email: "main", isMain: true, paused: false, hasCredential: true, quota: null }];
  const seen = await mountController();
  expect(seen.current!.accounts[0]?.priority).toBe(0);
});

test("an order write retires the switch's pending reconciliation", async () => {
  accounts = [
    { id: "a1", email: "account-one", isMain: true, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "account-two", isMain: false, priority: 0, hasCredential: true, quota: null },
  ];
  const seen = await mountController();

  // The switch is accepted, so the controller holds "a2" until a matching read arrives.
  await act(async () => { await seen.current!.switchAccount("a2"); });
  expect(seen.current!.activeId).toBe("a2");

  // Routing has since moved on -- the order write releases the pin that was capping the
  // tier, so the account the switch named is no longer the one the server reports.
  activeGetId = "a1";
  await act(async () => { await seen.current!.setAccountPriority("a1", 2); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  // Every read after the switch disagrees with the pending marker, so leaving it armed
  // strands activeId on "a2" for the rest of the session: nothing else retires it.
  expect(seen.current!.activeId).toBe("a1");

  // And it stays reconciled -- the marker is gone, not merely satisfied once.
  await act(async () => { await seen.current!.load(); });
  expect(seen.current!.activeId).toBe("a1");
});

test("a mutation updates the one shared controller state", async () => {
  const seen = await mountController();
  accounts = [
    { id: "a1", email: "account-one", isMain: true, priority: 0, hasCredential: true, quota: null },
    { id: "a2", email: "account-two", isMain: false, priority: 0, hasCredential: true, quota: null },
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
