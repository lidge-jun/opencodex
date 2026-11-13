import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { revokeOperationDigest } from "../../src/server/management/link-operation";
import { acquireAliasLock } from "../../src/link/alias-lock";
import { readOperationsJournal, writeOperationsJournal, type LinkOperation } from "../../src/link/operations-journal";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { resetSharedChildOpsEngineForTests, sharedChildOpsEngine } from "../../src/link/child-ops-engine";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * O1: ocx link revoke --operation-id. Every Home-initiated revoke takes the alias lock, so a force revoke waits for a
 * purge holding it; with an operation id the revoke is journalled and a purge's purged:true is its receipt.
 */
const LINK = "lnk_0123456789abcdef";
const ALIAS = "pen-7f3a9c";
const OP = "detach-0001";
const NOW = 1_800_000_000_000;
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

function harness(options: { purgeReport?: string; lockWaitMs?: number; sleep?: (ms: number) => Promise<void>; gate?: Promise<void>; onRun?: () => void } = {}) {
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {},
    apiKeys: [{ id: "link-key", name: "link:" + ALIAS, key: "k", createdAt: "2026-11-13T00:00:00Z" }] };
  const journalPath = join(root, "operations.json");
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [record()] };
  const ssh: string[][] = [];
  const state: LinkRouteState = {
    pendingHosts: new Map(), confirmedHosts: new Map(), operations: new Set(),
    listener: { ensureStarted: async () => {}, status: () => ({ state: "listening", port: 18181, reason: null }), close: async () => {}, onAuthenticatedCatalog: () => () => {} },
    supervisor: { start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {}, reconnect: async () => true, status: () => [], stop: async () => {} },
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
    readLinkStore: () => structuredClone(store), writeLinkStore: next => { store = structuredClone(next); },
    linkKnownHostsPath: () => join(root, "known_hosts"), linkOperationsPath: () => journalPath,
    linkAliasLock: { lockDir: join(root, "locks"), waitMs: options.lockWaitMs ?? 0, pollMs: 250, now: () => NOW, ...(options.sleep ? { sleep: options.sleep } : {}) },
    revokeApiKey: (cfg, id) => { const before = cfg.apiKeys ?? []; cfg.apiKeys = before.filter(key => key.id !== id); return before.length !== cfg.apiKeys.length; },
  };
  async function revoke(body: Record<string, unknown>) {
    const url = new URL("http://127.0.0.1:10100/api/link/" + LINK);
    const context: ManagementContext = {
      req: new Request(url, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      url, config, deps, version: "2.99.0", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      sessionControl: { isCurrent: () => true, isPaired: () => false, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("no catalog convergence"); }, syncClaudeAgentDefsBestEffort: async () => {},
    };
    const response = await handleLinkRoutes(context, state);
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  }
  return { revoke, ssh, config, journalPath, get store() { return store; }, set store(value: LinkStore) { store = value; }, journal: () => readOperationsJournal(journalPath) };
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

test("a purge without the Child's report keeps the link; the Child may have changed, so the outcome is unknown", async () => {
  const h = harness({ purgeReport: '{"restored":true,"purged":false}\n' });
  const revoked = await h.revoke({ purge: true, operationId: OP });
  expect({ status: revoked.status, code: code(revoked), outcome: revoked.body.outcome }).toEqual({ status: 502, code: "remote_disconnect_failed", outcome: "unknown" });
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect(h.journal().operations[0]!.receipt).toBeUndefined();
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
