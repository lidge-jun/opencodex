import { registerThreadAffinityLiveState } from "../../src/codex/routing/thread-affinity";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { codexConversationKeyFor } from "../../src/codex/lineage";
import { acquireSpendLedgerOwner, type SpendLedgerOwnerLease } from "../../src/lib/spend-ledger-owner";
import { runPassiveRead } from "../../src/lib/passive-read";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { adoptStoredIssuer, adoptStoredThreadRows, codexAffinityIdentityFence, CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER, flushCodexAffinityStoreForTests, recordAccountPinsCleared, recordAllCleared, recordIssuerSet, recordIssuerDelete, recordThreadDelete, recordThreadBind, recordThreadTouch, registerCodexAffinityLiveState, resetCodexAffinityStoreForTests } from "../../src/codex/routing/thread-affinity-store";

let home: string;
let prior: string | undefined;
let lease: SpendLedgerOwnerLease | undefined;
let live: { accountId: string; identityFence: string; createdAt: number; lastUsedAt: number } | undefined;
const path = () => join(home, "codex-affinity.sqlite");
const key = () => codexConversationKeyFor("private-family", "private-thread");
function seed(): string {
  saveCodexAccountCredential("account-a", { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000, chatgptAccountId: "chat-account" });
  return codexAffinityIdentityFence("account-a")!;
}
function bind(fence: string): string {
  const k = key(); const now = Date.now(); live = { accountId: "account-a", identityFence: fence, createdAt: now - 1000, lastUsedAt: now - 1000 };
  recordThreadBind(k, "legacy", { scope: "legacy", accountId: "account-a", fence, createdAt: live.createdAt, lastUsedAt: live.lastUsedAt }); return k;
}
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME; home = mkdtempSync(join(tmpdir(), "ocx-affinity-")); process.env.OPENCODEX_HOME = home; live = undefined;
  registerCodexAffinityLiveState({ thread: () => live, issuer: () => undefined, clearLive: () => { live = undefined; } });
});
afterEach(() => { lease?.release(); lease = undefined; resetCodexAffinityStoreForTests(); registerThreadAffinityLiveState(); if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior; removeTreeWithRetry(home); });

test("inactive operations do not open and passive operations do not change the database", async () => {
  key(); expect(existsSync(path())).toBe(false);
  lease = acquireSpendLedgerOwner();
  flushCodexAffinityStoreForTests();
  const before = readFileSync(path());
  await runPassiveRead(async () => { key(); recordAllCleared(); });
  expect(readFileSync(path()).equals(before)).toBe(true);
});
test("bind survives release and touch reads the live timestamp at flush", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); const k = bind(fence); const newer = Date.now();
  recordThreadTouch(k, "legacy"); live!.lastUsedAt = newer; flushCodexAffinityStoreForTests();
  lease.release(); lease = acquireSpendLedgerOwner(); const restored = adoptStoredThreadRows(key(), Date.now());
  expect(restored).toHaveLength(1); expect(restored[0]!.lastUsedAt).toBe(newer);
  const bytes = readFileSync(path()); expect(bytes.includes(Buffer.from("private-family"))).toBe(false); expect(bytes.includes(Buffer.from("private-thread"))).toBe(false); expect(bytes.includes(Buffer.from(k))).toBe(false);
  if (process.platform !== "win32") expect(statSync(path()).mode & 0o777).toBe(0o600);
});
test("unclean database is discarded and unknown version remains unchanged", () => {
  lease = acquireSpendLedgerOwner(); bind(seed()); lease.release();
  let db = new Database(path()); db.exec("UPDATE meta SET value=0 WHERE name='clean'"); db.close();
  lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]); lease.release();
  db = new Database(path()); db.exec("PRAGMA user_version=99"); db.close(); const before = readFileSync(path());
  lease = acquireSpendLedgerOwner(); key(); lease.release(); expect(readFileSync(path()).equals(before)).toBe(true);
});
test("issuer fence mismatch is unknown and account clearing preserves issuer", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); const k = bind(fence); recordIssuerSet(k, "account-a", fence, Date.now()); recordAccountPinsCleared("account-a"); lease.release();
  seed(); lease = acquireSpendLedgerOwner(); const restoredKey = key(); expect(adoptStoredThreadRows(restoredKey, Date.now())).toEqual([]); expect(adoptStoredIssuer(restoredKey, Date.now())?.issuer).toBe(CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER);
});
test("clear all followed by bind preserves the later bind", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); bind(fence); recordAllCleared(); bind(fence); lease.release(); lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toHaveLength(1);
});

test("expiry, future timestamps and identity replacement reject restored rows", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); bind(fence); lease.release();
  let db = new Database(path()); db.query("UPDATE threads SET last_used_at=?").run(Date.now() - 25 * 60 * 60_000); db.close();
  lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]); lease.release();
  lease = acquireSpendLedgerOwner(); bind(fence); lease.release();
  db = new Database(path()); db.query("UPDATE threads SET last_used_at=?").run(Date.now() + 60_000); db.close();
  lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]); lease.release();
  lease = acquireSpendLedgerOwner(); bind(fence); lease.release(); seed();
  lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
});
test("issuer expiration and future timestamps are absent", () => {
  for (const timestamp of [Date.now() - 25 * 60 * 60_000, Date.now() + 60_000]) {
    lease = acquireSpendLedgerOwner(); const fence = seed(); const k = key(); recordIssuerSet(k, "account-a", fence, Date.now()); lease.release();
    const db = new Database(path()); db.query("UPDATE issuers SET last_used_at=?").run(timestamp); db.close();
    lease = acquireSpendLedgerOwner(); expect(adoptStoredIssuer(key(), Date.now())).toBeUndefined(); lease.release(); lease = undefined;
  }
});
test("releasing transaction failure leaves the store unclean and emits identifier-free warnings", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); bind(fence); flushCodexAffinityStoreForTests();
  const blocker = new Database(path()); blocker.exec("BEGIN IMMEDIATE");
  const warnings: string[] = []; const original = console.warn; console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try { lease.release(); } finally { console.warn = original; blocker.exec("ROLLBACK"); blocker.close(); }
  expect(warnings.length).toBeGreaterThan(0); expect(warnings.join(" ")).not.toContain(home); expect(warnings.join(" ")).not.toContain("account-a"); expect(warnings.join(" ")).not.toContain("private-family");
  const db = new Database(path()); expect(db.query("SELECT value FROM meta WHERE name='clean'").get()).toEqual({ value: 0 }); db.close();
  lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
});
test("three failed flushes poison persistence until the next owner discards rows", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); bind(fence); flushCodexAffinityStoreForTests();
  const blocker = new Database(path()); blocker.exec("BEGIN IMMEDIATE");
  const original = console.warn; console.warn = () => {};
  try { flushCodexAffinityStoreForTests(); flushCodexAffinityStoreForTests(); flushCodexAffinityStoreForTests(); } finally { console.warn = original; blocker.exec("ROLLBACK"); blocker.close(); }
  lease.release(); lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
});

test("known and fence-less issuers restore with distinct outcomes", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); const known = key(); const unknown = codexConversationKeyFor("other-family", "other-thread");
  recordIssuerSet(known, "account-a", fence, Date.now()); recordIssuerSet(unknown, "account-a", null, Date.now()); lease.release();
  lease = acquireSpendLedgerOwner(); expect(adoptStoredIssuer(key(), Date.now())?.issuer).toBe("account-a");
  expect(adoptStoredIssuer(codexConversationKeyFor("other-family", "other-thread"), Date.now())?.issuer).toBe(CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER);
});
test("account clear followed by bind retains the later pin", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); bind(fence); recordAccountPinsCleared("account-a"); bind(fence); lease.release();
  lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toHaveLength(1);
});

test("overflow poisons the store and the next owner discards committed rows", () => {
  lease = acquireSpendLedgerOwner();
  const fence = seed();
  bind(fence);
  flushCodexAffinityStoreForTests();
  const db = new Database(path());
  expect(db.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 1 });
  db.close();
  const original = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 16385; i++) recordAccountPinsCleared("other-account");
  } finally {
    console.warn = original;
  }
  lease.release();
  lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
});

test("a close error after final commit leaves rows clean and restorable", () => {
  lease = acquireSpendLedgerOwner();
  bind(seed());
  // Throw after the real close: the final transaction has already committed.
  const originalClose = Database.prototype.close;
  const originalWarn = console.warn;
  let injected = false;
  Database.prototype.close = function (...args) {
    originalClose.apply(this, args);
    if (!injected) {
      injected = true;
      throw new Error("injected close failure");
    }
  };
  console.warn = () => {};
  try {
    lease.release();
  } finally {
    Database.prototype.close = originalClose;
    console.warn = originalWarn;
  }
  expect(injected).toBe(true);
  const db = new Database(path());
  expect(db.query("SELECT value FROM meta WHERE name='clean'").get()).toEqual({ value: 1 });
  db.close();
  lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toHaveLength(1);
});

test("an evicted anchor makes a later bind memory-only", () => {
  lease = acquireSpendLedgerOwner();
  const fence = seed();
  const evicted = key();
  for (let i = 0; i < 4096; i++) codexConversationKeyFor(`family-${i}`, `thread-${i}`);
  const now = Date.now();
  recordThreadBind(evicted, "legacy", { scope: "legacy", accountId: "account-a", fence, createdAt: now, lastUsedAt: now });
  lease.release();
  lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
});

test("release preserves live state, while an observed home change clears it", () => {
  lease = acquireSpendLedgerOwner();
  bind(seed());
  lease.release();
  lease = undefined;
  expect(live).toBeDefined();
  const otherHome = mkdtempSync(join(tmpdir(), "ocx-affinity-other-"));
  try {
    process.env.OPENCODEX_HOME = otherHome;
    key();
    expect(live).toBeUndefined();
  } finally {
    process.env.OPENCODEX_HOME = home;
    removeTreeWithRetry(otherHome);
  }
});

for (const kind of ["thread", "issuer"] as const) {
  test(`persisted ${kind} delete survives anchor eviction`, () => {
    lease = acquireSpendLedgerOwner(); const fence = seed(); const k = bind(fence);
    recordIssuerSet(k, "account-a", fence, Date.now()); flushCodexAffinityStoreForTests();
    for (let i = 0; i < 4096; i++) codexConversationKeyFor(`evict-family-${i}`, `evict-thread-${i}`);
    if (kind === "thread") recordThreadDelete(k, "legacy"); else recordIssuerDelete(k);
    lease.release(); lease = acquireSpendLedgerOwner();
    if (kind === "thread") expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
    else expect(adoptStoredIssuer(key(), Date.now())).toBeUndefined();
  });
}

test("adopted rows retain delete keys after anchor eviction", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); const k = bind(fence);
  recordIssuerSet(k, "account-a", fence, Date.now()); lease.release();
  lease = acquireSpendLedgerOwner(); const adopted = key();
  expect(adoptStoredThreadRows(adopted, Date.now())).toHaveLength(1);
  expect(adoptStoredIssuer(adopted, Date.now())?.issuer).toBe("account-a");
  for (let i = 0; i < 4096; i++) codexConversationKeyFor(`adopt-family-${i}`, `adopt-thread-${i}`);
  recordThreadDelete(adopted, "legacy"); recordIssuerDelete(adopted); lease.release();
  lease = acquireSpendLedgerOwner(); expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
  expect(adoptStoredIssuer(key(), Date.now())).toBeUndefined();
});

test("large worst-case batch flushes and restores newest rows", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); const now = Date.now();
  for (let i = 0; i < 7000; i++) {
    const k = codexConversationKeyFor(`batch-${i}`, `batch-${i}`);
    const scope = `model-detour:shared:${String(i).padStart(4, "0")}${"é".repeat(254)}`;
    recordThreadBind(k, scope, { scope, accountId: "account-a", fence, createdAt: now, lastUsedAt: now - 7000 + i });
  }
  flushCodexAffinityStoreForTests(); lease.release(); lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(codexConversationKeyFor("batch-6999", "batch-6999"), Date.now())).toHaveLength(1);
  const db = new Database(path()); expect(db.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 2048 }); db.close();
});

test("scoped lookup and account delete reach rows beyond the adoption limit", async () => {
  const affinity = await import("../../src/codex/routing/thread-affinity");
  registerThreadAffinityLiveState(); lease = acquireSpendLedgerOwner(); const fence = seed(); const k = key(); const now = Date.now();
  recordThreadBind(k, "shared", { scope: "shared", accountId: "account-a", fence, createdAt: now - 100, lastUsedAt: now - 100 });
  for (let i = 0; i < 70; i++) { const scope = `model-detour:shared:model-${i}`; recordThreadBind(k, scope, { scope, accountId: "account-a", fence, createdAt: now, lastUsedAt: now }); }
  lease.release(); lease = acquireSpendLedgerOwner(); const restored = key();
  affinity.getThreadAffinityScopes(restored);
  expect(affinity.getThreadAffinity(restored, "shared")?.accountId).toBe("account-a");
  affinity.deleteThreadAffinitiesForAccount(restored, "account-a"); lease.release(); lease = acquireSpendLedgerOwner(); key();
  const db = new Database(path()); expect(db.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 0 }); db.close();
});

test("lease acquisition prunes expired rows without affinity access", () => {
  lease = acquireSpendLedgerOwner(); bind(seed()); lease.release();
  const db = new Database(path()); db.query("UPDATE threads SET last_used_at=?").run(Date.now() - 25 * 60 * 60_000); db.close();
  lease = acquireSpendLedgerOwner();
  const check = new Database(path()); expect(check.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 0 }); check.close();
});

test("poisoned store prunes on its hourly timer", () => {
  const originalInterval = globalThis.setInterval; let tick: (() => void) | undefined;
  globalThis.setInterval = ((fn: () => void, ms: number) => { if (ms === 3600000) tick = fn; return originalInterval(fn, ms); }) as typeof setInterval;
  try {
    lease = acquireSpendLedgerOwner(); bind(seed()); flushCodexAffinityStoreForTests();
    const warn = console.warn; console.warn = () => {};
    try { for (let i = 0; i < 16385; i++) recordAccountPinsCleared("other-account"); } finally { console.warn = warn; }
    expect(tick).toBeDefined(); const realNow = Date.now; Date.now = () => realNow() + 25 * 60 * 60_000;
    try { tick!(); } finally { Date.now = realNow; }
    const check = new Database(path()); expect(check.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 0 }); expect(check.query("SELECT value FROM meta WHERE name='clean'").get()).toEqual({ value: 0 }); check.close();
  } finally { globalThis.setInterval = originalInterval; }
});

test("account deletion removes unadopted scopes and blocks pending adoption", async () => {
  const affinity = await import("../../src/codex/routing/thread-affinity");
  registerThreadAffinityLiveState(); lease = acquireSpendLedgerOwner(); const fence = seed(); const k = key(); const now = Date.now();
  for (let i = 0; i < 70; i++) { const scope = `model-detour:shared:delete-${i}`; recordThreadBind(k, scope, { scope, accountId: "account-a", fence, createdAt: now, lastUsedAt: now }); }
  lease.release(); lease = acquireSpendLedgerOwner(); const restored = key();
  affinity.deleteThreadAffinitiesForAccount(restored, "account-a");
  expect(affinity.getModelDetourAffinity(restored, "delete-69", "shared")).toBeUndefined();
  lease.release(); lease = acquireSpendLedgerOwner();
  const db = new Database(path()); expect(db.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 0 }); db.close();
});

test("SQLITE_FULL triggers one prune-only transaction before retrying the flush", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); const k = bind(fence);
  const original = Database.prototype.exec; let begins = 0;
  Database.prototype.exec = function (sql: string) {
    if (sql === "BEGIN IMMEDIATE" && ++begins === 1) throw Object.assign(new Error("injected full"), { code: "SQLITE_FULL" });
    return original.call(this, sql);
  };
  try { flushCodexAffinityStoreForTests(); } finally { Database.prototype.exec = original; }
  expect(begins).toBe(3);
  lease.release(); lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toHaveLength(1); expect(k).toBeDefined();
});

test("a pin touched since its last flush survives a chunk prune at the row limit", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); const k = bind(fence); flushCodexAffinityStoreForTests();
  const now = Date.now();
  const db = new Database(path()); const insert = db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN"); for (let i = 0; i < 2047; i++) insert.run(`filler-${i}`, "legacy", "account-a", fence, now - 500, now - 500); db.exec("COMMIT"); db.close();
  recordThreadTouch(k, "legacy"); live!.lastUsedAt = now;
  for (let i = 0; i < 256; i++) { const fresh = codexConversationKeyFor(`fresh-${i}`, `fresh-${i}`); recordThreadBind(fresh, "shared", { scope: "shared", accountId: "account-a", fence, createdAt: now, lastUsedAt: now }); }
  flushCodexAffinityStoreForTests(); lease.release(); lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toHaveLength(1);
});
test("a failed flush still deletes expired rows", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); bind(fence); flushCodexAffinityStoreForTests();
  const db = new Database(path());
  db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)").run("expired-row", "legacy", "account-a", fence, Date.now() - 25 * 60 * 60_000, Date.now() - 25 * 60 * 60_000);
  db.exec("CREATE TRIGGER fail_bind BEFORE INSERT ON threads WHEN NEW.account_id = 'boom' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  db.close();
  recordThreadBind(codexConversationKeyFor("boom-family", "boom-family"), "legacy", { scope: "legacy", accountId: "boom", fence, createdAt: Date.now(), lastUsedAt: Date.now() });
  flushCodexAffinityStoreForTests();
  const check = new Database(path());
  expect((check.query("SELECT count(*) AS n FROM threads WHERE row_key = 'expired-row'").get() as { n: number }).n).toBe(0);
  check.exec("DROP TRIGGER fail_bind"); check.close();
});
test("a lease acquired inside a passive read does not open the store", async () => {
  await runPassiveRead(async () => { lease = acquireSpendLedgerOwner(); });
  expect(existsSync(path())).toBe(false);
});
test("a release inside a passive read still commits the final flush", async () => {
  lease = acquireSpendLedgerOwner(); bind(seed());
  await runPassiveRead(async () => { lease!.release(); });
  lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toHaveLength(1);
});


test("a pin bound and touched in the same pending batch survives a chunk prune", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); flushCodexAffinityStoreForTests();
  const now = Date.now();
  const db = new Database(path()); const insert = db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN"); for (let i = 0; i < 2048; i++) insert.run(`filler-${i}`, "legacy", "account-a", fence, now - 500, now - 500); db.exec("COMMIT"); db.close();
  const k = bind(fence); recordThreadTouch(k, "legacy"); live!.lastUsedAt = now;
  for (let i = 0; i < 255; i++) { const fresh = codexConversationKeyFor(`batch-${i}`, `batch-${i}`); recordThreadBind(fresh, "shared", { scope: "shared", accountId: "account-a", fence, createdAt: now, lastUsedAt: now }); }
  flushCodexAffinityStoreForTests(); lease.release(); lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toHaveLength(1);
});

test("row keys carried across a lease change still let a delete reach its row after anchor eviction", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); const k = bind(fence);
  recordIssuerSet(k, "account-a", fence, Date.now()); lease.release();
  lease = acquireSpendLedgerOwner(); const adopted = key();
  expect(adoptStoredThreadRows(adopted, Date.now())).toHaveLength(1);
  expect(adoptStoredIssuer(adopted, Date.now())?.issuer).toBe("account-a");
  lease.release(); lease = acquireSpendLedgerOwner();
  for (let i = 0; i < 4096; i++) codexConversationKeyFor(`carry-family-${i}`, `carry-thread-${i}`);
  recordThreadDelete(adopted, "legacy"); recordIssuerDelete(adopted); lease.release();
  resetCodexAffinityStoreForTests(); lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
  expect(adoptStoredIssuer(key(), Date.now())).toBeUndefined();
});

test("row keys survive a failed reopen, so a later delete still reaches its row after anchor eviction", () => {
  lease = acquireSpendLedgerOwner(); const fence = seed(); bind(fence); lease.release();
  lease = acquireSpendLedgerOwner(); const adopted = key();
  expect(adoptStoredThreadRows(adopted, Date.now())).toHaveLength(1);
  lease.release();
  // One reacquisition cannot open the database (a directory sits at its path).
  renameSync(path(), `${path()}.aside`); mkdirSync(path());
  lease = acquireSpendLedgerOwner(); lease.release();
  removeTreeWithRetry(path()); renameSync(`${path()}.aside`, path());
  lease = acquireSpendLedgerOwner();
  for (let i = 0; i < 4096; i++) codexConversationKeyFor(`reopen-family-${i}`, `reopen-thread-${i}`);
  recordThreadDelete(adopted, "legacy"); lease.release();
  resetCodexAffinityStoreForTests(); lease = acquireSpendLedgerOwner();
  expect(adoptStoredThreadRows(key(), Date.now())).toEqual([]);
});
