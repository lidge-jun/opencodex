import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCatalog } from "../../src/codex/catalog";
import { createCatalogRevisionMonitor, type CatalogRevision } from "../../src/link/child-catalog-freshness";
import { createChildOpsEngine } from "../../src/link/child-ops-engine";
import type { ChildOpsEnv } from "../../src/link/child-ops-types";
import { QUIET_PERIOD_MS, CATALOG_POLL_MS, createChildOpsScheduler } from "../../src/link/child-ops-scheduler";
import { DEFAULT_CHILD_POLICY, type ChildPolicy } from "../../src/link/child-policy";
import { schedulerRevision } from "../../src/link/child-ops-host";
import type { SshRunResult } from "../../src/link/ssh-runner";
import type { LinkRecord } from "../../src/link/store";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A3 oracle (050 Revision 6): a Home catalog change reaches a stale Child through the real trigger, scheduler, engine and
 * sync runner, and afterwards every Home row's context window (and the row set) equals the Child's. Only SSH is replaced:
 * the pinned sync argv runs a separate Child process with the real connected sync and the real fan-out serializer.
 */
const LINK = "lnk_0a0b0c0d0e0f1011";
const CONTEXT = ["context_window", "max_context_window", "effective_context_window_percent", "auto_compact_token_limit"] as const;
type Row = Record<string, unknown> & { slug: string };
const row = (slug: string, window: number, extra: Record<string, unknown> = {}): Row => ({
  slug, display_name: slug, visibility: "list", context_window: window, max_context_window: window,
  effective_context_window_percent: 95, auto_compact_token_limit: Math.floor(window * 0.9), default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }], ...extra,
});
// The Home before the change: what the Child last synced. The change adds a 1M-context slug and drops another one,
// which leaves the stale Child showing Codex's 272,000 × 95% fallback for the new slug (001).
const BEFORE: Row[] = [row("home/claude-opus-1m", 1_000_000), row("home/gemini-pro", 1_048_576), row("home/claude-sonnet", 200_000), row("home/retired", 400_000)];
const AFTER: Row[] = [row("home/claude-opus-1m", 1_000_000), row("home/gemini-pro", 1_048_576), row("home/claude-sonnet", 200_000),
  row("home/gpt-1m-new", 1_000_000), row("gpt-5.6", 272_000)];

let temp = "";
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "ocx-child-catalog-oracle-")); });
afterEach(() => removeTreeWithRetry(temp));

async function child(mode: "setup" | "sync", input: Record<string, unknown>): Promise<SshRunResult> {
  const proc = Bun.spawn([process.execPath, fixturePath("link-child-catalog-oracle-runner.ts")], {
    cwd: repoPath(), stdin: new Blob([JSON.stringify({ mode, linkId: LINK, ...input })]), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: join(temp, "child"), USERPROFILE: join(temp, "child"), OPENCODEX_HOME: join(temp, "child", "ocx"),
      CODEX_HOME: join(temp, "child", "codex"), OCX_SERVICE: "", OCX_SERVICE_MANAGED: "0" },
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

const childFile = (name: string): Row[] => {
  const parsed = JSON.parse(readFileSync(join(temp, "child", "codex", name), "utf8")) as { models: Row[] };
  return parsed.models;
};

async function oracle(policy: ChildPolicy) {
  const homeCatalog = join(temp, "home", "codex", "opencodex-catalog.json");
  mkdirSync(join(temp, "home", "codex"), { recursive: true });
  writeFileSync(homeCatalog, JSON.stringify({ models: BEFORE }));
  expect((await child("setup", { catalog: { models: BEFORE } })).code).toBe(0);

  let persisted: CatalogRevision | null = null;
  const clock = { now: Date.parse("2026-11-11T00:00:00.000Z") };
  const monitor = createCatalogRevisionMonitor({ catalogPath: () => homeCatalog, now: () => clock.now,
    read: path => { const catalog = readCatalog(path); return catalog ? JSON.stringify(catalog) : null; },
    load: () => persisted, persist: revision => { persisted = revision; } });
  const before = monitor.current()!.etag;
  const synced: Record<string, string | null> = { [LINK]: before };     // the Child last synced BEFORE
  const sshCalls: string[][] = [];
  const record: LinkRecord = { id: LINK, alias: "oracle-child", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345",
    tunnelPort: 41000, apiKeyId: "oracle-child", createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix" };
  const env: ChildOpsEnv = {
    readStore: () => ({ version: 1, listenerPort: 18181, links: [record] }), knownHostsFile: join(temp, "known_hosts"),
    runner: { run: async argv => {
      sshCalls.push(argv);
      const remote = argv.at(-1)!;
      if (!remote.includes("'sync'") || !remote.includes(`'--expect-link' '${LINK}'`) || !remote.includes("'--json'")) throw new Error("unexpected remote command");
      // The bytes /v1/catalog serves for the Home catalog at the moment the Child pulls.
      const homeBody = JSON.stringify(readCatalog(homeCatalog));
      return child("sync", { homeBody });
    } },
    wireState: () => "connected", activity: () => ({ idle: true, inFlight: 0 }), homeVersion: "2.100.0", now: () => clock.now,
    sleep: async () => {}, observe: async () => { throw new Error("unused"); }, readObservation: () => null,
    writeObservation: (linkId, patch) => { if (patch.catalogSyncedEtag !== undefined) synced[linkId] = patch.catalogSyncedEtag; },
    catalogEtag: () => monitor.current()?.etag ?? null,
  };
  const engine = createChildOpsEngine();
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  let next = 1;
  let slot: (() => void) | null = null;
  const scheduler = createChildOpsScheduler({
    engine, env: () => env, readPolicy: () => ({ policy, warning: null }), revision: schedulerRevision(monitor),
    syncedEtag: linkId => synced[linkId] ?? null, homeDigest: () => null, childDigest: () => null, peerVersion: () => "2.100.0",
    isClientRuntime: () => false, setCatalogChangedSlot: fanout => { slot = fanout; },
    setTimeout: (fn, ms) => { timers.set(next, { at: clock.now + ms, fn, every: null }); return next++; },
    setInterval: (fn, ms) => { timers.set(next, { at: clock.now + ms, fn, every: ms }); return next++; },
    clearTimeout: handle => { timers.delete(handle as number); }, clearInterval: handle => { timers.delete(handle as number); },
  });
  const advance = async (ms: number) => {
    const target = clock.now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock.now = due[1].at;
      if (due[1].every !== null) due[1].at += due[1].every; else timers.delete(due[0]);
      due[1].fn();
      await engine.settled();
      for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    }
    clock.now = target;
  };

  scheduler.start();
  await advance(QUIET_PERIOD_MS);
  expect(sshCalls).toEqual([]);                           // current with BEFORE: nothing to do
  writeFileSync(homeCatalog, JSON.stringify({ models: AFTER }));
  clock.now += 1_000;
  (slot as (() => void) | null)?.();                      // the auto-refresh tick reported the change
  await advance(QUIET_PERIOD_MS - 1);
  expect(sshCalls).toEqual([]);
  await advance(1 + CATALOG_POLL_MS);
  scheduler.stop();
  return { sshCalls, synced, after: monitor.current()!.etag, home: (readCatalog(homeCatalog)!.models as Row[]) };
}

describe("A3 oracle: automatic catalog fan-out repairs a stale Child", () => {
  test("after the automatic sync every Home row's context fields equal the Child's catalog and models_cache rows", async () => {
    const { sshCalls, synced, after, home } = await oracle({ ...DEFAULT_CHILD_POLICY });
    const catalog = new Map(childFile("opencodex-catalog.json").map(entry => [entry.slug, entry]));
    const cache = new Map(childFile("models_cache.json").map(entry => [entry.slug, entry]));
    expect([...catalog.keys()].sort()).toEqual(home.map(entry => entry.slug).sort());
    expect([...cache.keys()].sort()).toEqual(home.map(entry => entry.slug).sort());
    expect(catalog.has("home/retired")).toBe(false);
    for (const entry of home) {
      const pick = (source: Row | undefined) => Object.fromEntries(CONTEXT.map(field => [field, source?.[field]]));
      expect(pick(catalog.get(entry.slug)), entry.slug).toEqual(pick(entry));
      expect(pick(cache.get(entry.slug)), entry.slug).toEqual(pick(entry));
    }
    expect(catalog.get("home/gpt-1m-new")?.context_window).toBe(1_000_000);
    expect(sshCalls.length).toBe(1);
    expect(synced[LINK]).toBe(after);
  }, 120_000);

  test("control: with catalogFanout manual the Child stays stale", async () => {
    const { sshCalls } = await oracle({ ...DEFAULT_CHILD_POLICY, catalogFanout: "manual" });
    expect(sshCalls).toEqual([]);
    const slugs = childFile("opencodex-catalog.json").map(entry => entry.slug);
    expect(slugs).not.toContain("home/gpt-1m-new");
    expect(slugs).toContain("home/retired");
  }, 120_000);
});
