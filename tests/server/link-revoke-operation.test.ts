import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { revokeOperationDigest } from "../../src/server/management/link-operation";
import { acquireAliasLock } from "../../src/link/alias-lock";
import { claimLinkRetirement, readLinkRetirement } from "../../src/link/retirement";
import { readOperationsJournal, resolveLinkOperation, writeOperationsJournal, type LinkOperation } from "../../src/link/operations-journal";
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

function harness(options: { trusted?: () => boolean; operationsPath?: () => string | undefined; onReload?: () => void; purgeReport?: string; lockWaitMs?: number; sleep?: (ms: number) => Promise<void>; gate?: Promise<void>; onRun?: () => void } = {}) {
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {},
    apiKeys: [{ id: "link-key", name: "link:" + ALIAS, key: "k", createdAt: "2026-11-13T00:00:00Z" }] };
  const journalPath = join(root, "operations.json");
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [record()] };
  const ssh: string[][] = [];
  const state: LinkRouteState = {
    pendingHosts: new Map(), confirmedHosts: new Map(), operations: new Set(),
    listener: { ensureStarted: async () => {}, status: () => ({ state: "listening", port: 18181, reason: null }), close: async () => {}, onAuthenticatedCatalog: () => () => {} },
    supervisor: { start() {}, ensureStarted: async () => {}, reload: async () => { options.onReload?.(); }, stopLink: async () => {}, reconnect: async () => true, status: () => [], stop: async () => {} },
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
    linkKnownHostsPath: () => join(root, "known_hosts"), linkOperationsPath: () => options.operationsPath?.() ?? journalPath,
    linkAliasLock: { lockDir: join(root, "locks"), waitMs: options.lockWaitMs ?? 0, pollMs: 250, now: () => NOW, ...(options.sleep ? { sleep: options.sleep } : {}) },
    ...(options.trusted ? { linkRetirementTrusted: options.trusted } : {}),
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
  writeFileSync(join(root, "not-a-dir"), "");
  const h = harness({ operationsPath: () => broken ? join(root, "not-a-dir", "operations.json") : undefined, onReload: () => { broken = true; } });
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

test("a receipt under an unprotected config root is not honoured, by a plain revoke or by its owner's replay", async () => {
  const h = harness({ trusted: () => false });
  claimLinkRetirement(record(), root, () => h.store, "purge", OP);
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: true, force: false }),
    createdAt: at, updatedAt: at, state: "unknown", finishedAt: at, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  for (const body of [{ purge: true }, { purge: true, operationId: OP }]) {
    const refused = await h.revoke(body);
    expect({ status: refused.status, code: code(refused) }).toEqual({ status: 503, code: "link_retirement_untrusted" });
  }
  expect(h.store.links.map(link => link.id)).toEqual([LINK]);
  expect(h.config.apiKeys?.map(key => key.id)).toEqual(["link-key"]);
  expect(readLinkRetirement(LINK, root)).not.toBeNull();
  expect(h.ssh).toEqual([]);
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

test("an owner's replay checks a mismatched receipt's provenance before replaying", async () => {
  const h = harness({ trusted: () => false });
  claimLinkRetirement(record(), root, () => h.store, "force", "other-op");
  const at = new Date(NOW).toISOString();
  writeOperationsJournal(h.journalPath, { version: 1, operations: [{
    operationId: OP, kind: "revoke", alias: ALIAS, linkId: LINK, digest: revokeOperationDigest({ linkId: LINK, purge: false, force: true }),
    createdAt: at, updatedAt: at, state: "unknown", finishedAt: at, error: { code: "operation_interrupted", status: 409 }, effects: [],
  } as LinkOperation] });
  const refused = await h.revoke({ force: true, operationId: OP });
  expect({ status: refused.status, code: code(refused) }).toEqual({ status: 503, code: "link_retirement_untrusted" });
});
