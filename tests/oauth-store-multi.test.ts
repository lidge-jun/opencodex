import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAccountCredential,
  getAccountSet,
  getCredential,
  listAccounts,
  markAccountNeedsReauth,
  removeAccount,
  removeCredential,
  saveAccountCredential,
  saveCredential,
  setAccountAlias,
  setActiveAccount,
} from "../src/oauth/store";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-store-multi-test");
let previousOpencodexHome: string | undefined;

const cred = (over: Partial<{ access: string; refresh: string; expires: number; email: string; accountId: string; projectId: string }> = {}) => ({
  access: "access-1",
  refresh: "refresh-1",
  expires: Date.now() + 3600_000,
  ...over,
});

describe("multi-account auth store", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("legacy single-credential auth.json normalizes and round-trips without losing login", async () => {
    const authPath = join(TEST_DIR, "auth.json");
    mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({
      xai: { access: "legacy-access", refresh: "legacy-refresh", expires: Date.now() + 1000, email: "old@example.com" },
    }));
    expect(getCredential("xai")?.access).toBe("legacy-access");
    // Any mutation persists the new shape + writes the downgrade backup.
    await saveCredential("xai", cred({ email: "old@example.com", access: "new-access" }));
    expect(getCredential("xai")?.access).toBe("new-access");
    const raw = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(Array.isArray(raw.xai.accounts)).toBe(true);
    expect(existsSync(`${authPath}.pre-multiauth`)).toBe(true);
  });

  test("legacy credential WITHOUT identity gets a deterministic account id across loads", async () => {
    // Legacy stores are re-normalized on EVERY load without being persisted, so the
    // derived id must be stable: a time-salted id would make getAccountSet and
    // getAccountCredential disagree (spurious logout) and refresh persists no-op.
    const authPath = join(TEST_DIR, "auth.json");
    mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({
      cursor: { access: "legacy-access", refresh: "legacy-refresh", expires: Date.now() + 3600_000 },
    }));
    const set = getAccountSet("cursor");
    expect(set).not.toBeNull();
    // Separate load (fresh normalization) must resolve the SAME account id.
    expect(getAccountCredential("cursor", set!.activeAccountId)?.access).toBe("legacy-access");
    expect(getAccountSet("cursor")!.activeAccountId).toBe(set!.activeAccountId);
    // A rotated refresh persisted against that id must land (not silently no-op).
    await saveAccountCredential("cursor", set!.activeAccountId, {
      access: "rotated-access", refresh: "rotated-refresh", expires: Date.now() + 3600_000,
    });
    expect(getCredential("cursor")?.access).toBe("rotated-access");
    expect(getCredential("cursor")?.refresh).toBe("rotated-refresh");
  });

  test("new identity appends a second account and activates it", async () => {
    await saveCredential("anthropic", cred({ email: "a@example.com", accountId: "acct-a" }));
    await saveCredential("anthropic", cred({ email: "b@example.com", accountId: "acct-b", access: "access-b" }));
    expect(listAccounts("anthropic").length).toBe(2);
    expect(getCredential("anthropic")?.email).toBe("b@example.com");
  });

  test("same identity replaces credential without duplicating", async () => {
    await saveCredential("anthropic", cred({ email: "a@example.com", accountId: "acct-a" }));
    await saveCredential("anthropic", cred({ email: "a@example.com", accountId: "acct-a", access: "rotated", refresh: "rotated-refresh" }));
    expect(listAccounts("anthropic").length).toBe(1);
    expect(getCredential("anthropic")?.access).toBe("rotated");
  });

  test("identity-less credential replaces active slot (no duplicate on refresh rotation)", async () => {
    await saveCredential("cursor", cred());
    await saveCredential("cursor", cred({ access: "rotated", refresh: "totally-different-refresh" }));
    expect(listAccounts("cursor").length).toBe(1);
    expect(getCredential("cursor")?.access).toBe("rotated");
  });

  test("cursor with distinct accountIds appends a second account", async () => {
    await saveCredential("cursor", cred({ accountId: "google-oauth2|user_a", access: "access-a" }));
    await saveCredential("cursor", cred({ accountId: "google-oauth2|user_b", access: "access-b" }));
    expect(listAccounts("cursor").length).toBe(2);
    expect(getCredential("cursor")?.access).toBe("access-b");
  });

  test("chatgpt stays single-slot even with distinct identities", async () => {
    await saveCredential("chatgpt", cred({ email: "a@example.com", accountId: "one" }));
    await saveCredential("chatgpt", cred({ email: "b@example.com", accountId: "two", access: "b-access" }));
    expect(listAccounts("chatgpt").length).toBe(1);
    expect(getCredential("chatgpt")?.email).toBe("b@example.com");
  });

  test("setActiveAccount switches what getCredential returns", async () => {
    await saveCredential("anthropic", cred({ email: "a@example.com", accountId: "acct-a", access: "access-a" }));
    await saveCredential("anthropic", cred({ email: "b@example.com", accountId: "acct-b", access: "access-b" }));
    const set = getAccountSet("anthropic")!;
    const idA = set.accounts.find(a => a.credential.email === "a@example.com")!.id;
    expect(await setActiveAccount("anthropic", idA)).toBe(true);
    expect(getCredential("anthropic")?.access).toBe("access-a");
    expect(await setActiveAccount("anthropic", "nope")).toBe(false);
  });

  test("account aliases persist independently from identity and routing", async () => {
    await saveCredential("anthropic", cred({ email: "alias@example.test", accountId: "alias-id" }));
    const id = getAccountSet("anthropic")!.activeAccountId;
    expect(await setAccountAlias("anthropic", id, "Work Claude")).toBe(true);
    expect(listAccounts("anthropic")[0]?.alias).toBe("Work Claude");
    expect(getAccountSet("anthropic")!.activeAccountId).toBe(id);
    expect(await setAccountAlias("anthropic", id, undefined)).toBe(true);
    expect(listAccounts("anthropic")[0]?.alias).toBeUndefined();
  });

  test("saveAccountCredential persists refresh for a non-active account without switching active", async () => {
    await saveCredential("xai", cred({ email: "a@example.com", accountId: "acct-a" }));
    await saveCredential("xai", cred({ email: "b@example.com", accountId: "acct-b", access: "access-b" }));
    const set = getAccountSet("xai")!;
    const idA = set.accounts.find(a => a.credential.email === "a@example.com")!.id;
    await saveAccountCredential("xai", idA, cred({ email: "a@example.com", accountId: "acct-a", access: "refreshed-a" }));
    expect(getAccountCredential("xai", idA)?.access).toBe("refreshed-a");
    expect(getCredential("xai")?.access).toBe("access-b"); // active unchanged
  });

  test("removeAccount of active promotes next; last removal deletes provider", async () => {
    await saveCredential("xai", cred({ email: "a@example.com", accountId: "acct-a", access: "access-a" }));
    await saveCredential("xai", cred({ email: "b@example.com", accountId: "acct-b", access: "access-b" }));
    const set = getAccountSet("xai")!;
    expect(await removeAccount("xai", set.activeAccountId)).toBe(true);
    expect(getCredential("xai")?.access).toBe("access-a");
    const remaining = getAccountSet("xai")!;
    expect(await removeAccount("xai", remaining.activeAccountId)).toBe(true);
    expect(getCredential("xai")).toBeNull();
    expect(getAccountSet("xai")).toBeNull();
  });

  test("removeCredential removes only the active account", async () => {
    await saveCredential("anthropic", cred({ email: "a@example.com", accountId: "acct-a", access: "access-a" }));
    await saveCredential("anthropic", cred({ email: "b@example.com", accountId: "acct-b", access: "access-b" }));
    await removeCredential("anthropic"); // active is b
    expect(listAccounts("anthropic").length).toBe(1);
    expect(getCredential("anthropic")?.access).toBe("access-a");
  });

  test("needsReauth flag persists and clears on fresh save", async () => {
    await saveCredential("xai", cred({ email: "a@example.com", accountId: "acct-a" }));
    const id = getAccountSet("xai")!.activeAccountId;
    await markAccountNeedsReauth("xai", id, true);
    expect(listAccounts("xai")[0]?.needsReauth).toBe(true);
    await saveCredential("xai", cred({ email: "a@example.com", accountId: "acct-a", access: "fresh" }));
    expect(listAccounts("xai")[0]?.needsReauth).toBeUndefined();
  });

  test("invalid account entries are dropped on load", async () => {
    const authPath = join(TEST_DIR, "auth.json");
    mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({
      xai: { activeAccountId: "gone", accounts: [
        { id: "ok", credential: { access: "a", refresh: "r", expires: 1 } },
        { id: "bad", credential: { access: 42 } },
        { notAnAccount: true },
      ] },
    }));
    const set = getAccountSet("xai")!;
    expect(set.accounts.length).toBe(1);
    expect(set.activeAccountId).toBe("ok"); // dangling active healed
  });
});
