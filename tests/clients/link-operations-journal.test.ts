import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRoomForNewOperation, operationDigest, parseOperationsJournal, pruneOperations, readOperationsJournal, writeOperationsJournal, OPERATION_JOURNAL_MAX_RECENT_SETTLED, OPERATION_JOURNAL_MAX_SETTLED,
  OPERATION_JOURNAL_MAX_UNSETTLED, OPERATION_PRUNE_FLOOR_MS, OPERATION_REPLAY_MIN_MS, OPERATION_RETENTION_MS, OperationsJournalFullError,
  OperationsJournalError, type LinkOperation } from "../../src/link/operations-journal";
import { ALIAS_LOCK_WAIT_MS } from "../../src/link/alias-lock";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/** O1: operations.json is a trust boundary like links.json. */
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-op-journal-")); });
afterEach(() => { if (dir) removeTreeWithRetry(dir); });

const AT = "2026-11-13T00:00:00.000Z";
function entry(overrides: Partial<LinkOperation> = {}): LinkOperation {
  return { operationId: "op-1", kind: "enroll", alias: "pen-a", digest: "b".repeat(64), createdAt: AT, updatedAt: AT, state: "open",
    reserved: { linkId: "lnk_00000000000000aa", apiKeyId: "k-1", tunnelPort: null }, effects: [], ...overrides };
}
const text = (operations: unknown[]) => JSON.stringify({ version: 1, operations });

test("a written journal reads back exactly and is private", () => {
  const path = join(dir, "link", "operations.json");
  const journal = { version: 1 as const, operations: [entry({ effects: [{ effect: "key_issued", phase: "intent", at: AT }] })] };
  writeOperationsJournal(path, journal);
  expect(readOperationsJournal(path)).toEqual(journal);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
});

test("a missing file is empty; a damaged one is an error, never empty", () => {
  expect(readOperationsJournal(join(dir, "absent.json"))).toEqual({ version: 1, operations: [] });
  const path = join(dir, "damaged.json");
  writeFileSync(path, "{ not json");
  expect(() => readOperationsJournal(path)).toThrow(OperationsJournalError);
});

test.each([
  ["an unknown field", [{ ...entry(), extra: 1 }], "unknown field"],
  ["duplicate ids", [entry(), entry()], "duplicate"],
  ["an effect of the other kind", [entry({ effects: [{ effect: "record_removed", phase: "done", at: AT }] })], "effects[0]"],
  ["an open entry with finishedAt", [entry({ finishedAt: AT })], "finishedAt"],
  ["a terminal entry without finishedAt", [entry({ state: "committed" })], "finishedAt"],
  ["resolvedAt on a committed entry", [entry({ state: "committed", finishedAt: AT, resolvedAt: AT })], "resolvedAt"],
  ["an explicit route without exclusive", [entry({ reserved: { linkId: "lnk_00000000000000aa", apiKeyId: "k-1", tunnelPort: 2200, explicitRoute: { proxyCommand: "/usr/bin/pen pipe", user: "u", port: 22 } } })], "explicitRoute"],
  ["a remote message as the error code", [entry({ state: "failed_clean", finishedAt: AT, error: { code: "Permission denied", status: 502 } })], "error"],
  ["a receipt for another link", [{ operationId: "op-r", kind: "revoke", alias: "pen-a", linkId: "lnk_00000000000000aa", digest: "c".repeat(64), createdAt: AT, updatedAt: AT, state: "committed", finishedAt: AT, effects: [], receipt: { purged: true, linkId: "lnk_00000000000000bb" } }], "receipt"],
] as const)("%s is refused", (_label, operations, message) => {
  expect(() => parseOperationsJournal(text(operations as unknown[]))).toThrow(message);
});

test("retention keeps open and unresolved entries, and drops finished ones 30 days after finishing or resolving", () => {
  const now = Date.parse(AT) + OPERATION_RETENTION_MS + 1;
  const kept = pruneOperations({ version: 1, operations: [
    entry({ operationId: "open" }),
    entry({ operationId: "residual", state: "residual", finishedAt: AT }),
    entry({ operationId: "resolved-late", state: "unknown", finishedAt: AT, resolvedAt: new Date(now - 1000).toISOString() }),
    entry({ operationId: "committed", state: "committed", finishedAt: AT }),
    entry({ operationId: "resolved-early", state: "residual", finishedAt: AT, resolvedAt: AT }),
  ] }, now);
  expect(kept.operations.map(op => op.operationId)).toEqual(["open", "residual", "resolved-late"]);
});

test("the digest ignores key order and undefined values", () => {
  expect(operationDigest({ b: 1, a: { d: 2, c: undefined } })).toBe(operationDigest({ a: { d: 2 }, b: 1 }));
  expect(operationDigest({ a: 1 })).not.toBe(operationDigest({ a: 2 }));
});

test("past OPERATION_JOURNAL_MAX_SETTLED settled entries the oldest settled ones more than a day old go first; open and unresolved entries always stay", () => {
  const now = Date.parse(AT) + OPERATION_PRUNE_FLOOR_MS + 60_000;
  const settled = Array.from({ length: OPERATION_JOURNAL_MAX_SETTLED + 3 }, (_, i) => entry({ operationId: "done-" + i, state: i % 2 ? "committed" : "failed_clean", finishedAt: new Date(Date.parse(AT) + i).toISOString() }));
  const resolvedOld = entry({ operationId: "resolved-old", state: "unknown", finishedAt: AT, resolvedAt: new Date(Date.parse(AT) - 1).toISOString() });
  const kept = pruneOperations({ version: 1, operations: [entry({ operationId: "open" }), entry({ operationId: "unresolved", state: "residual", finishedAt: AT }), resolvedOld, ...settled] }, now);
  const ids = kept.operations.map(op => op.operationId);
  expect(ids).toContain("open");
  expect(ids).toContain("unresolved");
  // The four oldest settled entries (a resolved unknown counts by when it was resolved) are dropped.
  expect(ids.filter(id => id !== "open" && id !== "unresolved")).toHaveLength(OPERATION_JOURNAL_MAX_SETTLED);
  expect(ids).not.toContain("resolved-old");
  expect(ids).not.toContain("done-0");
  expect(ids).not.toContain("done-2");
  expect(ids).toContain("done-3");
});

test("an entry settled less than a day ago is never pruned early, however many settled entries there are", () => {
  const now = Date.parse(AT) + 60_000;
  const recent = Array.from({ length: OPERATION_JOURNAL_MAX_SETTLED + 10 }, (_, i) => entry({ operationId: "done-" + i, state: "committed", finishedAt: new Date(Date.parse(AT) + i).toISOString() }));
  expect(pruneOperations({ version: 1, operations: recent }, now).operations).toHaveLength(OPERATION_JOURNAL_MAX_SETTLED + 10);
});

test("a new operation is refused only for a burst of settled operations within a day, and the refusal says which bound", () => {
  const burst = (ageMs: number) => ({ version: 1 as const, operations: Array.from({ length: OPERATION_JOURNAL_MAX_RECENT_SETTLED }, (_, i) => entry({ operationId: "done-" + i, state: "failed_clean", finishedAt: new Date(Date.parse(AT) - ageMs + i).toISOString() })) });
  const now = Date.parse(AT);
  expect(() => assertRoomForNewOperation(burst(60_000), now)).toThrow(OperationsJournalFullError);
  try { assertRoomForNewOperation(burst(60_000), now); } catch (error) { expect((error as OperationsJournalFullError).bound).toBe("recent"); }
  // The same number settled more than a day ago is pruned down instead.
  expect(() => assertRoomForNewOperation(burst(OPERATION_PRUNE_FLOOR_MS + 60_000), now)).not.toThrow();
  const unsettled = { version: 1 as const, operations: Array.from({ length: OPERATION_JOURNAL_MAX_UNSETTLED }, (_, i) => entry({ operationId: "open-" + i })) };
  try { assertRoomForNewOperation(unsettled, now); throw new Error("not refused"); } catch (error) { expect((error as OperationsJournalFullError).bound).toBe("unsettled"); }
});

test("an entry is pruned early only past a day plus the alias-lock wait: a retry that started within the day still finds it", () => {
  const settledAgo = (ms: number, id: string) => entry({ operationId: id, state: "committed", finishedAt: new Date(Date.parse(AT) - ms).toISOString() });
  const now = Date.parse(AT);
  // 256 entries settled within the hour: none of them may go, so the one under test is the only candidate.
  const filler = Array.from({ length: OPERATION_JOURNAL_MAX_SETTLED }, (_, i) => settledAgo(3_600_000 - i, "recent-" + i));
  // Just past a day: a retry that started a moment before may still be waiting on the alias lock.
  const waiting = settledAgo(OPERATION_REPLAY_MIN_MS + 30_000, "waiting");
  const kept = pruneOperations({ version: 1, operations: [waiting, ...filler] }, now).operations.map(op => op.operationId);
  expect(kept).toContain("waiting");
  // Past the day and the whole lock wait it is the oldest candidate's turn like any other.
  const stale = settledAgo(OPERATION_REPLAY_MIN_MS + ALIAS_LOCK_WAIT_MS + 120_001, "stale");
  expect(pruneOperations({ version: 1, operations: [stale, ...filler] }, now).operations.map(op => op.operationId)).not.toContain("stale");
});
