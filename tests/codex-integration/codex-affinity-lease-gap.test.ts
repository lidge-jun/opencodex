import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { requestOwnedAffinityKey } from "../../src/codex/request-owned-affinity";
import { bindThreadAffinity, clearThreadAccountMap, deleteThreadAffinity, getThreadAffinity, rememberConversationStateIssuer } from "../../src/codex/routing/thread-affinity";
import { adoptStoredIssuer, adoptStoredThreadRows, resetCodexAffinityStoreForTests } from "../../src/codex/routing/thread-affinity-store";
import { acquireSpendLedgerOwner, type SpendLedgerOwnerLease } from "../../src/lib/spend-ledger-owner";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let homes: string[] = [];
let prior: string | undefined;
let lease: SpendLedgerOwnerLease | undefined;
const conversation = (id: string) => new Headers({ authorization: "Bearer caller", "session-id": `gap-${id}`, "thread-id": `gap-${id}` });

function useHome(home: string): void { process.env.OPENCODEX_HOME = home; }
function newHome(): string { const home = mkdtempSync(join(tmpdir(), "ocx-affinity-gap-")); homes.push(home); return home; }
function seedAccounts(): void {
  for (const id of ["a", "b"]) saveCodexAccountCredential(id, { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 600_000, chatgptAccountId: `chat-${id}` });
}
function credential(id: string) { return { generation: readCodexAccountRecord(id)!.generation, chatgptAccountId: `chat-${id}` }; }
/** A fresh process: no live affinity, nothing carried in the store. */
function freshProcess(): void { lease?.release(); lease = undefined; resetCodexAffinityStoreForTests(); clearThreadAccountMap(); resetCodexAffinityStoreForTests(); }
function storedPin(id: string): string | undefined { return adoptStoredThreadRows(codexPoolAffinityKey(conversation(id))!, Date.now())[0]?.accountId; }
function storedIssuer(id: string): string | undefined { return adoptStoredIssuer(codexPoolAffinityKey(conversation(id))!, Date.now())?.issuer; }

beforeEach(() => { prior = process.env.OPENCODEX_HOME; freshProcess(); });
afterEach(() => {
  freshProcess();
  if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
  for (const home of homes) removeTreeWithRetry(home);
  homes = [];
});

test("a change made between leases makes the next lease clear stale rows instead of reviving them", () => {
  useHome(newHome());
  lease = acquireSpendLedgerOwner(); seedAccounts();
  for (const id of ["one", "two"]) {
    const key = codexPoolAffinityKey(conversation(id))!;
    bindThreadAffinity(key, "a", Date.now());
    rememberConversationStateIssuer(key, "a", Date.now(), credential("a"));
  }
  freshProcess();
  // A later process loads only conversation "one", releases, and rebinds it with no lease held.
  lease = acquireSpendLedgerOwner();
  const one = codexPoolAffinityKey(conversation("one"))!;
  expect(getThreadAffinity(one)?.accountId).toBe("a");
  lease.release(); lease = undefined;
  bindThreadAffinity(one, "b", Date.now());
  // A request-owned key changed in the same gap must not reach disk either.
  bindThreadAffinity(requestOwnedAffinityKey(conversation("one"))!, "b", Date.now());
  lease = acquireSpendLedgerOwner();
  freshProcess(); lease = acquireSpendLedgerOwner();
  // The replaced pin must not come back as "a". Rows the process never loaded are cleared too:
  // the database could not record the change, so it is treated as stale as a whole (fail closed).
  expect(storedPin("one")).toBeUndefined();
  expect(storedPin("two")).toBeUndefined();
  expect(storedIssuer("two")).toBeUndefined();
});

test("a change made between leases in one home never touches another home's database", () => {
  const homeB = newHome();
  useHome(homeB);
  lease = acquireSpendLedgerOwner(); seedAccounts();
  bindThreadAffinity(codexPoolAffinityKey(conversation("b-only"))!, "a", Date.now());
  freshProcess();
  const homeA = newHome();
  useHome(homeA);
  lease = acquireSpendLedgerOwner(); seedAccounts();
  const inA = codexPoolAffinityKey(conversation("a-only"))!;
  bindThreadAffinity(inA, "a", Date.now());
  lease.release(); lease = undefined;
  bindThreadAffinity(inA, "b", Date.now());
  useHome(homeB);
  lease = acquireSpendLedgerOwner();
  freshProcess(); useHome(homeB); lease = acquireSpendLedgerOwner();
  expect(storedPin("b-only")).toBe("a");
});

test("a change made while the store could not open is still honoured by the next successful open", () => {
  const home = newHome();
  useHome(home);
  lease = acquireSpendLedgerOwner(); seedAccounts();
  const key = codexPoolAffinityKey(conversation("failed-open"))!;
  bindThreadAffinity(key, "a", Date.now());
  lease.release(); lease = undefined;
  // The next lease cannot open the database (a directory sits at its path); delete during it.
  const file = join(home, "codex-affinity.sqlite");
  renameSync(file, `${file}.aside`); mkdirSync(file);
  lease = acquireSpendLedgerOwner();
  deleteThreadAffinity(key);
  lease.release(); lease = undefined;
  removeTreeWithRetry(file); renameSync(`${file}.aside`, file);
  lease = acquireSpendLedgerOwner();
  freshProcess(); lease = acquireSpendLedgerOwner();
  expect(storedPin("failed-open")).toBeUndefined();
});
