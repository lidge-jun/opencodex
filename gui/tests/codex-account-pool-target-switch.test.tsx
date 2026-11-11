import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { useCodexAccountPool, type CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";

/**
 * #8438: the pool clears the previous target's rows while rendering, but the generation bump
 * that fences late reads stayed in a passive effect. A read issued for A that settled between
 * B's commit and that flush still matched the generation, so it repainted A's rows, active id
 * and ready state under B. The relay re-pair (same apiBase, hub-a -> hub-b) is the case that
 * exposed it.
 *
 * The probe releases A from a layout effect of B's commit, which is the window itself: the
 * response continuation is a microtask that runs after the layout phase and before passive
 * effects. A flushSync render would close the window and prove nothing.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let seen: CodexAccountPoolController | null = null;
let childReads: unknown[] = [];

function row(id: string) {
  return { id, email: `${id}@example.test`, isMain: false, paused: false, priority: 0, hasCredential: true, quota: null };
}

function relay(apiBase: string, origin: string) {
  const base = standaloneApiTargets(apiBase);
  return {
    ...base,
    connected: true,
    shared: { ...base.shared, baseUrl: apiBase, serverOrigin: origin, transport: "relay" as const },
    apiKeyId: "fixture-key",
    relayTargetCheck: "expected-target-v1" as const,
  };
}

/**
 * One held-open read per plan entry; both /accounts and /active settle together.
 * Paths in heldPuts hold their first two PUTs so a test can park one per target.
 */
function serve(plan: { id: string; accounts: string[]; threshold?: number }[], heldPuts: string[] = []) {
  const releases = plan.map(() => () => {});
  const gates = plan.map((_, index) => new Promise<void>(resolve => { releases[index] = resolve; }));
  const putGates = new Map<string, Promise<void>[]>();
  const putReleases = new Map<string, (() => void)[]>();
  for (const path of heldPuts) {
    const pathGates: Promise<void>[] = [];
    const pathReleases: (() => void)[] = [];
    for (let index = 0; index < 2; index += 1) {
      pathGates.push(new Promise<void>(resolve => { pathReleases.push(resolve); }));
    }
    putGates.set(path, pathGates);
    putReleases.set(path, pathReleases);
  }
  const putCalls = new Map<string, number>();
  let reads = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;
      if (method === "PUT") {
        const index = putCalls.get(path) ?? 0;
        putCalls.set(path, index + 1);
        const gate = putGates.get(path)?.[index];
        if (gate) await gate;
        if (path.endsWith("/api/codex-auth/active")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { accountId?: string | null };
          return Response.json({ activeCodexAccountId: body.accountId ?? null });
        }
        return Response.json({});
      }
      if (url.includes("/api/codex-auth/accounts")) {
        const index = reads++;
        const payload = plan[index];
        if (!payload) return Response.json({ accounts: [], activeCodexAccountId: null });
        await gates[index];
        return Response.json({ accounts: payload.accounts.map(row), activeCodexAccountId: payload.id });
      }
      if (url.includes("/api/codex-auth/active")) {
        const payload = plan[Math.max(0, reads - 1)];
        if (!payload) return Response.json({ activeCodexAccountId: null });
        await gates[Math.max(0, reads - 1)];
        return Response.json({
          activeCodexAccountId: payload.id,
          pinnedAccountId: null,
          ...(payload.threshold === undefined ? {} : { autoSwitchThreshold: payload.threshold }),
        });
      }
      if (url.includes("/api/usage")) return Response.json({ providers: [], models: [] });
      return Response.json({});
    },
  });
  return {
    release: (index: number) => { releases[index]?.(); },
    releasePut: (path: string, index: number) => { putReleases.get(path)?.[index]?.(); },
    reads: () => reads,
  };
}

function actEnvironment(value: boolean) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value });
}

function Probe({ targetKey, onSwitch }: { targetKey: string; onSwitch?: () => void }) {
  const controller = useCodexAccountPool("/same", true, targetKey);
  const last = useRef(targetKey);
  useLayoutEffect(() => {
    if (last.current === targetKey) return;
    last.current = targetKey;
    onSwitch?.();
  });
  useLayoutEffect(() => { seen = controller; });
  return <ChildProbe read={controller.readLastActive} />;
}

/** A descendant reads before the pool's own layout effect runs on the new target's commit. */
function ChildProbe({ read }: { read: () => unknown }) {
  useLayoutEffect(() => { childReads.push(read()); });
  return null;
}

async function mount(targetKey: string) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Probe targetKey={targetKey} />);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

/** Render the next target outside act so its passive reset effect stays pending. */
async function switchTarget(targetKey: string, releasePrevious: () => void) {
  configureApiTargets(relay("/same", targetKey));
  actEnvironment(false);
  try {
    root!.render(<Probe targetKey={targetKey} onSwitch={releasePrevious} />);
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    actEnvironment(true);
  }
}

function ids(): string[] {
  return seen!.accounts.map(account => account.id);
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  originalFetch = globalThis.fetch;
  seen = null;
  childReads = [];
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  configureApiTargets(standaloneApiTargets(""));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM?.close?.();
});

test("a late roster read from the previous target cannot repaint the new one", async () => {
  const server = serve([
    { id: "a1", accounts: ["a1"] },
    { id: "b1", accounts: ["b1"] },
  ]);
  configureApiTargets(relay("/same", "hub-a1"));
  await mount("hub-a1");
  expect(server.reads()).toBe(1);

  await switchTarget("hub-b1", () => server.release(0));

  expect(ids()).toEqual([]);
  expect(seen!.activeId).toBeNull();
  expect(seen!.loadState).toBe("loading");
  expect(seen!.initialLoading).toBe(true);
  expect(seen!.refreshFailed).toBe(false);

  await act(async () => { server.release(1); await new Promise(resolve => setTimeout(resolve, 10)); });

  expect(ids()).toEqual(["b1"]);
  expect(seen!.activeId).toBe("b1");
  expect(seen!.loadState).toBe("ready");
  expect(seen!.initialLoading).toBe(false);
  expect(seen!.refreshing).toBe(false);
});

test("a read from an earlier visit to the same target cannot repaint it after a round trip", async () => {
  const server = serve([
    { id: "a2-old", accounts: ["a2-old"] },
    { id: "b2", accounts: ["b2"] },
    { id: "a2-new", accounts: ["a2-new"] },
  ]);
  configureApiTargets(relay("/same", "hub-a2"));
  await mount("hub-a2");
  expect(server.reads()).toBe(1);

  await switchTarget("hub-b2", () => {});
  expect(ids()).toEqual([]);
  await act(async () => { server.release(1); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(ids()).toEqual(["b2"]);

  // Back to A while its first read is still held. The earlier switch's generation bump already
  // supersedes that read; this holds the round trip to "the new visit's rows, never the old
  // visit's", so a fence keyed on the seed key alone cannot resurrect them later.
  await switchTarget("hub-a2", () => server.release(0));
  expect(ids()).toEqual([]);
  expect(seen!.activeId).toBeNull();
  expect(seen!.loadState).toBe("loading");

  await act(async () => { server.release(2); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(ids()).toEqual(["a2-new"]);
  expect(seen!.activeId).toBe("a2-new");
  expect(seen!.loadState).toBe("ready");
});

test("an old visit's read must not give back the new visit's in-flight count", async () => {
  const server = serve([
    { id: "a4-old", accounts: ["a4-old"] },
    { id: "b4", accounts: ["b4"] },
    { id: "a4-new", accounts: ["a4-new"] },
  ]);
  configureApiTargets(relay("/same", "hub-a4"));
  await mount("hub-a4");
  expect(server.reads()).toBe(1);

  await switchTarget("hub-b4", () => {});
  await act(async () => { server.release(1); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(ids()).toEqual(["b4"]);

  // Back to A with its first read still held. The new A read starts and stays in flight, so the
  // surface is refreshing again.
  await switchTarget("hub-a4", () => {});
  expect(server.reads()).toBe(3);
  expect(seen!.refreshing).toBe(true);

  // The old A read settles now. The reset discarded its increment, so its completion must not
  // clear the new A read's count.
  await act(async () => { server.release(0); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(ids()).toEqual([]);
  expect(seen!.refreshing).toBe(true);

  await act(async () => { server.release(2); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(ids()).toEqual(["a4-new"]);
  expect(seen!.refreshing).toBe(false);
});

test("a superseded read on the same target still releases its own in-flight count", async () => {
  const server = serve([
    { id: "c5", accounts: ["c5"] },
    { id: "c5-first", accounts: ["c5-first"] },
    { id: "c5-second", accounts: ["c5-second"] },
  ]);
  configureApiTargets(relay("/same", "hub-c5"));
  await mount("hub-c5");
  await act(async () => { server.release(0); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(ids()).toEqual(["c5"]);
  expect(seen!.refreshing).toBe(false);

  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  await act(async () => {
    first = seen!.load();
    second = seen!.load();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(seen!.refreshing).toBe(true);

  // The older read is superseded for state, but its increment is still the counter's.
  await act(async () => { server.release(1); await first; });
  expect(seen!.refreshing).toBe(true);

  await act(async () => { server.release(2); await second; });
  expect(seen!.refreshing).toBe(false);
  expect(ids()).toEqual(["c5-second"]);
});

test("a pending switch on the old target cannot suppress the new target's active id", async () => {
  const server = serve([
    { id: "a6", accounts: ["a1", "a2"], threshold: 42 },
    { id: "a2", accounts: ["a1", "a2"], threshold: 42 },
    { id: "b6", accounts: ["b6"], threshold: 55 },
  ]);
  configureApiTargets(relay("/same", "hub-a6"));
  await mount("hub-a6");
  await act(async () => { server.release(0); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(seen!.activeId).toBe("a6");

  // The switch is accepted on A; its reconcile /active read stays in flight.
  await act(async () => { await seen!.switchAccount("a2"); });
  expect(seen!.activeId).toBe("a2");
  expect(server.reads()).toBe(2);

  // B commits while that reconcile is still held. The pending marker exists to hold an
  // accepted switch across one read; on B it would spend that allowance on b6 and leave the
  // active id empty until the next poll.
  await switchTarget("hub-b6", () => {});
  await act(async () => { server.release(2); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(ids()).toEqual(["b6"]);
  expect(seen!.activeId).toBe("b6");
});

test("the previous target's last /active payload does not seed the new one", async () => {
  const server = serve([
    { id: "a7", accounts: ["a7"], threshold: 42 },
    { id: "a7", accounts: ["a7"], threshold: 42 },
    { id: "b7", accounts: ["b7"], threshold: 55 },
  ]);
  configureApiTargets(relay("/same", "hub-a7"));
  await mount("hub-a7");
  await act(async () => { server.release(0); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(seen!.readLastThreshold()).toBe(42);

  // A held reconcile keeps the pool busy across the switch, the way a slow /active would.
  await act(async () => { await seen!.switchAccount("a7"); });
  await switchTarget("hub-b7", () => {});

  // Neither the public reads nor a descendant that reads before the pool's own layout effect
  // may see A's payload under B.
  expect(seen!.readLastActive()).toBeUndefined();
  expect(seen!.readLastThreshold()).toBeUndefined();
  expect(childReads.at(-1)).toBeUndefined();

  await act(async () => { server.release(2); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(seen!.readLastThreshold()).toBe(55);
});

/**
 * Every gate the pool keeps. The A and B values are deliberately identical: the account id
 * cannot tell the two leases apart, so only the lease identity can release the right one.
 */
const mutationGates = [
  {
    name: "switch",
    path: "/same/api/codex-auth/active",
    busy: "switchingId",
    start: (controller: CodexAccountPoolController, id: string) => controller.switchAccount(id),
    a: "x9",
    b: "x9",
    idle: null,
  },
  {
    name: "pause",
    path: "/same/api/codex-auth/accounts/pause",
    busy: "pauseUpdatingId",
    start: (controller: CodexAccountPoolController, id: string) => controller.setAccountPaused(id, true),
    a: "x9",
    b: "x9",
    idle: null,
  },
  {
    name: "priority",
    path: "/same/api/codex-auth/accounts/priority",
    busy: "priorityUpdatingId",
    start: (controller: CodexAccountPoolController, id: string) => controller.setAccountPriority(id, 3),
    a: "x9",
    b: "x9",
    idle: null,
  },
  {
    name: "auto-switch",
    path: "/same/api/codex-auth/auto-switch",
    busy: "autoSwitchUpdatingId",
    start: (controller: CodexAccountPoolController, id: string) => controller.setAccountAutoSwitchThreshold(id, 50),
    a: "x9",
    b: "x9",
    idle: null,
  },
  {
    name: "credits (account)",
    path: "/same/api/codex-auth/accounts/credits",
    busy: "creditsAfterLimitUpdatingId",
    start: (controller: CodexAccountPoolController, id: string) => controller.setAccountCreditsAfterLimit(id, true),
    a: "x9",
    b: "x9",
    idle: null,
  },
  {
    name: "credits (all)",
    path: "/same/api/codex-auth/accounts/credits",
    busy: "creditsAfterLimitUpdatingId",
    start: (controller: CodexAccountPoolController) => controller.setAllCreditsAfterLimit(true),
    a: "*",
    b: "*",
    idle: null,
  },
  {
    name: "pause-exhausted",
    path: "/same/api/codex-auth/accounts/pause-exhausted",
    busy: "pausingExhausted",
    start: (controller: CodexAccountPoolController) => controller.pauseExhaustedAccounts(),
    a: true,
    b: true,
    idle: false,
  },
] as const;

for (const mutation of mutationGates) {
  test(`a held ${mutation.name} on the old target neither blocks nor paints on the new one`, async () => {
    const server = serve([
      { id: "a8", accounts: ["a8", "x9"] },
      { id: "b8", accounts: ["b8", "x9"] },
    ], [mutation.path]);
    configureApiTargets(relay("/same", "hub-a8"));
    await mount("hub-a8");
    await act(async () => { server.release(0); await new Promise(resolve => setTimeout(resolve, 10)); });

    let first!: Promise<unknown>;
    await act(async () => {
      first = mutation.start(seen!, "x9");
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(seen![mutation.busy]).toBe(mutation.a);

    // Same target: the gate still serializes, so the refactor did not open it up.
    await act(async () => {
      expect(await mutation.start(seen!, "x9")).toEqual({ ok: false, reason: "busy" });
    });

    // The target moves while A's write is still held. B paints no A busy state.
    await switchTarget("hub-b8", () => {});
    await act(async () => { server.release(1); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(seen![mutation.busy]).toBe(mutation.idle);

    // B's own write starts: A's lease is from another epoch and must not answer "busy".
    let second!: Promise<unknown>;
    await act(async () => {
      second = mutation.start(seen!, "x9");
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(seen![mutation.busy]).toBe(mutation.b);

    // A's completion releases only A's lease, so B's gate and busy state survive it.
    await act(async () => { server.releasePut(mutation.path, 0); await first; });
    expect(seen![mutation.busy]).toBe(mutation.b);

    await act(async () => { server.releasePut(mutation.path, 1); await second; });
    expect(seen![mutation.busy]).toBe(mutation.idle);
  });
}
