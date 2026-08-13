import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAntigravityAccountImportAdapter } from "../src/oauth/account-import/google-antigravity-adapter";
import { parseCockpitAccountDocument } from "../src/oauth/account-import/parser";
import { importAccounts } from "../src/oauth/account-import/service";
import {
  ACCOUNT_IMPORT_FORMAT,
  ACCOUNT_IMPORT_MAX_RECORDS,
  ACCOUNT_IMPORT_PROVIDER,
  AccountImportAbortError,
  type AccountImportAdapter,
  type ValidatedAntigravityCredential,
} from "../src/oauth/account-import/types";
import { getAccountSet, upsertCredentialByIdentity } from "../src/oauth/store";

const CANARY = "cockpit-canary-refresh-token-DO-NOT-LEAK";
const originalHome = process.env.OPENCODEX_HOME;
let testHome = "";

afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { email: "user@example.com", refresh_token: "refresh-safe", ...overrides };
}

describe("Cockpit account-import parser", () => {
  test("accepts only the proven array schema and ignores validated tags/notes", () => {
    const parsed = parseCockpitAccountDocument([
      record({ tags: ["personal"], notes: "local label only" }),
    ]);
    expect(parsed).toEqual({
      ok: true,
      records: [{ index: 0, record: { email: "user@example.com", refreshToken: "refresh-safe" } }],
    });

    expect(parseCockpitAccountDocument({ accounts: [record()] })).toEqual({ ok: false, code: "invalid_document" });
    expect(parseCockpitAccountDocument([])).toEqual({ ok: false, code: "invalid_document" });
    expect(parseCockpitAccountDocument(Array.from({ length: ACCOUNT_IMPORT_MAX_RECORDS + 1 }, () => record())))
      .toEqual({ ok: false, code: "invalid_document" });
  });

  test("marks wrong keys, metadata types, email bounds, and token controls as invalid records", () => {
    const parsed = parseCockpitAccountDocument([
      record({ refreshToken: "alias-not-accepted" }),
      record({ tags: "not-an-array" }),
      record({ notes: [] }),
      record({ email: `${"a".repeat(250)}@x.io` }),
      record({ refresh_token: "token\ncontrol" }),
      record({ refresh_token: "x".repeat(16 * 1024 + 1) }),
      "not-an-object",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.records.every(item => "code" in item && item.code === "invalid_record")).toBe(true);
  });

  test("marks later duplicate emails in one document as invalid records", () => {
    const parsed = parseCockpitAccountDocument([
      record({ email: "User@example.com", refresh_token: "first" }),
      record({ email: "user@example.com", refresh_token: "second" }),
      record({ email: "other@example.com", refresh_token: "third" }),
    ]);
    expect(parsed).toEqual({
      ok: true,
      records: [
        { index: 0, record: { email: "user@example.com", refreshToken: "first" } },
        { index: 1, code: "invalid_record" },
        { index: 2, record: { email: "other@example.com", refreshToken: "third" } },
      ],
    });
  });
});

describe("Cockpit account-import service and adapter", () => {
  test("rejects unsupported provider/format before traversing the credential document", async () => {
    const poisonousDocument = new Proxy({}, { ownKeys: () => { throw new Error(CANARY); } });
    expect(await importAccounts({ provider: "openai", format: ACCOUNT_IMPORT_FORMAT, document: poisonousDocument }))
      .toEqual({ ok: false, status: 400, code: "unsupported_provider" });
    expect(await importAccounts({ provider: ACCOUNT_IMPORT_PROVIDER, format: "unknown", document: poisonousDocument }))
      .toEqual({ ok: false, status: 400, code: "unsupported_format" });
  });

  test("processes valid records sequentially and exposes only fixed result fields", async () => {
    let active = 0;
    let highWater = 0;
    const adapter: AccountImportAdapter = {
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      async importRecord() {
        active += 1;
        highWater = Math.max(highWater, active);
        await Bun.sleep(2);
        active -= 1;
        return { status: "imported", code: "imported" };
      },
    };
    const result = await importAccounts({
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      document: [record(), record({ email: "second@example.com" })],
    }, { resolveAdapter: () => ({ ok: true, adapter }) });
    expect(result.ok).toBe(true);
    expect(highWater).toBe(1);
    if (result.ok) {
      expect(result.result).toEqual({
        totalCount: 2,
        importedCount: 2,
        updatedCount: 0,
        failedCount: 0,
        unsupportedCount: 0,
        results: [
          { index: 0, status: "imported", code: "imported" },
          { index: 1, status: "imported", code: "imported" },
        ],
      });
      expect(JSON.stringify(result.result)).not.toContain(CANARY);
    }
  });

  test("maps provider rejection, mismatch, missing project, and write failure to fixed codes", async () => {
    const baseCredential = {
      access: "access-safe",
      refresh: CANARY,
      expires: Date.now() + 60_000,
      email: "user@example.com",
      projectId: "project-safe",
    };
    const rejected = createAntigravityAccountImportAdapter({
      validate: async () => { throw new Error(`upstream echoed ${CANARY}`); },
      upsert: async () => "inserted",
    });
    expect(await rejected.importRecord({ email: "user@example.com", refreshToken: CANARY }))
      .toEqual({ status: "failed", code: "credential_rejected" });

    const mismatch = createAntigravityAccountImportAdapter({
      validate: async () => ({ ...baseCredential, email: "other@example.com" }),
      upsert: async () => "inserted",
    });
    expect(await mismatch.importRecord({ email: "user@example.com", refreshToken: CANARY }))
      .toEqual({ status: "failed", code: "identity_mismatch" });

    const noProviderEmail = createAntigravityAccountImportAdapter({
      validate: async () => ({ ...baseCredential, email: undefined }),
      upsert: async () => "inserted",
    });
    expect(await noProviderEmail.importRecord({ email: "user@example.com", refreshToken: CANARY }))
      .toEqual({ status: "failed", code: "credential_rejected" });

    const noProject = createAntigravityAccountImportAdapter({
      validate: async () => ({ ...baseCredential, projectId: undefined }),
      upsert: async () => "inserted",
    });
    expect(await noProject.importRecord({ email: "user@example.com", refreshToken: CANARY }))
      .toEqual({ status: "failed", code: "missing_project" });

    const writeFailure = createAntigravityAccountImportAdapter({
      validate: async () => baseCredential,
      upsert: async () => { throw new Error(`disk failure ${CANARY}`); },
    });
    const outcome = await writeFailure.importRecord({ email: "user@example.com", refreshToken: CANARY });
    expect(outcome).toEqual({ status: "failed", code: "persist_failed" });
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
  });

  test("returns import_cancelled when the request is already aborted before import starts", async () => {
    let calls = 0;
    const adapter: AccountImportAdapter = {
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      async importRecord() {
        calls += 1;
        return { status: "imported", code: "imported" };
      },
    };
    const controller = new AbortController();
    controller.abort();
    expect(await importAccounts({
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      document: [record()],
      signal: controller.signal,
    }, { resolveAdapter: () => ({ ok: true, adapter }) }))
      .toEqual({ ok: false, status: 408, code: "import_cancelled" });
    expect(calls).toBe(0);
  });

  test("cancels a delayed validation before upsert and does not begin following records", async () => {
    const controller = new AbortController();
    let resolveValidation: ((credential: ValidatedAntigravityCredential) => void) | undefined;
    const delayedValidation = new Promise<ValidatedAntigravityCredential>(resolve => {
      resolveValidation = resolve;
    });
    let validationCalls = 0;
    let upsertCalls = 0;
    const adapter = createAntigravityAccountImportAdapter({
      validate: async () => {
        validationCalls += 1;
        return delayedValidation;
      },
      upsert: async () => {
        upsertCalls += 1;
        return "inserted";
      },
    });

    const imported = importAccounts({
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      document: [record(), record({ email: "second@example.com" })],
      signal: controller.signal,
    }, { resolveAdapter: () => ({ ok: true, adapter }) });

    controller.abort();
    resolveValidation?.({
      access: "access-safe",
      refresh: "refresh-safe",
      expires: Date.now() + 60_000,
      email: "user@example.com",
      projectId: "project-safe",
    });

    expect(await imported).toEqual({ ok: false, status: 408, code: "import_cancelled" });
    expect(validationCalls).toBe(1);
    expect(upsertCalls).toBe(0);
  });

  test("cancels between validation and atomic upsert", async () => {
    const controller = new AbortController();
    let upsertCalls = 0;
    const credential = {
      access: "access-safe",
      refresh: "refresh-safe",
      expires: Date.now() + 60_000,
      email: "user@example.com",
      get projectId() {
        controller.abort();
        return "project-safe";
      },
    };
    const adapter = createAntigravityAccountImportAdapter({
      validate: async () => credential,
      upsert: async () => {
        upsertCalls += 1;
        return "inserted";
      },
    });

    expect(await importAccounts({
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      document: [record()],
      signal: controller.signal,
    }, { resolveAdapter: () => ({ ok: true, adapter }) }))
      .toEqual({ ok: false, status: 408, code: "import_cancelled" });
    expect(upsertCalls).toBe(0);
  });

  test("preserves a committed-change signal when a later record is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const adapter: AccountImportAdapter = {
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      async importRecord() {
        calls += 1;
        if (calls === 1) return { status: "imported", code: "imported" };
        controller.abort();
        throw new AccountImportAbortError();
      },
    };

    expect(await importAccounts({
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      document: [record(), record({ email: "second@example.com" })],
      signal: controller.signal,
    }, { resolveAdapter: () => ({ ok: true, adapter }) }))
      .toEqual({ ok: false, status: 408, code: "import_cancelled", changed: true });
    expect(calls).toBe(2);
  });

  test("records a committed outcome before observing cancellation from the same record", async () => {
    const controller = new AbortController();
    const adapter: AccountImportAdapter = {
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      async importRecord() {
        controller.abort();
        return { status: "updated", code: "updated" };
      },
    };

    expect(await importAccounts({
      provider: ACCOUNT_IMPORT_PROVIDER,
      format: ACCOUNT_IMPORT_FORMAT,
      document: [record()],
      signal: controller.signal,
    }, { resolveAdapter: () => ({ ok: true, adapter }) }))
      .toEqual({ ok: false, status: 408, code: "import_cancelled", changed: true });
  });
});

describe("Cockpit account-import atomic identity upsert", () => {
  test("a duplicate updates one existing identity without appending a second row", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-account-import-store-"));
    process.env.OPENCODEX_HOME = testHome;
    const first = await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-one",
      refresh: "refresh-one",
      expires: 1,
      email: "USER@example.com",
      projectId: "project-one",
    });
    const second = await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-two",
      refresh: "refresh-two",
      expires: 2,
      email: "user@example.com",
      projectId: "project-two",
    });
    expect(first).toBe("inserted");
    expect(second).toBe("updated");
    const set = getAccountSet(ACCOUNT_IMPORT_PROVIDER);
    expect(set?.accounts).toHaveLength(1);
    expect(set?.accounts[0]?.credential).toMatchObject({ access: "access-two", projectId: "project-two" });
    expect(JSON.parse(readFileSync(join(testHome, "auth.json"), "utf8"))[ACCOUNT_IMPORT_PROVIDER].accounts).toHaveLength(1);
  });

  test("clears a terminal reauth flag when the same identity is re-imported", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-account-import-store-"));
    process.env.OPENCODEX_HOME = testHome;
    await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-one",
      refresh: "refresh-one",
      expires: 1,
      email: "user@example.com",
      projectId: "project-one",
    });
    const authPath = join(testHome, "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { accounts: Array<{ needsReauth?: boolean }> }>;
    auth[ACCOUNT_IMPORT_PROVIDER]!.accounts[0]!.needsReauth = true;
    writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });

    expect(await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-two",
      refresh: "refresh-two",
      expires: 2,
      email: "user@example.com",
      projectId: "project-two",
    })).toBe("updated");
    const set = getAccountSet(ACCOUNT_IMPORT_PROVIDER);
    expect(set?.accounts).toHaveLength(1);
    expect(set?.accounts[0]?.needsReauth).toBeUndefined();
    expect(set?.accounts[0]?.credential).toMatchObject({ access: "access-two", projectId: "project-two" });
  });

  test("keeps distinct accountId identities even when email matches", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-account-import-store-"));
    process.env.OPENCODEX_HOME = testHome;
    const first = await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-one",
      refresh: "refresh-one",
      expires: 1,
      email: "shared@example.com",
      accountId: "google-subject-1",
      projectId: "project-one",
    });
    const second = await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-two",
      refresh: "refresh-two",
      expires: 2,
      email: "shared@example.com",
      accountId: "google-subject-2",
      projectId: "project-two",
    });
    expect(first).toBe("inserted");
    expect(second).toBe("inserted");
    const set = getAccountSet(ACCOUNT_IMPORT_PROVIDER);
    expect(set?.accounts).toHaveLength(2);
    expect(set?.accounts.map(account => account.credential.accountId).sort()).toEqual([
      "google-subject-1",
      "google-subject-2",
    ]);
    expect(set?.accounts.every(account => account.credential.email === "shared@example.com")).toBe(true);
  });

  test("upgrades an email-only legacy row when the same verified Google identity is imported", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-account-import-store-"));
    process.env.OPENCODEX_HOME = testHome;
    const first = await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-legacy",
      refresh: "refresh-legacy",
      expires: 1,
      email: "shared@example.com",
      projectId: "project-legacy",
    });
    const second = await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-upgraded",
      refresh: "refresh-upgraded",
      expires: 2,
      email: "SHARED@example.com",
      accountId: "google-subject-1",
      projectId: "project-upgraded",
    });
    expect(first).toBe("inserted");
    expect(second).toBe("updated");
    const set = getAccountSet(ACCOUNT_IMPORT_PROVIDER);
    expect(set?.accounts).toHaveLength(1);
    expect(set?.accounts[0]?.credential).toMatchObject({
      access: "access-upgraded",
      refresh: "refresh-upgraded",
      email: "SHARED@example.com",
      accountId: "google-subject-1",
      projectId: "project-upgraded",
    });
    expect(JSON.parse(readFileSync(join(testHome, "auth.json"), "utf8"))[ACCOUNT_IMPORT_PROVIDER].accounts).toHaveLength(1);
  });

  test("prefers an exact accountId row over an earlier email-only legacy row", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-account-import-store-"));
    process.env.OPENCODEX_HOME = testHome;
    const authPath = join(testHome, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      [ACCOUNT_IMPORT_PROVIDER]: {
        activeAccountId: "legacy-email-row",
        accounts: [
          {
            id: "legacy-email-row",
            credential: {
              access: "access-legacy",
              refresh: "refresh-legacy",
              expires: 1,
              email: "shared@example.com",
              projectId: "project-legacy",
            },
            addedAt: 1,
          },
          {
            id: "stable-subject-row",
            credential: {
              access: "access-stable",
              refresh: "refresh-stable",
              expires: 1,
              email: "shared@example.com",
              accountId: "google-subject-1",
              projectId: "project-stable",
            },
            addedAt: 2,
          },
        ],
      },
    }), { mode: 0o600 });

    expect(await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-updated",
      refresh: "refresh-updated",
      expires: 2,
      email: "SHARED@example.com",
      accountId: "google-subject-1",
      projectId: "project-updated",
    })).toBe("updated");

    const set = getAccountSet(ACCOUNT_IMPORT_PROVIDER);
    expect(set?.accounts).toHaveLength(2);
    expect(set?.activeAccountId).toBe("legacy-email-row");
    const legacyCredential = set?.accounts.find(account => account.id === "legacy-email-row")?.credential;
    expect(legacyCredential?.access).toBe("access-legacy");
    expect(legacyCredential?.accountId).toBeUndefined();
    expect(set?.accounts.find(account => account.id === "stable-subject-row")?.credential)
      .toMatchObject({ access: "access-updated", accountId: "google-subject-1" });
    expect(set?.accounts.filter(account => account.credential.accountId === "google-subject-1"))
      .toHaveLength(1);
  });

  test("does not overwrite a stable accountId row from an incoming email-only credential", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-account-import-store-"));
    process.env.OPENCODEX_HOME = testHome;
    const first = await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-stable",
      refresh: "refresh-stable",
      expires: 1,
      email: "shared@example.com",
      accountId: "google-subject-1",
      projectId: "project-stable",
    });
    const second = await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-legacy",
      refresh: "refresh-legacy",
      expires: 2,
      email: "shared@example.com",
      projectId: "project-legacy",
    });
    expect(first).toBe("inserted");
    expect(second).toBe("inserted");
    const set = getAccountSet(ACCOUNT_IMPORT_PROVIDER);
    expect(set?.accounts).toHaveLength(2);
    expect(set?.accounts.find(account => account.credential.accountId === "google-subject-1")?.credential.access)
      .toBe("access-stable");
    expect(set?.accounts.find(account => !account.credential.accountId)?.credential.access).toBe("access-legacy");
  });

  test("rejects credentials without verified identity", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-account-import-store-"));
    process.env.OPENCODEX_HOME = testHome;
    await expect(upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-none",
      refresh: "refresh-none",
      expires: 1,
    })).rejects.toThrow("Refusing to persist OAuth credential without verified identity");
    expect(getAccountSet(ACCOUNT_IMPORT_PROVIDER)).toBeNull();
  });

  test("preserves an already selected active account when importing another identity", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-account-import-store-"));
    process.env.OPENCODEX_HOME = testHome;
    await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-one",
      refresh: "refresh-one",
      expires: 1,
      email: "first@example.com",
      projectId: "project-one",
    });
    const before = getAccountSet(ACCOUNT_IMPORT_PROVIDER);
    expect(before?.activeAccountId).toBeTruthy();
    const activeBefore = before!.activeAccountId;

    await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-two",
      refresh: "refresh-two",
      expires: 2,
      email: "second@example.com",
      projectId: "project-two",
    });
    const after = getAccountSet(ACCOUNT_IMPORT_PROVIDER);
    expect(after?.accounts).toHaveLength(2);
    expect(after?.activeAccountId).toBe(activeBefore);

    await upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, {
      access: "access-one-rotated",
      refresh: "refresh-one-rotated",
      expires: 3,
      email: "first@example.com",
      projectId: "project-one-rotated",
    });
    expect(getAccountSet(ACCOUNT_IMPORT_PROVIDER)?.activeAccountId).toBe(activeBefore);
  });
});
