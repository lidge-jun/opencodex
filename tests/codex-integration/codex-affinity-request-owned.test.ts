import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { isRequestOwnedAffinityKey, requestOwnedAffinityKey } from "../../src/codex/request-owned-affinity";
import { bindThreadAffinity, clearThreadAccountMap, getThreadAffinity, peekConversationStateIssuer, rememberConversationStateIssuer } from "../../src/codex/routing/thread-affinity";
import { adoptStoredIssuer, adoptStoredThreadRows, flushCodexAffinityStoreForTests, noteCodexAffinityAnchorForTests, resetCodexAffinityStoreForTests } from "../../src/codex/routing/thread-affinity-store";
import { acquireSpendLedgerOwner, type SpendLedgerOwnerLease } from "../../src/lib/spend-ledger-owner";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let prior: string | undefined;
let lease: SpendLedgerOwnerLease | undefined;
const headers = () => new Headers({ authorization: "Bearer caller-owned-token", "session-id": "request-owned-session", "thread-id": "request-owned-thread" });

beforeEach(() => {
  prior = process.env.OPENCODEX_HOME; home = mkdtempSync(join(tmpdir(), "ocx-affinity-request-owned-")); process.env.OPENCODEX_HOME = home;
  clearThreadAccountMap(); resetCodexAffinityStoreForTests();
});
afterEach(() => {
  lease?.release(); lease = undefined; resetCodexAffinityStoreForTests(); clearThreadAccountMap();
  if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
  removeTreeWithRetry(home);
});

function rows(): { threads: number; issuers: number } {
  const db = new Database(join(home, "codex-affinity.sqlite"));
  try {
    return {
      threads: (db.query("SELECT count(*) AS n FROM threads").get() as { n: number }).n,
      issuers: (db.query("SELECT count(*) AS n FROM issuers").get() as { n: number }).n,
    };
  } finally { db.close(); }
}

test("request-owned bindings and issuers are never saved or restored, even with an anchor", () => {
  lease = acquireSpendLedgerOwner();
  saveCodexAccountCredential("account-a", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000, chatgptAccountId: "chat-account" });
  const record = readCodexAccountRecord("account-a")!;
  const credential = { generation: record.generation, chatgptAccountId: "chat-account" };
  const conversationKey = codexPoolAffinityKey(headers())!;
  const requestOwnedKey = requestOwnedAffinityKey(headers())!;
  expect(isRequestOwnedAffinityKey(requestOwnedKey)).toBe(true);
  // No production path anchors a request-owned key today; feed one in as a future derivation might.
  // A distinct anchor matters: sharing the conversation's anchor would collapse both onto one row.
  noteCodexAffinityAnchorForTests(requestOwnedKey, "future-anchor", "future-anchor");
  const now = Date.now();
  bindThreadAffinity(conversationKey, "account-a", now);
  rememberConversationStateIssuer(conversationKey, "account-a", now, credential);
  bindThreadAffinity(requestOwnedKey, "account-a", now);
  rememberConversationStateIssuer(requestOwnedKey, "account-a", now, credential);
  flushCodexAffinityStoreForTests();
  // Only the ordinary conversation reached disk.
  expect(rows()).toEqual({ threads: 1, issuers: 1 });

  // Restart: a new lease scope reads the database. Live memory survives an in-process lease change,
  // so the restored state is read through the store's adoption, which sees only stored rows.
  lease.release(); lease = acquireSpendLedgerOwner();
  noteCodexAffinityAnchorForTests(requestOwnedKey, "future-anchor", "future-anchor");
  const restoredConversation = codexPoolAffinityKey(headers())!;
  expect(adoptStoredThreadRows(restoredConversation, Date.now()).map(row => row.accountId)).toEqual(["account-a"]);
  expect(adoptStoredIssuer(restoredConversation, Date.now())?.issuer).toBe("account-a");
  expect(adoptStoredThreadRows(requestOwnedKey, Date.now())).toEqual([]);
  expect(adoptStoredIssuer(requestOwnedKey, Date.now())).toBeUndefined();
});

test("a manual switch keeps saved issuers while clearing saved pins", () => {
  lease = acquireSpendLedgerOwner();
  saveCodexAccountCredential("account-a", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000, chatgptAccountId: "chat-account" });
  const record = readCodexAccountRecord("account-a")!;
  const conversationKey = codexPoolAffinityKey(headers())!;
  const now = Date.now();
  bindThreadAffinity(conversationKey, "account-a", now);
  rememberConversationStateIssuer(conversationKey, "account-a", now, { generation: record.generation, chatgptAccountId: "chat-account" });
  flushCodexAffinityStoreForTests();
  clearThreadAccountMap({ preserveConversationStateIssuers: true });
  flushCodexAffinityStoreForTests();
  expect(rows()).toEqual({ threads: 0, issuers: 1 });
  lease.release(); lease = acquireSpendLedgerOwner();
  const restored = codexPoolAffinityKey(headers())!;
  expect(getThreadAffinity(restored)).toBeUndefined();
  expect(peekConversationStateIssuer(restored)).toBe("account-a");
});
