import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useLayoutEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { useProviderAccountPools } from "../src/hooks/useProviderAccountPools";

/**
 * #8438: the provider pool cleared the previous target's rows in a passive effect, so a
 * read issued for A that settled between B's commit and that flush still repainted A's
 * emails, key labels and quota under B. The relay re-pair (same apiBase, hub-a -> hub-b)
 * is the case that exposed it.
 *
 * The probe releases A from a layout effect of B's commit, which is the window itself:
 * the response continuation is a microtask that runs after the layout phase and before
 * passive effects. A flushSync render would close the window and prove nothing.
 */

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let root: Root | null = null;
let host: HTMLElement;
let originalFetch: typeof globalThis.fetch;
let pools!: ReturnType<typeof useProviderAccountPools>;
let snapshots: Array<{ accounts: string[]; keys: string[]; load?: string }> = [];
let notified: string[] = [];
let passiveSettled: (() => void) | null = null;

type Row = {
  id: string;
  email?: string;
  masked?: string;
  active?: boolean;
  quotaMode?: "probe" | "passive" | "unsupported";
  quota?: { fiveHourPercent: number; weeklyPercent: number; updatedAt: number };
};
type Payload = { id: string; rows: Row[]; hold?: boolean; status?: number };
type Kind = "oauth" | "keys" | "oauthQuota" | "keyQuota";

const reading = { fiveHourPercent: 21, weeklyPercent: 34, updatedAt: 1_700_000_000_000 };

function row(id: string, extra: Partial<Row> = {}): Row {
  return { id, email: `${id}@example.test`, active: true, ...extra };
}

function key(id: string, extra: Partial<Row> = {}): Row {
  return { id, masked: `sk-${id}`, active: true, ...extra };
}

function gate(hold: boolean): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  if (!hold) resolve();
  return { promise, resolve };
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

function serve(plans: {
  oauth?: Payload[];
  keys?: Payload[];
  oauthQuota?: Payload[];
  keyQuota?: Payload[];
  put?: { hold?: boolean; status?: number; body?: unknown };
} = {}) {
  const gates = {
    oauth: (plans.oauth ?? []).map(entry => gate(entry.hold === true)),
    keys: (plans.keys ?? []).map(entry => gate(entry.hold === true)),
    oauthQuota: (plans.oauthQuota ?? []).map(entry => gate(entry.hold === true)),
    keyQuota: (plans.keyQuota ?? []).map(entry => gate(entry.hold === true)),
  };
  const counts = { oauth: 0, keys: 0, oauthQuota: 0, keyQuota: 0, put: 0 };
  const putGate = gate(plans.put?.hold === true);
  const read = async (kind: Kind) => {
    const index = counts[kind]++;
    const payload = (kind === "oauth" ? plans.oauth
      : kind === "keys" ? plans.keys
        : kind === "oauthQuota" ? plans.oauthQuota : plans.keyQuota)?.[index];
    if (!payload) return Response.json({ accounts: [], keys: [], activeAccountId: null, activeId: null });
    await gates[kind][index].promise;
    if (payload.status) return new Response(null, { status: payload.status });
    return Response.json({ accounts: payload.rows, keys: payload.rows, activeAccountId: payload.id, activeId: payload.id });
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        counts.put += 1;
        await putGate.promise;
        if (plans.put?.status) return new Response(null, { status: plans.put.status });
        return Response.json(plans.put?.body ?? {});
      }
      const url = String(input);
      const quota = url.includes("quota=1");
      if (url.includes("/api/oauth/accounts")) return read(quota ? "oauthQuota" : "oauth");
      if (url.includes("/api/providers/keys")) return read(quota ? "keyQuota" : "keys");
      return Response.json({});
    },
  });
  return {
    release: (kind: Kind, index: number) => gates[kind][index]?.resolve(),
    releasePut: () => putGate.resolve(),
    counts,
  };
}

function actEnvironment(value: boolean) {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value });
}

function Probe({ targetKey, onSwitch }: { targetKey: string; onSwitch?: () => void }) {
  const aliveRef = useRef(true);
  const controller = useProviderAccountPools({
    apiBase: "/same", targetKey, config: null, aliveRef, t: key => key, oauthStatus: {},
    notify: message => { notified.push(message); }, fetchConfig: async () => {}, fetchOauth: async () => {},
    fetchProviderQuotas: async () => {}, codexActiveNeedsReauth: false,
  });
  const last = useRef(targetKey);
  useLayoutEffect(() => {
    if (last.current === targetKey) return;
    last.current = targetKey;
    onSwitch?.();
  });
  useLayoutEffect(() => {
    pools = controller;
    snapshots.push({
      accounts: controller.accountSets.anthropic?.accounts.map(account => account.id) ?? [],
      keys: controller.keyPools.anthropic?.map(entry => entry.id) ?? [],
      load: controller.accountLoadStates.anthropic,
    });
  });
  // Declared after the hook, so this runs after the hook's target-change cleanup and
  // setup. Resolving it is the explicit barrier a test uses instead of a timeout.
  useEffect(() => {
    passiveSettled?.();
    passiveSettled = null;
  });
  return null;
}

async function mount(targetKey: string) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(host); root.render(<Probe targetKey={targetKey} />); });
}

async function switchTarget(targetKey: string, releasePrevious: () => void) {
  configureApiTargets(relay("/same", targetKey));
  const settled = new Promise<void>(resolve => { passiveSettled = resolve; });
  actEnvironment(false);
  try {
    root!.render(<Probe targetKey={targetKey} onSwitch={releasePrevious} />);
    // The hook's target-change cleanup and setup are passive effects. Starting the new
    // target's read before that flush lets the cleanup bump its generation, which makes
    // a legitimate read return false. Wait for the flush itself, not a timer.
    await settled;
  } finally {
    actEnvironment(true);
  }
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  const win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  originalFetch = globalThis.fetch;
  snapshots = [];
  notified = [];
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  configureApiTargets(standaloneApiTargets(""));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("a late provider roster read from the previous target cannot paint the new one", async () => {
  const server = serve({ oauth: [
    { id: "a1", rows: [row("a1")], hold: true },
    { id: "b1", rows: [row("b1")] },
  ] });
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  let pending!: Promise<boolean>;
  await act(async () => { pending = pools.fetchAccountSets(["anthropic"]); });
  expect(server.counts.oauth).toBe(1);

  await switchTarget("hub-b", () => server.release("oauth", 0));

  expect(await pending).toBe(false);
  expect(snapshots.every(snapshot => !snapshot.accounts.includes("a1"))).toBe(true);
  expect(pools.accountSets.anthropic).toBeUndefined();

  await act(async () => { expect(await pools.fetchAccountSets(["anthropic"])).toBe(true); });
  expect(pools.accountSets.anthropic?.accounts.map(account => account.id)).toEqual(["b1"]);
});

test("a late provider key-pool read from the previous target cannot paint the new one", async () => {
  const server = serve({ keys: [
    { id: "a1", rows: [key("a1")], hold: true },
    { id: "b1", rows: [key("b1")] },
  ] });
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  let pending!: Promise<boolean>;
  await act(async () => { pending = pools.fetchKeyPools(["anthropic"]); });
  expect(server.counts.keys).toBe(1);

  await switchTarget("hub-b", () => server.release("keys", 0));

  expect(await pending).toBe(false);
  expect(snapshots.every(snapshot => !snapshot.keys.includes("a1"))).toBe(true);
  expect(pools.keyPools.anthropic).toBeUndefined();

  await act(async () => { expect(await pools.fetchKeyPools(["anthropic"])).toBe(true); });
  expect(pools.keyPools.anthropic?.map(entry => entry.id)).toEqual(["b1"]);
});

test("a held read on the new account target still paints it", async () => {
  const server = serve({ oauth: [{ id: "b1", rows: [row("b1")], hold: true }] });
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await switchTarget("hub-b", () => {});
  expect(pools.accountSets.anthropic).toBeUndefined();

  let pending!: Promise<boolean>;
  await act(async () => { pending = pools.fetchAccountSets(["anthropic"]); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(pools.accountLoadStates.anthropic).toBe("loading");
  expect(pools.accountSets.anthropic).toBeUndefined();

  await act(async () => { server.release("oauth", 0); expect(await pending).toBe(true); });
  expect(pools.accountSets.anthropic?.accounts.map(account => account.id)).toEqual(["b1"]);
  expect(pools.accountLoadStates.anthropic).toBe("ready");
});

test("a held read on the new key target still paints it", async () => {
  const server = serve({ keys: [{ id: "b1", rows: [key("b1")], hold: true }] });
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await switchTarget("hub-b", () => {});
  expect(pools.keyPools.anthropic).toBeUndefined();

  let pending!: Promise<boolean>;
  await act(async () => { pending = pools.fetchKeyPools(["anthropic"]); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(pools.keyPools.anthropic).toBeUndefined();

  await act(async () => { server.release("keys", 0); expect(await pending).toBe(true); });
  expect(pools.keyPools.anthropic?.map(entry => entry.id)).toEqual(["b1"]);
});

test("an earlier visit's read cannot repaint the target after a round trip", async () => {
  const server = serve({ oauth: [
    { id: "a-old", rows: [row("a-old")], hold: true },
    { id: "b1", rows: [row("b1")] },
    { id: "a-new", rows: [row("a-new")] },
  ] });
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  let first!: Promise<boolean>;
  await act(async () => { first = pools.fetchAccountSets(["anthropic"]); });
  expect(server.counts.oauth).toBe(1);

  await switchTarget("hub-b", () => {});
  await act(async () => { expect(await pools.fetchAccountSets(["anthropic"])).toBe(true); });
  expect(pools.accountSets.anthropic?.accounts.map(account => account.id)).toEqual(["b1"]);

  // Back to A while the first visit's read is still held. Its capture is from an earlier
  // target generation, so it must not resurrect "a-old" even though the identity is A again.
  await switchTarget("hub-a", () => server.release("oauth", 0));
  expect(await first).toBe(false);
  expect(snapshots.every(snapshot => !snapshot.accounts.includes("a-old"))).toBe(true);

  await act(async () => { expect(await pools.fetchAccountSets(["anthropic"])).toBe(true); });
  expect(pools.accountSets.anthropic?.accounts.map(account => account.id)).toEqual(["a-new"]);
});

test("a late quota enrichment from the previous target cannot paint the new one", async () => {
  const server = serve({
    oauth: [{ id: "a1", rows: [row("a1", { quotaMode: "probe" })] }],
    oauthQuota: [{ id: "a1", rows: [row("a1", { quotaMode: "probe", quota: reading })], hold: true }],
  });
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = pools.fetchAccountSets(["anthropic"], true);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(server.counts.oauth).toBe(1);
  expect(server.counts.oauthQuota).toBe(1);

  // A's roster already painted before the switch; only B-era frames must stay clean.
  snapshots = [];
  await switchTarget("hub-b", () => server.release("oauthQuota", 0));

  expect(await pending).toBe(false);
  expect(snapshots.every(snapshot => !snapshot.accounts.includes("a1"))).toBe(true);
  expect(pools.accountSets.anthropic).toBeUndefined();
});

test("a late failure from the previous target cannot mark the new target's roster failed", async () => {
  const server = serve({ oauth: [
    { id: "a1", rows: [], status: 503, hold: true },
    { id: "b1", rows: [row("b1")] },
  ] });
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  let pending!: Promise<boolean>;
  await act(async () => { pending = pools.fetchAccountSets(["anthropic"]); });

  await switchTarget("hub-b", () => server.release("oauth", 0));

  expect(await pending).toBe(false);
  expect(pools.accountLoadStates.anthropic).toBeUndefined();
  expect(snapshots.every(snapshot => !snapshot.accounts.includes("a1"))).toBe(true);
  expect(snapshots.every(snapshot => snapshot.load !== "error")).toBe(true);

  await act(async () => { expect(await pools.fetchAccountSets(["anthropic"])).toBe(true); });
  expect(pools.accountLoadStates.anthropic).toBe("ready");
  expect(pools.accountSets.anthropic?.accounts.map(account => account.id)).toEqual(["b1"]);
});

test("a late account switch from the previous target cannot paint or toast on the new one", async () => {
  const server = serve({ put: { hold: true, body: { activeAccountId: "a1" } } });
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  let pending!: Promise<void>;
  await act(async () => {
    pending = pools.switchAccount("anthropic", { id: "a1", active: false, paused: false } as never);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(server.counts.put).toBe(1);

  await switchTarget("hub-b", () => server.releasePut());
  await pending;

  expect(snapshots.every(snapshot => !snapshot.accounts.includes("a1"))).toBe(true);
  expect(pools.accountSets.anthropic).toBeUndefined();
  expect(notified).toEqual([]);
});
