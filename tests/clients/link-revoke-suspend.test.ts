import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkSupervisor } from "../../src/link/supervisor";
import { projectLinkStatus } from "../../src/link/status-projection";
import type { CompensationStore } from "../../src/link/compensation";
import { validateStatus } from "../../src/cli/link";
import { revokeSuspendsLink, writeOperationsJournal, type LinkOperation } from "../../src/link/operations-journal";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { SshChild, SshRunner } from "../../src/link/ssh-runner";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * O1b: a revoke that reached the Child's cleanup and then stopped unknown (its purge receipt could not be written, or the
 * process died) suspends that link's tunnel until the operation is resolved, across reloads and restarts.
 * A cleanup that provably never ran settles failed_clean and suspends nothing, and neither does a revoke still running
 * in this process. A cleanup that failed ambiguously (a timeout, no purge report) is unknown and suspends.
 */
const LINK = "lnk_0123456789abcdef";
const AT = "2026-11-13T00:00:00.000Z";
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-revoke-suspend-")); });
afterEach(() => { if (dir) removeTreeWithRetry(dir); });

function record(): LinkRecord {
  return { id: LINK, alias: "pen-7f3a9c", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstu", tunnelPort: 19002, apiKeyId: "link-key", createdAt: AT };
}

function revoke(overrides: Partial<LinkOperation> = {}): LinkOperation {
  return { operationId: "detach-1", kind: "revoke", alias: "pen-7f3a9c", linkId: LINK, digest: "a".repeat(64), createdAt: AT, updatedAt: AT,
    state: "unknown", finishedAt: AT, effects: [{ effect: "remote_cleanup", phase: "intent", at: AT }], error: { code: "operation_journal_failed", status: 500 }, ...overrides };
}

test.each([
  ["an unknown revoke past its cleanup intent", revoke(), true],
  ["an unknown revoke settled by recovery", revoke({ error: { code: "operation_interrupted", status: 409 } }), true],
  ["an unknown revoke whose key revoke failed after the cleanup", revoke({ effects: [{ effect: "remote_cleanup", phase: "intent", at: AT }, { effect: "remote_cleanup", phase: "done", at: AT }], error: { code: "key_revoke_failed", status: 502 } }), true],
  ["an open revoke no process runs (it died)", revoke({ state: "open", finishedAt: undefined, error: undefined }), true],
  ["an ambiguous cleanup failure (timeout, no purge report)", revoke({ error: { code: "remote_disconnect_failed", status: 502 } }), true],
  ["a cleanup that provably never ran", revoke({ state: "failed_clean", error: { code: "purge_unsupported", status: 409 } }), false],
  ["a resolved one", revoke({ resolvedAt: AT }), false],
  ["one that never reached the Child", revoke({ effects: [] }), false],
  ["a committed one", revoke({ state: "committed", error: undefined }), false],
  ["another link's", revoke({ linkId: "lnk_fedcba9876543210" }), false],
] as const)("%s suspends the link: %p", (_label, op, suspended) => {
  expect(revokeSuspendsLink({ version: 1, operations: [op] }, LINK, () => false)).toBe(suspended);
});

test("an open revoke this process is running suspends nothing: its own tunnel restart after a failed cleanup must go through", () => {
  const op = revoke({ state: "open", finishedAt: undefined, error: undefined });
  expect(revokeSuspendsLink({ version: 1, operations: [op] }, LINK, id => id === "detach-1")).toBe(false);
});

test("the supervisor starts no tunnel for a suspended link, on start or reload, and starts it once the revoke is resolved", async () => {
  const journalPath = join(dir, "operations.json");
  writeOperationsJournal(journalPath, { version: 1, operations: [revoke()] });
  const spawned: string[][] = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) { spawned.push([...argv]); return { pid: 4400 + spawned.length, argv: [...argv], exited: new Promise<number>(() => {}), stderr: Promise.resolve(""), kill: () => {} } as unknown as SshChild; },
  };
  const value: LinkStore = { version: 1, listenerPort: 19001, links: [record()] };
  const supervisor = createLinkSupervisor({
    readStore: () => structuredClone(value), runner, now: () => 0, random: () => 0.5, operationsJournalPath: journalPath,
    readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
    setTimer: () => 1 as unknown as ReturnType<typeof setInterval>, clearTimer: () => {},
  });
  supervisor.start();
  expect(spawned).toHaveLength(0);
  await supervisor.reload();
  expect(spawned).toHaveLength(0);
  writeOperationsJournal(journalPath, { version: 1, operations: [revoke({ resolvedAt: AT })] });
  await supervisor.reload();
  expect(spawned).toHaveLength(1);
});

function supervisorFor(journalPath: string) {
  const spawned: string[][] = [];
  const kills: string[] = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) { spawned.push([...argv]); return { pid: 4500 + spawned.length, argv: [...argv], exited: new Promise<number>(() => {}), stderr: Promise.resolve(""), kill: (signal?: string) => { kills.push(signal ?? "SIGTERM"); } } as unknown as SshChild; },
  };
  const value: LinkStore = { version: 1, listenerPort: 19001, links: [record()] };
  const supervisor = createLinkSupervisor({
    readStore: () => structuredClone(value), runner, now: () => 0, random: () => 0.5, operationsJournalPath: journalPath,
    readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
    setTimer: () => 1 as unknown as ReturnType<typeof setInterval>, clearTimer: () => {},
  });
  return { supervisor, spawned, kills };
}

test("a reconnect of a suspended link answers suspended, stops nothing and spawns nothing; status names the revoke", async () => {
  const journalPath = join(dir, "operations.json");
  writeOperationsJournal(journalPath, { version: 1, operations: [revoke()] });
  const h = supervisorFor(journalPath);
  h.supervisor.start();
  expect(await h.supervisor.reconnect(LINK)).toBe("suspended");
  expect(h.spawned).toHaveLength(0);
  expect(h.supervisor.status()[0]).toMatchObject({ linkId: LINK, suspended: { operationId: "detach-1", since: AT } });
});

test("a link that became suspended while its tunnel runs is not stopped by a reconnect either", async () => {
  const journalPath = join(dir, "operations.json");
  const h = supervisorFor(journalPath);
  h.supervisor.start();
  expect(h.spawned).toHaveLength(1);
  writeOperationsJournal(journalPath, { version: 1, operations: [revoke({ state: "open", finishedAt: undefined, error: undefined })] });
  expect(await h.supervisor.reconnect(LINK)).toBe("suspended");
  expect({ spawned: h.spawned.length, kills: h.kills }).toEqual({ spawned: 1, kills: [] });
});

test("a link that is not suspended has no suspended field and reconnects as before", async () => {
  const h = supervisorFor(join(dir, "operations.json"));
  h.supervisor.start();
  expect(h.supervisor.status()[0]).not.toHaveProperty("suspended");
});

test("a suspended link reads failed with the fixed reason revoke_unsettled, which the CLI's strict status check accepts", () => {
  const store: LinkStore = { version: 1, listenerPort: 19001, links: [record()] };
  const listener = { state: "listening" as const, port: 19001 };
  const none: CompensationStore = { version: 1, entries: {} };
  const suspended = projectLinkStatus(store, [{ linkId: LINK, direction: "hub-initiated", state: { kind: "idle" }, pid: null, suspended: { operationId: "detach-1", since: AT } }], listener, { runtimeRole: "hub" }, none);
  expect(suspended.links[0]).toMatchObject({ state: "failed", since: AT, reason: "revoke_unsettled" });
  expect(validateStatus(JSON.parse(JSON.stringify(suspended))).links[0]).toMatchObject({ state: "failed", reason: "revoke_unsettled" });
  // The row keeps its keys: an older CLI's strict check accepts it too.
  const plain = projectLinkStatus(store, [{ linkId: LINK, direction: "hub-initiated", state: { kind: "idle" }, pid: null }], listener, { runtimeRole: "hub" }, none);
  expect(Object.keys(suspended.links[0]!)).toEqual(Object.keys(plain.links[0]!));
  expect(plain.links[0]).toMatchObject({ state: "idle", reason: null });
});

test("a suspended link with an unverified orphan still reads revoke_unsettled: the suspension is what to act on", () => {
  const store: LinkStore = { version: 1, listenerPort: 19001, links: [record()] };
  const dto = projectLinkStatus(store, [{ linkId: LINK, direction: "hub-initiated", state: { kind: "idle" }, pid: null, orphan: "orphan-unverified", suspended: { operationId: "detach-1", since: AT } }],
    { state: "listening", port: 19001 }, { runtimeRole: "hub" }, { version: 1, entries: {} });
  expect(dto.links[0]).toMatchObject({ state: "failed", since: AT, reason: "revoke_unsettled" });
});
