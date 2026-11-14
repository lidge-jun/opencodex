import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { ownsRetirement, resumedRevokeJournal, revokeOperationDigest } from "../../src/server/management/link-operation";
import { acquireAliasLock } from "../../src/link/alias-lock";
import { claimLinkRetirement, disownLinkRetirement, readLinkRetirement } from "../../src/link/retirement";
import { linkSuspendedByRevoke, OPERATION_JOURNAL_MAX_RECENT_SETTLED, OPERATION_JOURNAL_MAX_UNSETTLED, readOperationsJournal, resolveLinkOperation, writeOperationsJournal, type LinkOperation } from "../../src/link/operations-journal";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { resetSharedChildOpsEngineForTests, sharedChildOpsEngine } from "../../src/link/child-ops-engine";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { MAX_TOMBSTONES, readTombstones, recordTombstone, removeTombstone, tombstonesPath } from "../../src/link/tombstones";

/**
 * O1: ocx link revoke --operation-id. Every Home-initiated revoke takes the alias lock, so a force revoke waits for a
 * purge holding it; with an operation id the revoke is journalled and a purge's purged:true is its receipt.
 */
const LINK = "lnk_0123456789abcdef";
const ALIAS = "pen-7f3a9c";
const OP = "detach-0001";
const NOW = 1_800_000_000_000;
const AT_ISO = new Date(NOW - 1000).toISOString();
const ROUTE = { proxyCommand: "/usr/local/bin/pen pipe --node 7f3a9c 22", user: "ubuntu", port: 22 };

let root = "";
let previousHome: string | undefined;
beforeEach(() => { previousHome = process.env.OPENCODEX_HOME; root = mkdtempSync(join(tmpdir(), "ocx-revoke-op-")); process.env.OPENCODEX_HOME = root; });
afterEach(async () => {
  await sharedChildOpsEngine().settled?.();
  resetSharedChildOpsEngineForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function record(): LinkRecord {
  return { id: LINK, alias: ALIAS, direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2200, apiKeyId: "link-key",
    createdAt: "2026-11-13T00:00:00.000Z", remotePlatform: "posix", childKind: "ephemeral", explicitRoute: ROUTE, exclusive: true };
}

function harness(options: { failStoreRead?: () => boolean; stopGate?: Promise<void>; onStop?: () => void; revokeFails?: boolean; operationsPath?: () => string | undefined; onReload?: () => void; purgeReport?: string; lockWaitMs?: number; sleep?: (ms: number) => Promise<void>; gate?: Promise<void>; onRun?: () => void;
  markHook?: (effect: string, phase: "intent" | "done") => void } = {}) {
  const stops: string[] = [];
  const closedSockets: string[] = [];
  let restarts = 0;
  // What the supervisor's spawn check sees when the revoke restarts the tunnel itself.
  const suspendedAtRestart: boolean[] = [];
  // What a reload landing right after the revoke releases its supervisor hold would see.
  const suspendedAtHoldRelease: boolean[] = [];
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {},
    apiKeys: [{ id: "link-key", name: "link:" + ALIAS, key: "k", createdAt: "2026-11-13T00:00:00Z" }] };
  const journalPath = join(root, "operations.json");
  let journalPathOf = () => journalPath;
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [record()] };
  const ssh: string[][] = [];
  const state: LinkRouteState = {
    pendingHosts: new Map(), confirmedHosts: new Map(), operations: new Set(),
    listener: { ensureStarted: async () => {}, status: () => ({ state: "listening", port: 18181, reason: null }), close: async () => {}, onAuthenticatedCatalog: () => () => {},
      closeLinkSockets: id => { closedSockets.push(id); return 0; } },
    supervisor: { start() {}, ensureStarted: async () => { restarts += 1; suspendedAtRestart.push(linkSuspendedByRevoke(journalPathOf(), LINK)); }, reload: async () => { options.onReload?.(); }, stopLink: async id => { stops.push(id); options.onStop?.(); if (options.stopGate) await options.stopGate; }, reconnect: async () => true, status: () => [], stop: async () => {},
      holdLink: () => { let released = false; return () => { if (!released) { released = true; suspendedAtHoldRelease.push(linkSuspendedByRevoke(journalPathOf(), LINK)); } }; } },
  };
  const runner: SshRunner = {
    async run(argv) {
      ssh.push([...argv]);
      options.onRun?.();
      if (options.gate) await options.gate;
      return { code: 0, stdout: options.purgeReport ?? '{"restored":true,"outcome":"Restored","daemonRunning":false,"purged":true}\n', stderr: "" } satisfies SshRunResult;
    },
    spawnTunnel() { throw new Error("no tunnel here"); },
  };
  writeFileSync(join(root, "known_hosts"), ALIAS + " ssh-ed25519 AAAA\n");
  const deps: ManagementContext["deps"] = {
    now: () => NOW, sshRunner: runner,
    readLinkStore: () => { if (options.failStoreRead?.()) throw new Error("store unreadable"); return structuredClone(store); }, writeLinkStore: next => { store = structuredClone(next); },
    linkKnownHostsPath: () => join(root, "known_hosts"), linkOperationsPath: () => options.operationsPath?.() ?? journalPathOf(),
    linkAliasLock: { lockDir: join(root, "locks"), waitMs: options.lockWaitMs ?? 0, pollMs: 250, now: () => NOW, ...(options.sleep ? { sleep: options.sleep } : {}) },
    ...(options.markHook ? { linkOperationMarkHook: options.markHook } : {}),
    revokeApiKey: (cfg, id) => { if (options.revokeFails) return false; const before = cfg.apiKeys ?? []; cfg.apiKeys = before.filter(key => key.id !== id); return before.length !== cfg.apiKeys.length; },
  };
  async function revoke(body: Record<string, unknown>, signal?: AbortSignal) {
    const url = new URL("http://127.0.0.1:10100/api/link/" + LINK);
    return call(url, new Request(url, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }));
  }
  async function recover(body: Record<string, unknown>) {
    const url = new URL("http://127.0.0.1:10100/api/link/recover");
    return call(url, new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }
  async function reconnect() {
    const url = new URL("http://127.0.0.1:10100/api/link/" + LINK + "/reconnect");
    return call(url, new Request(url, { method: "POST" }));
  }
  async function call(url: URL, req: Request) {
    const context: ManagementContext = {
      req,
      url, config, deps, version: "2.99.0", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      sessionControl: { isCurrent: () => true, isPaired: () => false, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("no catalog convergence"); }, syncClaudeAgentDefsBestEffort: async () => {},
    };
    const response = await handleLinkRoutes(context, state);
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  }
  return { revoke, recover, reconnect, state, ssh, config, journalPath, stops, closedSockets, suspendedAtRestart, suspendedAtHoldRelease, setJournalPath: (next: () => string) => { journalPathOf = next; }, get restarts() { return restarts; }, get store() { return store; }, set store(value: LinkStore) { store = value; }, journal: () => readOperationsJournal(journalPath) };
}

const code = (answer: { body: Record<string, unknown> }) => (answer.body.error as { code?: string } | undefined)?.code;

test("a purge with an operation id records the Child's purged:true as its receipt and replays without SSH", async () => {
  const h = harness();
  const revoked = await h.revoke({ purge: true, operationId: OP });
  expect(revoked).toEqual({ status: 200, body: { linkId: LINK, operationId: OP, outcome: "committed", purged: true } });
  const entry = h.journal().operations[0]!;
  expect(entry).toMatchObject({ kind: "revoke", alias: ALIAS, linkId: LINK, state: "committed", receipt: { purged: true, linkId: LINK }, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }) });
  expect(entry.effects.map(mark => mark.effect + ":" + mark.phase)).toEqual(["remote_cleanup:intent", "remote_cleanup:done", "key_revoked:intent", "key_revoked:done", "record_removed:intent", "record_removed:done"]);
  expect(h.ssh.every(argv => argv.includes("ProxyCommand=" + ROUTE.proxyCommand))).toBe(true);
  const calls = h.ssh.length;
  expect(await h.revoke({ purge: true, operationId: OP })).toEqual(revoked);
  expect(h.ssh.length).toBe(calls);
});

test("a purge without the Child's report keeps the link; the Child may have changed, so the outcome is unknown and the tunnel stays down until it is resolved", async () => {
  const h = harness({ purgeReport: '{"restored":true,"purged":false}\n' });
  const revoked = await h.revoke({ purge: true, operationId: OP });
  expect({ status: revoked.status, code: code(revoked), outcome: revoked.body.outcome }).toEqual({ status: 502, code: "remote_disconnect_failed", outcome: "unknown" });
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect(h.journal().operations[0]!.receipt).toBeUndefined();
  expect(h.restarts).toBe(0);
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  // The hold goes before the outcome is written: a reload in that window must already find the link suspended.
  expect(h.suspendedAtHoldRelease).toEqual([true]);
});

test("a journalled purge refused before it ran (a full install) changed nothing: failed_clean, and the tunnel restarts unsuspended", async () => {
  const h = harness();
  h.store = { ...h.store, links: h.store.links.map(link => ({ ...link, childKind: "full" as const })) };
  const revoked = await h.revoke({ purge: true, operationId: OP });
  expect({ status: revoked.status, code: code(revoked), outcome: revoked.body.outcome }).toEqual({ status: 409, code: "purge_unsupported", outcome: "failed_clean" });
  expect(h.suspendedAtRestart).toEqual([false]);
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(false);
  expect(h.suspendedAtHoldRelease).toEqual([false]);
});

test("a plain purge without the Child's report restarts the tunnel as before: no journal, nothing suspended", async () => {
  const h = harness({ purgeReport: '{"restored":true,"purged":false}\n' });
  const revoked = await h.revoke({ purge: true });
  expect({ status: revoked.status, code: code(revoked) }).toEqual({ status: 502, code: "remote_disconnect_failed" });
  expect(h.restarts).toBe(1);
});

test("a journalled revoke that throws before its outcome is written does not stay registered as running", async () => {
  const h = harness();
  h.state.supervisor.stopLink = async () => { throw new Error("stop failed"); };
  try { await h.revoke({ purge: true, operationId: OP }); } catch { /* the route may rethrow */ }
  expect(h.journal().operations[0]!.state).toBe("open");
  // The entry is abandoned, so the supervisor must treat it as a revoke that died.
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
});

test("the same id with another mode is refused", async () => {
  const h = harness();
  await h.revoke({ purge: true, operationId: OP });
  const refused = await h.revoke({ force: true, operationId: OP });
  expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "operation_mismatch" });
});

test("a force revoke cannot slip in while a purge holds the alias lock: it waits, then runs", async () => {
  let release: (() => void) | undefined;
  const sleeps: number[] = [];
  const h = harness({ lockWaitMs: 10_000, sleep: async ms => { sleeps.push(ms); if (sleeps.length === 2) release?.(); } });
  // The purge holding the lock is a journalled operation, so this Home has a journal and every revoke locks.
  writeOperationsJournal(h.journalPath, { version: 1, operations: [] });
  const held = await acquireAliasLock(ALIAS, { lockDir: join(root, "locks") });
  release = () => held.release();
  const forced = await h.revoke({ force: true });
  expect(sleeps).toEqual([250, 250]);
  expect(forced.status).toBe(200);
  expect(h.store.links).toEqual([]);
});

test("past the wait the force revoke is refused and the link stays", async () => {
  const h = harness();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [] });
  const held = await acquireAliasLock(ALIAS, { lockDir: join(root, "locks") });
  try {
    const forced = await h.revoke({ force: true });
    expect({ status: forced.status, code: code(forced) }).toEqual({ status: 409, code: "link_operation_in_progress" });
    expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  } finally { held.release(); }
});

test("a force revoke that died after revoking the key, with the link still listed, settles unknown", async () => {
  const h = harness();
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{ operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "open", effects: [{ effect: "key_revoked", phase: "intent", at }] }] });
  expect((await h.revoke({ force: true, operationId: OP })).body.outcome).toBe("unknown");
});

test("a link removed by something else while this revoke had marked nothing is not credited as this revoke's commit", async () => {
  const h = harness();
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{ operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "open", effects: [] }] });
  h.store = { version: 1, listenerPort: 18181, links: [] };
  expect((await h.revoke({ purge: true, operationId: OP })).body.outcome).toBe("unknown");
});

test("an open revoke entry for a link refuses every other revoke of it", async () => {
  const h = harness();
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{ operationId: "other-op", kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "open", effects: [{ effect: "remote_cleanup", phase: "intent", at }] }] });
  for (const body of [{ force: true }, { force: true, operationId: OP }]) {
    const refused = await h.revoke(body);
    expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "link_operation_open" });
  }
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
});

test("the first journalled purge on a Home cannot be overtaken by a plain force revoke that saw no journal", async () => {
  // In one runtime the link's Child-operation reservation, taken before anything else, already excludes a second
  // revoke of the same link; across processes only the runtime holding the spend-ledger owner lease serves removal.
  let open!: () => void;
  let running!: () => void;
  const started = new Promise<void>(resolve => { running = resolve; });
  const h = harness({ gate: new Promise<void>(resolve => { open = resolve; }), onRun: () => running() });
  const purge = h.revoke({ purge: true, operationId: OP });
  await started;
  const forced = await h.revoke({ force: true });
  expect({ status: forced.status, code: code(forced) }).toEqual({ status: 409, code: "link_operation_in_progress" });
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  open();
  expect((await purge).body).toEqual({ linkId: LINK, operationId: OP, outcome: "committed", purged: true });
  expect(h.store.links).toEqual([]);
});

test("before this Home ever journalled, a plain revoke takes no lock", async () => {
  const h = harness();
  const held = await acquireAliasLock(ALIAS, { lockDir: join(root, "locks") });
  try {
    expect((await h.revoke({ force: true })).status).toBe(200);
  } finally { held.release(); }
});

test("a recorded revoke entry pruned between the read and the replay falls through to a normal revoke", async () => {
  const h = harness();
  const at = new Date(NOW).toISOString();
  const gonePath = join(root, "operations-after-prune.json");
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{ operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "committed", finishedAt: at, effects: [] }] });
  writeOperationsJournal(gonePath, { version: 1, operations: [] });
  // The first read sees the entry; every later one sees the journal after another write pruned it.
  let reads = 0;
  h.setJournalPath(() => (reads++ === 0 ? h.journalPath : gonePath));
  const revoked = await h.revoke({ purge: true, operationId: OP });
  expect(revoked.status).toBe(200);
  expect(revoked.body).toMatchObject({ linkId: LINK, operationId: OP, outcome: "committed" });
  expect(h.store.links).toEqual([]);
});

test("an invalid body on a link a Child job holds answers 409 as before journalling, not 400", async () => {
  const h = harness();
  const { childOpsEngineFor } = await import("../../src/server/management/link-child-ops-routes");
  const release = childOpsEngineFor(h.state).reserve(LINK);
  try {
    const refused = await h.revoke({ force: "yes" });
    expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "link_operation_in_progress" });
  } finally { release?.(); }
});

test("a revoke whose client went away while waiting for the alias lock stops at once and changes nothing", async () => {
  const controller = new AbortController();
  let polls = 0;
  // The harness clock stands still, so only the abort can end this wait; a wait that ignores it fails here, in bounded time.
  const h = harness({ lockWaitMs: 100_000, sleep: async () => { polls += 1; if (polls === 1) controller.abort(); if (polls > 3) throw new Error("kept waiting after the abort"); } });
  writeOperationsJournal(h.journalPath, { version: 1, operations: [] });
  const held = await acquireAliasLock(ALIAS, { lockDir: join(root, "locks") });
  try {
    const refused = await h.revoke({ force: true }, controller.signal);
    expect(refused.status).toBe(409);
    expect(polls).toBe(1);
    expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  } finally { held.release(); }
});

test("a new journalled revoke past the bound of unsettled entries is refused and the link stays", async () => {
  const h = harness();
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: Array.from({ length: OPERATION_JOURNAL_MAX_UNSETTLED }, (_, i) => ({
    operationId: "old-" + i, kind: "revoke" as const, alias: "pen-old-" + i, linkId: "lnk_00000000000000aa", digest: "d".repeat(64), createdAt: at, updatedAt: at,
    state: "unknown" as const, finishedAt: at, effects: [] })) });
  const refused = await h.revoke({ purge: true, operationId: OP });
  expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "operation_journal_full" });
  expect(refused.body.bound).toBe("unsettled");
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect(h.ssh).toEqual([]);
});

test("a damaged journal names its recovery step; a force revoke still goes through", async () => {
  const h = harness();
  writeFileSync(h.journalPath, "{ damaged");
  const refused = await h.revoke({ purge: true });
  expect({ status: refused.status, code: code(refused) }).toEqual({ status: 500, code: "operation_journal_unreadable" });
  expect((refused.body.error as { message: string }).message).toContain("move it aside");
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect((await h.revoke({ force: true })).status).toBe(200);
  expect(h.store.links).toEqual([]);
});

describe("journal write failures during a revoke", () => {
  test("a failed remote_cleanup intent leaves the tunnel running and answers with the operation id", async () => {
    const h = harness({ markHook: (effect, phase) => { if (effect === "remote_cleanup" && phase === "intent") throw new Error("disk full"); } });
    const revoked = await h.revoke({ purge: true, operationId: OP });
    expect({ status: revoked.status, code: code(revoked), operationId: revoked.body.operationId }).toEqual({ status: 500, code: "operation_journal_failed", operationId: OP });
    expect(h.stops).toEqual([]);
    expect(h.ssh).toEqual([]);
    expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  });

  test("a purge receipt that cannot be written stops the revoke before the key, unknown, with no tunnel restart toward the purged Child", async () => {
    // Removing the link on a receipt held only in memory would lose the Child's purged:true if the process then died.
    const h = harness({ markHook: (effect, phase) => { if (effect === "remote_cleanup" && phase === "done") throw new Error("disk full"); } });
    const revoked = await h.revoke({ purge: true, operationId: OP });
    expect({ status: revoked.status, code: code(revoked), operationId: revoked.body.operationId, outcome: revoked.body.outcome })
      .toEqual({ status: 500, code: "operation_journal_failed", operationId: OP, outcome: "unknown" });
    expect(h.store.links.map(link => link.id)).toEqual([LINK]);
    expect(h.config.apiKeys!.map(key => key.id)).toEqual(["link-key"]);
    expect(h.restarts).toBe(0);
    // A later reload or a restart of the Home must not reconnect to the purged Child either (link-revoke-suspend.test.ts).
    expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  });

  test("a journalled force revoke whose first intent cannot be written leaves the tunnel running", async () => {
    const h = harness({ markHook: (effect, phase) => { if (effect === "key_revoked" && phase === "intent") throw new Error("disk full"); } });
    const revoked = await h.revoke({ force: true, operationId: OP });
    expect({ status: revoked.status, code: code(revoked), operationId: revoked.body.operationId }).toEqual({ status: 500, code: "operation_journal_failed", operationId: OP });
    expect(h.stops).toEqual([]);
    expect(h.store.links.map(link => link.id)).toEqual([LINK]);
    // The tombstone this force revoke of an ephemeral link wrote first goes again: the link stays.
    expect(readTombstones(tombstonesPath()).tombstones).toEqual([]);
  });

  test("a failed record_removed completion still closes the link's sockets", async () => {
    const h = harness({ markHook: (effect, phase) => { if (effect === "record_removed" && phase === "done") throw new Error("disk full"); } });
    const revoked = await h.revoke({ purge: true, operationId: OP });
    expect(revoked.status).toBe(200);
    expect(h.closedSockets).toEqual([LINK]);
  });

  test("a failed key_revoked intent keeps the key, answers with the operation id and settles unknown", async () => {
    const h = harness({ markHook: (effect, phase) => { if (effect === "key_revoked" && phase === "intent") throw new Error("disk full"); } });
    const revoked = await h.revoke({ purge: true, operationId: OP });
    expect({ status: revoked.status, code: code(revoked), operationId: revoked.body.operationId, outcome: revoked.body.outcome }).toEqual({ status: 500, code: "operation_journal_failed", operationId: OP, outcome: "unknown" });
    expect(h.config.apiKeys!.map(key => key.id)).toEqual(["link-key"]);
  });
});

test("a revoke without an operation id writes no journal and answers as before", async () => {
  const h = harness();
  expect(await h.revoke({ purge: true })).toEqual({ status: 200, body: { linkId: LINK } });
  expect(existsSync(h.journalPath)).toBe(false);
});

test.each([
  ["purge asked, link still there", ["remote_cleanup:intent"], true, false, "unknown"],
  ["nothing started, link still there", [], true, false, "failed_clean"],
  ["link removed after a receipt", ["remote_cleanup:intent", "remote_cleanup:done", "key_revoked:intent", "key_revoked:done", "record_removed:intent"], false, true, "committed"],
] as const)("a repeat after the process died (%s) settles as recorded", async (_label, effects, present, receipt, outcome) => {
  const h = harness();
  const at = new Date(NOW).toISOString();
  const entry: LinkOperation = { operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "open", effects: effects.map(item => { const [effect, phase] = item.split(":"); return { effect, phase, at }; }) as LinkOperation["effects"],
    ...(receipt ? { receipt: { purged: true as const, linkId: LINK } } : {}) };
  writeOperationsJournal(h.journalPath, { version: 1, operations: [entry] });
  if (!present) h.store = { version: 1, listenerPort: 18181, links: [] };
  const repeat = await h.revoke({ purge: true, operationId: OP });
  expect(repeat.body.outcome).toBe(outcome);
  expect(h.ssh).toEqual([]);
});

test("a journalled revoke whose cleanup failed after its commit finishes that cleanup on repeat and settles committed", async () => {
  const h = harness();
  const intent = join(root, "route-intent.json");
  writeFileSync(intent, "invalid");
  const first = await h.revoke({ force: true, operationId: OP });
  expect({ status: first.status, outcome: first.body.outcome }).toEqual({ status: 503, outcome: "unknown" });
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).not.toBeNull();
  unlinkSync(intent);
  const again = await h.revoke({ force: true, operationId: OP });
  expect({ status: again.status, outcome: again.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(readLinkRetirement(LINK, root)).toBeNull();
  expect(h.journal().operations[0]!.state).toBe("committed");
  expect(h.ssh).toEqual([]);
});

test("a journalled revoke interrupted after its record removal finishes its retirement before replaying committed", async () => {
  const h = harness();
  // The process died between the record removal and the post-commit cleanup: the receipt and the open entry remain.
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  h.store = { ...h.store, links: [] };
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "open",
    effects: [{ effect: "key_revoked", phase: "intent", at }, { effect: "key_revoked", phase: "done", at }, { effect: "record_removed", phase: "intent", at }],
  } as LinkOperation] });
  const replayed = await h.revoke({ force: true, operationId: OP });
  expect({ status: replayed.status, outcome: replayed.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("a retry of an interrupted removal with another cleanup mode is refused before anything runs", async () => {
  const h = harness();
  const intent = join(root, "route-intent.json");
  writeFileSync(intent, "invalid");
  expect((await h.revoke({ force: true })).status).toBe(503);
  unlinkSync(intent);
  // The forced removal never purged the Child; a purge retry must not report one.
  const purge = await h.revoke({ purge: true });
  expect({ status: purge.status, code: code(purge) }).toEqual({ status: 409, code: "link_retirement_mode_mismatch" });
  // Nor may a journalled purge adopt a receipt it did not claim.
  const journalled = await h.revoke({ purge: true, operationId: OP });
  expect({ status: journalled.status, code: code(journalled) }).toEqual({ status: 409, code: "link_retirement_owned" });
  expect(h.ssh).toEqual([]);
  expect(readLinkRetirement(LINK, root)?.mode).toBe("force");
  expect((await h.revoke({ force: true })).status).toBe(200);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("a journalled revoke that died after claiming its receipt, with the link still listed, finishes and settles committed", async () => {
  const h = harness();
  // The process died between the receipt claim and the key revoke: the record, the key and the receipt remain.
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "open", effects: [],
  } as LinkOperation] });
  const replayed = await h.revoke({ force: true, operationId: OP });
  expect({ status: replayed.status, outcome: replayed.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(h.store.links).toEqual([]);
  expect(h.config.apiKeys).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
  expect(h.journal().operations[0]!.state).toBe("committed");
  expect(h.ssh).toEqual([]);
});

test("a resolved unknown revoke whose cleanup then finishes on repeat settles committed without its resolution", async () => {
  const h = harness();
  const intent = join(root, "route-intent.json");
  writeFileSync(intent, "invalid");
  expect((await h.revoke({ force: true, operationId: OP })).body.outcome).toBe("unknown");
  expect(resolveLinkOperation(h.journalPath, OP, NOW)).not.toBe("not_resolvable");
  unlinkSync(intent);
  const again = await h.revoke({ force: true, operationId: OP });
  expect({ status: again.status, outcome: again.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  const settled = h.journal().operations[0]!;
  expect({ state: settled.state, resolvedAt: settled.resolvedAt }).toEqual({ state: "committed", resolvedAt: undefined });
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("a recorded revoke does not resume its retirement while a Child job holds the link", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "unknown", finishedAt: at, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  const releaseJob = sharedChildOpsEngine().reserve(LINK)!;
  const held = await h.revoke({ force: true, operationId: OP });
  expect({ status: held.status, code: code(held) }).toEqual({ status: 409, code: "link_operation_in_progress" });
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect(h.config.apiKeys?.map(key => key.id)).toEqual(["link-key"]);
  releaseJob();
  const after = await h.revoke({ force: true, operationId: OP });
  expect({ status: after.status, outcome: after.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(h.store.links).toEqual([]);
});

test("a recorded purge does not finish another removal's receipt and is not credited with it", async () => {
  // The purge's Child never reported purged:true, so it is unknown and the link stays.
  const h = harness({ purgeReport: '{"restored":true,"outcome":"Restored","daemonRunning":false}\n' });
  expect((await h.revoke({ purge: true, operationId: OP })).body.outcome).toBe("unknown");
  // A later forced removal under another operation claimed its receipt and died before removing the record.
  claimLinkRetirement(record(), root, () => h.store, "force", "other-op");
  const ssh = h.ssh.length;
  const replayed = await h.revoke({ purge: true, operationId: OP });
  expect({ status: replayed.status, outcome: replayed.body.outcome }).toEqual({ status: 502, outcome: "unknown" });
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect(h.config.apiKeys?.map(key => key.id)).toEqual(["link-key"]);
  expect(readLinkRetirement(LINK, root)?.operationId).toBe("other-op");
  expect(h.ssh.length).toBe(ssh);
});

test("a resumed retirement settles its entry before clearing the receipt, so a failed settle is resumed again", async () => {
  // The journal becomes unwritable after the commit and its cleanup (at the tunnel reload), before the settle.
  let broken = false;
  // A directory where the journal file belongs fails both its read (EISDIR) and its write on every
  // platform. A path under a file did not: Windows reports ENOENT there, which the journal rightly
  // reads as "no journal" (dev batch 43451726885).
  mkdirSync(join(root, "journal-is-a-directory"));
  const h = harness({ operationsPath: () => broken ? join(root, "journal-is-a-directory") : undefined, onReload: () => { broken = true; } });
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  h.store = { ...h.store, links: [] };
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "unknown", finishedAt: at, error: { code: "link_remove_failed", status: 503 },
    effects: [{ effect: "key_revoked", phase: "intent", at }, { effect: "key_revoked", phase: "done", at }, { effect: "record_removed", phase: "intent", at }],
  } as LinkOperation] });
  const failed = await h.revoke({ force: true, operationId: OP });
  expect({ status: failed.status, code: code(failed) }).toEqual({ status: 500, code: "operation_journal_failed" });
  expect(readLinkRetirement(LINK, root)).not.toBeNull();
  expect(h.journal().operations[0]!.state).toBe("unknown");
  broken = false;
  const h2 = harness();
  h2.store = { ...h2.store, links: [] };
  const again = await h2.revoke({ force: true, operationId: OP });
  expect({ status: again.status, outcome: again.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("an unknown revoke's receipt is finished only by repeating that revoke, never by a plain or new one", async () => {
  const h = harness();
  const intent = join(root, "route-intent.json");
  writeFileSync(intent, "invalid");
  // Operation A purges the Child, removes the record, then fails its post-commit cleanup: unknown, receipt kept.
  expect((await h.revoke({ purge: true, operationId: OP })).body.outcome).toBe("unknown");
  unlinkSync(intent);
  const ssh = h.ssh.length;
  for (const body of [{ purge: true }, { purge: true, operationId: "other-op" }]) {
    const other = await h.revoke(body);
    expect({ status: other.status, code: code(other) }).toEqual({ status: 409, code: "link_retirement_owned" });
    expect(readLinkRetirement(LINK, root)?.operationId).toBe(OP);
  }
  expect(h.journal().operations.map(op => op.operationId)).toEqual([OP]);
  const owner = await h.revoke({ purge: true, operationId: OP });
  expect({ status: owner.status, outcome: owner.body.outcome, purged: owner.body.purged }).toEqual({ status: 200, outcome: "committed", purged: true });
  expect(readLinkRetirement(LINK, root)).toBeNull();
  expect(h.ssh.length).toBe(ssh);
});

test("a receipt whose owning entry was pruned is finished only by a plain revoke, never by a journalled one", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  // Not even the pruned owner's own id: a new entry would settle committed from evidence it does not hold.
  for (const operationId of [OP, "other-op"]) {
    const journalled = await h.revoke({ force: true, operationId });
    expect({ status: journalled.status, code: code(journalled) }).toEqual({ status: 409, code: "link_retirement_owned" });
    expect(readLinkRetirement(LINK, root)?.operationId).toBe(OP);
  }
  expect(h.journal().operations).toEqual([]);
  const plain = await h.revoke({ force: true });
  expect(plain.status).toBe(200);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("an unrelated entry that reused a pruned owner's id does not block a plain revoke of the orphaned receipt", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: "lnk_fedcba9876543210", digest: revokeOperationDigest({ linkId: "lnk_fedcba9876543210", purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "committed", finishedAt: at, effects: [],
  } as LinkOperation] });
  const plain = await h.revoke({ force: true });
  expect(plain.status).toBe(200);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("a resolved owner past retention is not pruned while it resumes its retirement", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  const old = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: old, updatedAt: old, state: "unknown", finishedAt: old, resolvedAt: old, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  const replayed = await h.revoke({ force: true, operationId: OP });
  expect({ status: replayed.status, outcome: replayed.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(h.store.links).toEqual([]);
  expect(h.config.apiKeys).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
  expect(h.journal().operations.map(op => [op.operationId, op.state])).toEqual([[OP, "committed"]]);
});

test("a failed_clean owner whose removal resumes from its receipt settles committed", async () => {
  const h = harness();
  // A journal write failed right after the receipt claim, so the owner was recorded clean with nothing marked.
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "failed_clean", finishedAt: at, error: { code: "operation_journal_failed", status: 500 }, effects: [],
  } as LinkOperation] });
  const replayed = await h.revoke({ force: true, operationId: OP });
  expect({ status: replayed.status, outcome: replayed.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("an open revoke whose record is gone does not replay committed while another identity's receipt is outstanding", async () => {
  const h = harness();
  // Its own receipt was replaced by one without its operation id: the post-commit work is not known to be done.
  claimLinkRetirement(record(), root, () => h.store, "force");
  h.store = { ...h.store, links: [] };
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "open",
    effects: [{ effect: "key_revoked", phase: "intent", at }, { effect: "key_revoked", phase: "done", at }, { effect: "record_removed", phase: "intent", at }],
  } as LinkOperation] });
  const replayed = await h.revoke({ force: true, operationId: OP });
  expect(replayed.body.outcome).toBe("unknown");
  expect(readLinkRetirement(LINK, root)).not.toBeNull();
});

test("with the record still listed, a plain purge runs the Child purge again rather than trusting a receipt", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "purge");
  const plain = await h.revoke({ purge: true });
  expect(plain.status).toBe(200);
  expect(h.ssh.length).toBeGreaterThan(0);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("an owner whose journal recorded the Child purge finishes from its receipt without running it again", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "unknown", finishedAt: at, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at }, { effect: "remote_cleanup", phase: "done", at }], receipt: { purged: true, linkId: LINK },
  } as LinkOperation] });
  const replayed = await h.revoke({ purge: true, operationId: OP });
  expect({ status: replayed.status, outcome: replayed.body.outcome, purged: replayed.body.purged }).toEqual({ status: 200, outcome: "committed", purged: true });
  expect(h.ssh).toEqual([]);
  expect(h.store.links).toEqual([]);
});

test("an owner whose journal did not record the Child purge runs it before settling committed", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "unknown", finishedAt: at, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  const replayed = await h.revoke({ purge: true, operationId: OP });
  expect({ status: replayed.status, outcome: replayed.body.outcome, purged: replayed.body.purged }).toEqual({ status: 200, outcome: "committed", purged: true });
  expect(h.ssh.length).toBeGreaterThan(0);
  expect(h.journal().operations[0]!.receipt).toEqual({ purged: true, linkId: LINK });
});

test("a plain purge that cannot run again after its interruption is finished by a plain --force", async () => {
  // The purge removed the Child's executable, then the process died after the receipt claim: a rerun cannot purge.
  const h = harness({ purgeReport: '{"restored":true,"outcome":"Restored","daemonRunning":false}\n' });
  claimLinkRetirement(record(), root, () => h.store, "purge");
  expect((await h.revoke({ purge: true })).status).toBeGreaterThanOrEqual(400);
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  const ssh = h.ssh.length;
  const forced = await h.revoke({ force: true });
  expect(forced.status).toBe(200);
  expect(h.ssh.length).toBe(ssh);
  expect(h.store.links).toEqual([]);
  expect(h.config.apiKeys).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("a plain --force finishes an owned receipt whose purge cannot run again, and the owner keeps its unknown outcome", async () => {
  const h = harness({ purgeReport: '{"restored":true,"outcome":"Restored","daemonRunning":false}\n' });
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "unknown", finishedAt: at, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  expect((await h.revoke({ purge: true, operationId: OP })).status).toBeGreaterThanOrEqual(400);
  const forced = await h.revoke({ force: true });
  expect(forced.status).toBe(200);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
  const replay = await h.revoke({ purge: true, operationId: OP });
  expect(replay.body.outcome).toBe("unknown");
});

test.each([true, false])("a plain --force finishes a receipt whose owner a dead process left open (record listed: %p)", async listed => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  if (!listed) h.store = { ...h.store, links: [] };
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "open",
    effects: listed ? [{ effect: "remote_cleanup", phase: "intent", at }] : [{ effect: "remote_cleanup", phase: "intent", at }, { effect: "record_removed", phase: "intent", at }],
  } as LinkOperation] });
  const ssh = h.ssh.length;
  const forced = await h.revoke({ force: true });
  expect(forced.status).toBe(200);
  expect(h.ssh.length).toBe(ssh);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
  // The owner was settled as its own replay would settle it while its receipt was outstanding, and keeps that.
  expect(h.journal().operations[0]!.state).toBe("unknown");
  expect((await h.revoke({ purge: true, operationId: OP })).body.outcome).toBe("unknown");
});

test("a plain --force that dies after removing the record leaves the open owner it took over unknown on replay", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  const at = new Date(NOW).toISOString();
  // The owner marked its record removal and died before writing the store.
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "open",
    effects: [{ effect: "key_revoked", phase: "intent", at }, { effect: "key_revoked", phase: "done", at }, { effect: "record_removed", phase: "intent", at }],
  } as LinkOperation] });
  // The force removes the record, then fails its post-commit cleanup: the receipt stays.
  const intent = join(root, "route-intent.json");
  writeFileSync(intent, "invalid");
  expect((await h.revoke({ force: true })).status).toBe(503);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)?.operationId).toBeUndefined();
  unlinkSync(intent);
  const replay = await h.revoke({ force: true, operationId: OP });
  expect(replay.body.outcome).toBe("unknown");
  expect(h.journal().operations[0]!.state).toBe("unknown");
  expect((await h.revoke({ force: true })).status).toBe(200);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

describe("reconnect of a suspended link", () => {
  test.each([
    ["unknown", { state: "unknown" as const, finishedAt: AT_ISO }, "ocx link operations resolve --operation-id " + OP + " --yes"],
    ["open (the Home stopped during it)", { state: "open" as const }, "ocx link revoke --link-id " + LINK + " --operation-id " + OP],
  ])("an %s revoke answers 409 link_suspended naming the operation and its next step", async (_label, shape, step) => {
    const h = harness();
    writeOperationsJournal(h.journalPath, { version: 1, operations: [{ operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: "a".repeat(64), createdAt: AT_ISO, updatedAt: AT_ISO,
      effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }], ...shape }] });
    h.state.supervisor.reconnect = async () => "suspended";
    const answer = await h.reconnect();
    expect({ status: answer.status, code: code(answer), operationId: answer.body.operationId, operationState: answer.body.operationState })
      .toEqual({ status: 409, code: "link_suspended", operationId: OP, operationState: shape.state });
    expect((answer.body.error as { message: string }).message).toContain(step);
  });

  test("a reconnect that restarts answers 200 as before", async () => {
    const h = harness();
    expect(await h.reconnect()).toEqual({ status: 200, body: { linkId: LINK } });
  });
});

test("a new journalled revoke after a burst of recently settled operations is refused naming the recent bound", async () => {
  const h = harness();
  const at = new Date(NOW - 60_000).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: Array.from({ length: OPERATION_JOURNAL_MAX_RECENT_SETTLED }, (_, i) => ({
    operationId: "done-" + i, kind: "revoke" as const, alias: "pen-done-" + i, linkId: "lnk_00000000000000aa", digest: "d".repeat(64), createdAt: at, updatedAt: at,
    state: "committed" as const, finishedAt: at, effects: [] })) });
  const refused = await h.revoke({ purge: true, operationId: OP });
  expect({ status: refused.status, code: code(refused), bound: refused.body.bound }).toEqual({ status: 409, code: "operation_journal_full", bound: "recent" });
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
});

test("a resolved owner whose resumed cleanup ends uncertain is unresolved again and keeps its link suspended", async () => {
  const h = harness({ purgeReport: '{"restored":true,"outcome":"Restored","daemonRunning":false}\n' });
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, resolvedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(false);
  const retried = await h.revoke({ purge: true, operationId: OP });
  expect(retried.status).toBeGreaterThanOrEqual(400);
  expect(h.ssh.length).toBeGreaterThan(0);
  const owner = h.journal().operations[0]!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt }).toEqual({ state: "unknown", resolvedAt: undefined });
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
});

test("a plain --force finishes an owned receipt even when the operation journal is damaged", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  writeFileSync(h.journalPath, "not json");
  const forced = await h.revoke({ force: true });
  expect(forced.status).toBe(200);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).toBeNull();
});

test("a resolve during a resumed cleanup is refused, and an uncertain result leaves the owner unresolved and suspended", async () => {
  let open!: () => void, running!: () => void;
  const started = new Promise<void>(resolve => { running = resolve; });
  const h = harness({ purgeReport: '{"restored":true,"outcome":"Restored","daemonRunning":false}\n', gate: new Promise<void>(resolve => { open = resolve; }), onRun: () => running() });
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, resolvedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  const retry = h.revoke({ purge: true, operationId: OP });
  await started;
  // The attempt is pending: the owner is an open, live revoke, which resolve refuses.
  expect(resolveLinkOperation(h.journalPath, OP, NOW)).toBe("not_resolvable");
  open();
  expect((await retry).status).toBeGreaterThanOrEqual(400);
  const owner = h.journal().operations[0]!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt }).toEqual({ state: "unknown", resolvedAt: undefined });
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
});

test.skipIf(process.platform !== "darwin")("a plain --force whose readable journal cannot fence the unknown owner refuses before disowning its receipt", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 }, effects: [{ effect: "key_revoked", phase: "intent", at: AT_ISO }],
  } as LinkOperation] });
  // The journal stays readable but cannot be replaced (the user immutable flag), so reopening the owner fails.
  Bun.spawnSync(["chflags", "uchg", h.journalPath]);
  let forced: Awaited<ReturnType<typeof h.revoke>>;
  try { forced = await h.revoke({ force: true }); } finally { Bun.spawnSync(["chflags", "nouchg", h.journalPath]); }
  expect({ status: forced.status, code: code(forced) }).toEqual({ status: 500, code: "operation_journal_failed" });
  expect(readLinkRetirement(LINK, root)?.operationId).toBe(OP);
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect(h.journal().operations[0]!.state).toBe("unknown");
});

test("a resumed cleanup that fails before it runs keeps the tunnel down when an earlier attempt may have reached the Child", async () => {
  const h = harness({ onRun: () => { throw new Error("ssh unavailable"); } });
  // No recorded platform, so the retry must discover it, and discovery fails before the disconnect runs.
  const { remotePlatform: _platform, ...unprobed } = record();
  h.store = { ...h.store, links: [unprobed] };
  claimLinkRetirement(unprobed, root, () => h.store, "purge", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }],
  } as LinkOperation] });
  const retried = await h.revoke({ purge: true, operationId: OP });
  expect(retried.status).toBeGreaterThanOrEqual(400);
  expect(h.restarts).toBe(0);
  expect(h.journal().operations[0]!.state).toBe("unknown");
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
});

test("a resumed removal that skips a recorded cleanup still runs as an open revoke, so a failed commit leaves the owner unresolved and suspended", async () => {
  const h = harness({ revokeFails: true });
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  // The owner recorded the Child purge, then was resolved; the resume reruns no cleanup and its key revoke fails.
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, resolvedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }, { effect: "remote_cleanup", phase: "done", at: AT_ISO }], receipt: { purged: true, linkId: LINK },
  } as LinkOperation] });
  const retried = await h.revoke({ purge: true, operationId: OP });
  expect(retried.status).toBe(502);
  expect(h.ssh).toEqual([]);
  expect(h.restarts).toBe(0);
  const owner = h.journal().operations[0]!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt }).toEqual({ state: "unknown", resolvedAt: undefined });
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
});

test.skipIf(process.platform !== "darwin")("a resumed intent whose write fails leaves no live mark behind, so the link stays suspended", () => {
  const h = harness();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "open", effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }],
  } as LinkOperation] });
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  const ctx = { deps: { now: () => NOW, linkOperationsPath: () => h.journalPath } } as unknown as ManagementContext;
  const journal = resumedRevokeJournal(ctx, OP, true);
  // The journal stays readable but cannot be replaced (the user immutable flag), so the intent write fails.
  Bun.spawnSync(["chflags", "uchg", h.journalPath]);
  try { expect(() => journal.intent("remote_cleanup")).toThrow(); } finally { Bun.spawnSync(["chflags", "nouchg", h.journalPath]); }
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  journal.release();
});

test("repeated resumes of a pinned owner do not grow its journal entry", async () => {
  const h = harness({ revokeFails: true });
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }, { effect: "remote_cleanup", phase: "done", at: AT_ISO }], receipt: { purged: true, linkId: LINK },
  } as LinkOperation] });
  for (let attempt = 0; attempt < 4; attempt++) expect((await h.revoke({ purge: true, operationId: OP })).status).toBe(502);
  const marks = h.journal().operations[0]!.effects.map(mark => mark.effect + ":" + mark.phase);
  expect(marks).toEqual(["remote_cleanup:intent", "remote_cleanup:done", "key_revoked:intent"]);
});

test("a resolve during a plain --force takeover is refused, and a failed force leaves the owner unresolved and suspended", async () => {
  let open!: () => void, stopping!: () => void;
  const stopped = new Promise<void>(resolve => { stopping = resolve; });
  const h = harness({ revokeFails: true, stopGate: new Promise<void>(resolve => { open = resolve; }), onStop: () => stopping() });
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  // The owner purged the Child, claimed its receipt and died before removing the record.
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "open",
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }, { effect: "remote_cleanup", phase: "done", at: AT_ISO }], receipt: { purged: true, linkId: LINK },
  } as LinkOperation] });
  const forced = h.revoke({ force: true });
  await stopped;
  expect(resolveLinkOperation(h.journalPath, OP, NOW)).toBe("not_resolvable");
  open();
  expect((await forced).status).toBe(502);
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  const owner = h.journal().operations[0]!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt }).toEqual({ state: "unknown", resolvedAt: undefined });
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  expect(h.suspendedAtHoldRelease).toEqual([true]);
});

test("a journalled purge whose link record changes during the Child cleanup keeps the tunnel down and settles unknown", async () => {
  // Another process edits the record while the purge runs on the Child, so the receipt claim fails afterwards.
  const changed = { ...record(), tunnelPort: 2201 };
  let edited = false;
  const h: ReturnType<typeof harness> = harness({ onRun: () => { if (!edited) { edited = true; h.store = { ...h.store, links: [changed] }; } } });
  const answer = await h.revoke({ purge: true, operationId: OP });
  expect({ status: answer.status, code: code(answer), outcome: answer.body.outcome }).toEqual({ status: 409, code: "link_changed", outcome: "unknown" });
  expect(h.restarts).toBe(0);
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
});

test("a plain --force refused by another open revoke changes neither the receipt's owner nor its receipt", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, resolvedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }],
  } as LinkOperation, {
    operationId: "other-op", kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "open", effects: [],
  } as LinkOperation] });
  const forced = await h.revoke({ force: true });
  expect({ status: forced.status, code: code(forced) }).toEqual({ status: 409, code: "link_operation_open" });
  const owner = h.journal().operations.find(op => op.operationId === OP)!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt }).toEqual({ state: "unknown", resolvedAt: AT_ISO });
  expect(readLinkRetirement(LINK, root)?.operationId).toBe(OP);
});

test.skipIf(process.platform !== "darwin")("a plain --force that cannot disown the receipt restores the fenced owner exactly as it was", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, resolvedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }],
  } as LinkOperation] });
  // The receipt stays readable but cannot be rewritten (the user immutable flag), so the takeover stops before it begins.
  const receiptFile = join(root, "link", "retirement-" + LINK + ".json");
  Bun.spawnSync(["chflags", "uchg", receiptFile]);
  let forced: Awaited<ReturnType<typeof h.revoke>>;
  try { forced = await h.revoke({ force: true }); } finally { Bun.spawnSync(["chflags", "nouchg", receiptFile]); }
  expect({ status: forced.status, code: code(forced) }).toEqual({ status: 409, code: "link_changed" });
  const owner = h.journal().operations[0]!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt, finishedAt: owner.finishedAt }).toEqual({ state: "unknown", resolvedAt: AT_ISO, finishedAt: AT_ISO });
  expect(readLinkRetirement(LINK, root)?.operationId).toBe(OP);
  expect(h.stops).toEqual([]);
});

test("a plain --force settles the owner it took over before clearing the receipt, so a crash after the clear cannot credit the owner", async () => {
  // The owner wrote its record_removed intent and died before the store write.
  let broken = false;
  // A directory where the journal file belongs fails both its read (EISDIR) and its write on every
  // platform. A path under a file did not: Windows reports ENOENT there, which the journal rightly
  // reads as "no journal" (dev batch 43451726885).
  mkdirSync(join(root, "journal-is-a-directory"));
  const h = harness({ operationsPath: () => broken ? join(root, "journal-is-a-directory") : undefined, onReload: () => { broken = true; } });
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "open",
    effects: [{ effect: "key_revoked", phase: "intent", at: AT_ISO }, { effect: "key_revoked", phase: "done", at: AT_ISO }, { effect: "record_removed", phase: "intent", at: AT_ISO }],
  } as LinkOperation] });
  // The force removes the record; the journal then becomes unwritable (at the post-commit reload) before the owner settles.
  const forced = await h.revoke({ force: true });
  expect(forced.status).toBe(500);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).not.toBeNull();
  broken = false;
  // A later process sees what the force left: the record and its key gone, the disowned receipt outstanding.
  const later = harness();
  later.store = { ...later.store, links: [] };
  later.config.apiKeys = [];
  const replay = await later.revoke({ force: true, operationId: OP });
  expect(replay.body.outcome).toBe("unknown");
});

test.each([1, 2])("a plain --force whose store read fails after the disown (read %p) restores the owner and its receipt without touching the tunnel", async failAt => {
  let disownedReads = 0;
  const h = harness({ failStoreRead: () => readLinkRetirement(LINK, root)?.operationId === undefined && readLinkRetirement(LINK, root) !== null && ++disownedReads === failAt });
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, resolvedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }],
  } as LinkOperation] });
  const forced = await h.revoke({ force: true });
  expect(forced.status).toBe(503);
  expect(h.stops).toEqual([]);
  const owner = h.journal().operations[0]!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt }).toEqual({ state: "unknown", resolvedAt: AT_ISO });
  expect(readLinkRetirement(LINK, root)?.operationId).toBe(OP);
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
});

test.each([true, false])("an owner whose receipt a plain --force disowned and then died takes it back only while nothing was committed (key present: %p)", async keyPresent => {
  const h = harness();
  // The owner purged the Child and claimed its receipt; a plain force disowned it and died before its first effect.
  const receipt = claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  disownLinkRetirement(receipt, root);
  if (!keyPresent) h.config.apiKeys = [];
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "open",
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }, { effect: "remote_cleanup", phase: "done", at: AT_ISO }], receipt: { purged: true, linkId: LINK },
  } as LinkOperation] });
  const replay = await h.revoke({ purge: true, operationId: OP });
  if (keyPresent) {
    expect({ status: replay.status, outcome: replay.body.outcome, purged: replay.body.purged }).toEqual({ status: 200, outcome: "committed", purged: true });
    expect(h.store.links).toEqual([]);
    expect(readLinkRetirement(LINK, root)).toBeNull();
  } else {
    // The key is gone, so the force may have committed: the receipt stays the force's and the owner is not credited.
    expect(replay.body.outcome).toBe("unknown");
    expect(readLinkRetirement(LINK, root)?.formerOwner).toBe(OP);
  }
  expect(h.ssh).toEqual([]);
});

test("a later plain --force fences the former owner of a receipt an earlier force disowned", async () => {
  let open!: () => void, stopping!: () => void;
  const stopped = new Promise<void>(resolve => { stopping = resolve; });
  const h = harness({ revokeFails: true, stopGate: new Promise<void>(resolve => { open = resolve; }), onStop: () => stopping() });
  // An earlier force disowned the receipt and failed after beginning: the owner was left unknown and unresolved.
  disownLinkRetirement(claimLinkRetirement(record(), root, () => h.store, "purge", OP), root);
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at: AT_ISO }],
  } as LinkOperation] });
  const forced = h.revoke({ force: true });
  await stopped;
  expect(resolveLinkOperation(h.journalPath, OP, NOW)).toBe("not_resolvable");
  open();
  expect((await forced).status).toBe(502);
  const owner = h.journal().operations[0]!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt }).toEqual({ state: "unknown", resolvedAt: undefined });
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  expect(h.suspendedAtHoldRelease).toEqual([true]);
});

test("a disowned receipt pins its former owner past retention, so a later failed force still finds it to fence", async () => {
  const h = harness({ revokeFails: true });
  disownLinkRetirement(claimLinkRetirement(record(), root, () => h.store, "purge", OP), root);
  const old = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: old, updatedAt: old, state: "unknown", finishedAt: old, resolvedAt: old, error: { code: "operation_interrupted", status: 409 },
    effects: [{ effect: "remote_cleanup", phase: "intent", at: old }],
  } as LinkOperation, {
    operationId: "other-op", kind: "revoke", alias: "other-alias", linkId: "lnk_fedcba9876543210", digest: revokeOperationDigest({ linkId: "lnk_fedcba9876543210", purge: false, force: true }),
    createdAt: AT_ISO, updatedAt: AT_ISO, state: "unknown", finishedAt: AT_ISO, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  // An unrelated journal write prunes what has outlived retention; the former owner is pinned by the receipt.
  expect(resolveLinkOperation(h.journalPath, "other-op", NOW, ownsRetirement)).not.toBeNull();
  expect(h.journal().operations.map(op => op.operationId)).toContain(OP);
  expect((await h.revoke({ force: true })).status).toBe(502);
  const owner = h.journal().operations.find(op => op.operationId === OP)!;
  expect({ state: owner.state, resolvedAt: owner.resolvedAt }).toEqual({ state: "unknown", resolvedAt: undefined });
  expect(linkSuspendedByRevoke(h.journalPath, LINK)).toBe(true);
  expect(h.suspendedAtHoldRelease).toEqual([true]);
});

test("recover waits for an unfinished removal, and a resumed forced revoke does not recreate a tombstone", async () => {
  const h = harness();
  const intent = join(root, "route-intent.json");
  writeFileSync(intent, "invalid");
  // A forced revoke of the ephemeral Child removes the record, writes its tombstone, then fails its post-commit cleanup.
  expect((await h.revoke({ force: true })).status).toBe(503);
  expect(h.store.links).toEqual([]);
  expect(readLinkRetirement(LINK, root)).not.toBeNull();
  expect(readTombstones(tombstonesPath()).tombstones.map(t => t.linkId)).toEqual([LINK]);
  const ssh = h.ssh.length;
  const early = await h.recover({ linkId: LINK });
  expect({ status: early.status, code: code(early) }).toEqual({ status: 409, code: "link_retirement_pending" });
  expect(h.ssh.length).toBe(ssh);
  // Had the tombstone been settled meanwhile, finishing the removal must not write a new one for the Child.
  removeTombstone(LINK, tombstonesPath());
  unlinkSync(intent);
  expect((await h.revoke({ force: true })).status).toBe(200);
  expect(readLinkRetirement(LINK, root)).toBeNull();
  expect(readTombstones(tombstonesPath()).tombstones).toEqual([]);
});

test("a failed_clean receipt owner refused at the tombstone limit finishes with its own id once capacity is freed; a new id is refused", async () => {
  const h = harness();
  claimLinkRetirement(record(), root, () => h.store, "force", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "failed_clean", finishedAt: at, error: { code: "operation_journal_failed", status: 500 }, effects: [],
  } as LinkOperation] });
  for (let i = 0; i < MAX_TOMBSTONES; i++) {
    recordTombstone({ linkId: "lnk_" + i.toString(16).padStart(16, "0"), alias: "other-" + i, hostKeyFingerprint: "SHA256:abcdefghijklmnop", revokedAt: at }, tombstonesPath());
  }
  const refused = await h.revoke({ force: true, operationId: OP });
  expect({ status: refused.status, code: code(refused) }).toEqual({ status: 409, code: "tombstone_limit" });
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  // Repeated while capacity is still full, the resumed revoke meets the live limit again: a second refusal proves nothing.
  const again = await h.revoke({ force: true, operationId: OP });
  expect({ status: again.status, code: code(again) }).toEqual({ status: 409, code: "tombstone_limit" });
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  // A new id cannot take the removal over while this operation owns its receipt.
  const other = await h.revoke({ force: true, operationId: "detach-other" });
  expect({ status: other.status, code: code(other) }).toEqual({ status: 409, code: "link_retirement_owned" });
  // Once capacity is freed, the original id resumes and finishes (the CLI's guidance: repeat the same id first).
  removeTombstone("lnk_" + (0).toString(16).padStart(16, "0"), tombstonesPath());
  const resumed = await h.revoke({ force: true, operationId: OP });
  expect({ status: resumed.status, outcome: resumed.body.outcome }).toEqual({ status: 200, outcome: "committed" });
  expect(h.store.links).toEqual([]);
});
