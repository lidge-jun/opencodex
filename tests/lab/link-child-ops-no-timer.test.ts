// INV-LINK-CHILD-OPS-01: a Home without links starts no Child-ops timer and loads no Child-ops host or scheduler; the
// host starts when the link listener owns its socket and stops when it closes.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createOptionalListenerSet, type ChildOpsHostLoader } from "../../src/server/index/optional-listeners";
import { CATALOG_POLL_MS, QUIET_PERIOD_MS } from "../../src/link/child-ops-scheduler";
import type { LinkStore } from "../../src/link/store";
import type { OcxConfig } from "../../src/types";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const repoRoot = resolveRepoRoot();
const CORE = ["src/router.ts", "src/server/lifecycle.ts", "src/server/responses/core.ts", "src/server/background-lifecycle.ts"] as const;
const CHILD_OPS = /\/src\/link\/(child-ops-[^/]+|child-policy)\.ts$/;
const STATIC_IMPORT_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), `${base}.mts`, `${base}.mjs`]) if (existsSync(candidate)) return candidate;
  return null;
}
/** Breadth-first over static value imports; returns the chain to the first Child-ops module, or null. */
function firstChildOpsPath(entry: string): string[] | null {
  const start = resolve(repoRoot, entry);
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = readFileSync(current, "utf8");
    STATIC_IMPORT_RE.lastIndex = 0;
    for (let match = STATIC_IMPORT_RE.exec(source); match; match = STATIC_IMPORT_RE.exec(source)) {
      const next = resolveSpec(match[1] ?? match[2] ?? match[3] ?? "", current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      if (CHILD_OPS.test(next.replaceAll("\\", "/"))) {
        const chain: string[] = [];
        for (let node: string | null = next; node; node = previous.get(node) ?? null) chain.push(node.slice(repoRoot.length + 1));
        return chain.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

describe("static boundary", () => {
  test("core and the background lifecycle cannot reach the Child-ops scheduler, host or policy", () => {
    for (const entry of CORE) expect(firstChildOpsPath(entry), entry).toBeNull();
  });

  test("optional-listeners loads the host only dynamically and stops it before the supervisor", () => {
    const source = readFileSync(resolve(repoRoot, "src/server/index/optional-listeners.ts"), "utf8");
    STATIC_IMPORT_RE.lastIndex = 0;
    const statics = [...source.matchAll(STATIC_IMPORT_RE)].map(match => match[1] ?? match[2] ?? match[3]);
    for (const spec of statics) expect(spec ?? "").not.toMatch(/child-ops-host|child-ops-scheduler|child-policy|link-child-ops-routes/);
    expect(source.split('import("../../link/child-ops-host")').length - 1).toBe(1);
    expect(source.split('import("../management/link-child-ops-routes")').length - 1).toBe(1);
    const stop = source.slice(source.indexOf("async stop()"));
    expect(stop.indexOf("stopChildOps?.()")).toBeGreaterThan(-1);
    expect(stop.indexOf("stopChildOps?.()")).toBeLessThan(stop.indexOf("supervisorStop()"));
  });
});

describe("runtime", () => {
  let temp = "";
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "ocx-child-ops-no-timer-"));
    for (const name of ["OPENCODEX_HOME", "CODEX_HOME"]) saved[name] = process.env[name];
    process.env.OPENCODEX_HOME = join(temp, "ocx");
    process.env.CODEX_HOME = join(temp, "codex");
    mkdirSync(join(temp, "ocx", "link"), { recursive: true });
    mkdirSync(join(temp, "codex"), { recursive: true });
    writeFileSync(join(temp, "codex", "opencodex-catalog.json"), JSON.stringify({ models: [] }));
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    removeTreeWithRetry(temp);
  });

  const LINK = "lnk_0123456789abcdef";
  const withLink = (): LinkStore => ({ version: 1, listenerPort: null, links: [{ id: LINK, alias: "child", direction: "hub-initiated",
    hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345", tunnelPort: 41000, apiKeyId: "key-01", createdAt: "2026-11-01T00:00:00.000Z" }] });
  const empty = (): LinkStore => ({ version: 1, listenerPort: null, links: [] });
  const config = { port: 0, providers: {}, defaultProvider: "test", claudeCode: { enabled: false }, apiKeys: [] } as unknown as OcxConfig;
  const settle = async () => { for (let i = 0; i < 50; i += 1) await new Promise(done => setTimeout(done, 1)); };

  function listenerSet(initial: LinkStore, load?: ChildOpsHostLoader, order: string[] = []) {
    let current = initial;
    const listeners = createOptionalListenerSet({ readStore: () => current, writeStore: (_path, next) => { current = next; } }, { load });
    listeners.linkSupervisor().start = () => {};
    listeners.linkSupervisor().stop = async () => { order.push("supervisor-stop"); };
    return { listeners, order, setStore: (store: LinkStore) => { current = store; } };
  }
  function recordingLoader(order: string[]) {
    const calls = { loads: 0, starts: 0, stops: 0 };
    const load: ChildOpsHostLoader = async () => {
      calls.loads += 1;
      return { catalogRevision: () => ({ current: () => null }),
        startChildOpsHost: () => { calls.starts += 1; order.push("host-start"); return () => { calls.stops += 1; order.push("host-stop"); }; } };
    };
    return { calls, load };
  }
  function timerSpies() {
    const intervals = spyOn(globalThis, "setInterval");
    const timeouts = spyOn(globalThis, "setTimeout");
    return {
      schedulerTimers: () => [...intervals.mock.calls.map(call => call[1]), ...timeouts.mock.calls.map(call => call[1])]
        .filter(ms => ms === CATALOG_POLL_MS || ms === QUIET_PERIOD_MS).length,
      restore: () => { intervals.mockRestore(); timeouts.mockRestore(); },
    };
  }

  test("a Home without links loads no host and creates none of the scheduler's timers", async () => {
    const spies = timerSpies();
    const { listeners, order } = listenerSet(empty());
    const recorded = recordingLoader(order);
    const withSeam = listenerSet(empty(), recorded.load);
    try {
      listeners.start({ config, publicPort: 0, maxRequestBodySize: 1024, dispatch: async () => new Response("ok") });
      withSeam.listeners.start({ config, publicPort: 0, maxRequestBodySize: 1024, dispatch: async () => new Response("ok") });
      await settle();
      expect(listeners.status().state).toBe("off");
      expect(spies.schedulerTimers()).toBe(0);
      expect(recorded.calls).toEqual({ loads: 0, starts: 0, stops: 0 });
    } finally {
      spies.restore();
      await listeners.stop();
      await withSeam.listeners.stop();
    }
  });

  test("the first link starts the host, removing the last stops it, and stop() stops it before the supervisor", async () => {
    const order: string[] = [];
    const recorded = recordingLoader(order);
    const set = listenerSet(empty(), recorded.load, order);
    let stopped = false;
    try {
      set.listeners.start({ config, publicPort: 0, maxRequestBodySize: 1024, dispatch: async () => new Response("ok") });
      await settle();
      expect(recorded.calls.starts).toBe(0);
      set.setStore(withLink());
      await set.listeners.ensureStarted();
      await settle();
      expect(set.listeners.status().state).toBe("listening");
      expect(recorded.calls).toEqual({ loads: 1, starts: 1, stops: 0 });
      await set.listeners.ensureStarted();
      await settle();
      expect(recorded.calls.starts).toBe(1);
      set.setStore(empty());
      await set.listeners.close();
      expect(recorded.calls.stops).toBe(1);
      set.setStore(withLink());
      await set.listeners.ensureStarted();
      await settle();
      expect(recorded.calls.starts).toBe(2);
      await set.listeners.stop();
      stopped = true;
      expect(set.order.slice(-2)).toEqual(["host-stop", "supervisor-stop"]);
      expect(recorded.calls.stops).toBe(2);
    } finally { if (!stopped) await set.listeners.stop(); }
  });

  test("a load still in flight when the listener closes starts nothing", async () => {
    let release!: () => void;
    const order: string[] = [];
    const recorded = recordingLoader(order);
    const gate = new Promise<void>(done => { release = done; });
    const set = listenerSet(withLink(), async () => { await gate; return recorded.load(); });
    set.listeners.start({ config, publicPort: 0, maxRequestBodySize: 1024, dispatch: async () => new Response("ok") });
    set.setStore(empty());
    await set.listeners.close();
    release();
    await settle();
    expect(recorded.calls.starts).toBe(0);
    await set.listeners.stop();
  });

  test("with a link the real host arms the scheduler's timers, and stop() clears them", async () => {
    const intervals = spyOn(globalThis, "setInterval");
    const cleared = spyOn(globalThis, "clearInterval");
    const spies = timerSpies();
    const set = listenerSet(withLink());
    try {
      set.listeners.start({ config, publicPort: 0, maxRequestBodySize: 1024, dispatch: async () => new Response("ok") });
      for (let i = 0; i < 100 && spies.schedulerTimers() < 2; i += 1) await settle();
      expect(spies.schedulerTimers()).toBe(2);           // the 5-minute poll and the start-time quiet period
      const pollIndex = intervals.mock.calls.findIndex(call => call[1] === CATALOG_POLL_MS);
      const poll = intervals.mock.results[pollIndex]!.value;
      await set.listeners.stop();
      expect(cleared.mock.calls.some(call => call[0] === poll)).toBe(true);
    } finally {
      spies.restore();
      intervals.mockRestore();
      cleared.mockRestore();
      await set.listeners.stop();
    }
  });
});
