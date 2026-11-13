import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationDigest, parseOperationsJournal, pruneOperations, readOperationsJournal, writeOperationsJournal, OPERATION_RETENTION_MS,
  OperationsJournalError, type LinkOperation } from "../../src/link/operations-journal";
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
