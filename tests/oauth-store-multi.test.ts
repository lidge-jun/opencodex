import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { INTERNAL_DEADLINE_MS, STORE_BUDGET_MS } from "./helpers/test-budget";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
} from "../src/lib/windows-secret-acl";
import {
  getAccountCredential,
  getAccountSet,
  getCredential,
  credentialGeneration,
  listAccounts,
  markAccountNeedsReauth,
  markAccountNeedsReauthIfGeneration,
  mutateStore,
  OAuthMutationBusyError,
  oauthMutationTailSnapshot,
  reconcileOAuthReauthState,
  removeAccount,
  removeCredential,
  saveAccountCredential,
  saveCredential,
  setAccountAlias,
  setActiveAccount,
} from "../src/oauth/store";
import type { OAuthCredentials } from "../src/oauth/types";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-store-multi-test");
let previousOpencodexHome: string | undefined;

const cred = (over: Partial<OAuthCredentials> = {}): OAuthCredentials => ({
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
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(() => ({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: "",
    }));
  });

  afterEach(() => {
    setIcaclsRunnerForTests(null);
    resetHardenedStateForTests();
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

  test("Kiro account metadata stays attached to each distinct identity", async () => {
    await saveCredential("kiro", cred({
      accountId: "profile-a",
      access: "kiro-a",
      kiro: { profileArn: "profile-a", apiRegion: "us-east-1", clientSecret: "secret-a" },
    }));
    await saveCredential("kiro", cred({
      accountId: "profile-b",
      access: "kiro-b",
      kiro: { profileArn: "profile-b", apiRegion: "eu-west-1", clientSecret: "secret-b" },
    }));

    const set = getAccountSet("kiro")!;
    expect(set.accounts).toHaveLength(2);
    expect(set.accounts.find(account => account.credential.accountId === "profile-a")?.credential.kiro).toMatchObject({
      profileArn: "profile-a",
      apiRegion: "us-east-1",
      clientSecret: "secret-a",
    });
    expect(set.accounts.find(account => account.credential.accountId === "profile-b")?.credential.kiro).toMatchObject({
      profileArn: "profile-b",
      apiRegion: "eu-west-1",
      clientSecret: "secret-b",
    });
    expect(getCredential("kiro")).toMatchObject({ accountId: "profile-b", access: "kiro-b" });
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

  test("explicit add-account preserves an identity-less slot and activates the new one", async () => {
    await saveCredential("cursor", cred({ access: "legacy-access", refresh: "legacy-refresh" }));
    const legacySlotId = getAccountSet("cursor")!.activeAccountId;

    await saveCredential("cursor", cred({
      access: "new-access",
      refresh: "new-refresh",
    }), { preserveIdentityless: true });

    const set = getAccountSet("cursor")!;
    expect(set.accounts).toHaveLength(2);
    expect(set.activeAccountId).not.toBe(legacySlotId);
    expect(getAccountCredential("cursor", legacySlotId)).toMatchObject({
      access: "legacy-access",
      refresh: "legacy-refresh",
    });
    expect(getCredential("cursor")).toMatchObject({
      access: "new-access",
      refresh: "new-refresh",
    });
  });

  test("explicit add-account does not reuse the legacy slot when opaque credentials share a refresh token", async () => {
    await saveCredential("cursor", cred({ access: "legacy-access", refresh: "shared-refresh" }));
    const legacySlotId = getAccountSet("cursor")!.activeAccountId;

    await saveCredential("cursor", cred({
      access: "new-access",
      refresh: "shared-refresh",
    }), { preserveIdentityless: true });

    const set = getAccountSet("cursor")!;
    expect(set.accounts).toHaveLength(2);
    expect(new Set(set.accounts.map(account => account.id)).size).toBe(2);
    expect(set.activeAccountId).not.toBe(legacySlotId);
    expect(getAccountCredential("cursor", legacySlotId)?.access).toBe("legacy-access");
    expect(getCredential("cursor")?.access).toBe("new-access");
  });

  test("explicit add-account keeps slot ids distinct across refresh and verified-identity seed collisions", async () => {
    await saveCredential("cursor", cred({ access: "legacy-access", refresh: "shared-seed" }));
    const legacySlotId = getAccountSet("cursor")!.activeAccountId;

    await saveCredential("cursor", cred({
      access: "identified-access",
      refresh: "identified-refresh",
      accountId: "shared-seed",
    }), { preserveIdentityless: true });

    const set = getAccountSet("cursor")!;
    expect(set.accounts).toHaveLength(2);
    expect(new Set(set.accounts.map(account => account.id)).size).toBe(2);
    expect(set.activeAccountId).not.toBe(legacySlotId);
    expect(getAccountCredential("cursor", legacySlotId)?.access).toBe("legacy-access");
    expect(getCredential("cursor")).toMatchObject({
      access: "identified-access",
      accountId: "shared-seed",
    });
  });

  test("cursor with distinct accountIds appends a second account", async () => {
    await saveCredential("cursor", cred({ accountId: "google-oauth2|user_a", access: "access-a" }));
    await saveCredential("cursor", cred({ accountId: "google-oauth2|user_b", access: "access-b" }));
    expect(listAccounts("cursor").length).toBe(2);
    expect(getCredential("cursor")?.access).toBe("access-b");
  });

  test("cursor with a third distinct accountId appends without dropping prior accounts", async () => {
    await saveCredential("cursor", cred({ accountId: "google-oauth2|user_a", access: "access-a" }));
    await saveCredential("cursor", cred({ accountId: "auth0|user_b", access: "access-b" }));
    await saveCredential("cursor", cred({ accountId: "google-oauth2|user_c", access: "access-c" }));
    expect(listAccounts("cursor").map(a => a.credential.accountId)).toEqual([
      "google-oauth2|user_a",
      "auth0|user_b",
      "google-oauth2|user_c",
    ]);
    expect(getCredential("cursor")?.access).toBe("access-c");
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

  test("queued generation-checked reauth mutation rechecks liveness after reconciliation", async () => {
    await saveCredential("xai", cred({ email: "race@example.com", accountId: "race-account" }));
    const accountId = getAccountSet("xai")!.activeAccountId;
    const generation = credentialGeneration(getAccountCredential("xai", accountId)!);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const blocker = mutateStore(async () => {
      entered();
      await gate;
    });
    await enteredGate;

    const pending = markAccountNeedsReauthIfGeneration("xai", accountId, generation, 0);
    reconcileOAuthReauthState({
      generation: 1,
      providerNames: new Set(),
      comboIds: new Set(),
      comboTargets: new Set(),
      codexAccountIds: new Set(),
      oauthAccountKeys: new Set(),
      configRoots: new Set(),
    });
    release();
    await blocker;

    expect(await pending).toBe(false);
    expect(getAccountSet("xai")!.accounts[0]?.needsReauth).toBeUndefined();
  });

  // Filling the 128-slot admission queue then draining it exceeds the default
  // 5s case budget on a loaded Windows isolate runner; an early timeout also
  // leaves the gate closed and hangs the file realm until the job ceiling.
  test("OAuth mutation 129 rejects before enqueue while every accepted mutation executes once", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let executions = 0;
    const accepted = [mutateStore(async () => {
      executions++;
      firstStarted();
      await firstGate;
    }, ["provider", "account"] )];
    try {
      await started;
      for (let i = 1; i < 128; i++) {
        accepted.push(mutateStore(() => { executions++; }, ["provider", `account-${i}`]));
      }
      expect(oauthMutationTailSnapshot().active).toBe(128);
      await expect(mutateStore(() => { executions++; }, ["rejected"])).rejects.toBeInstanceOf(OAuthMutationBusyError);
      expect(oauthMutationTailSnapshot().active).toBe(128);
      releaseFirst();
      await Promise.all(accepted);
      expect(executions).toBe(128);
      expect(oauthMutationTailSnapshot().active).toBe(0);
    } finally {
      releaseFirst();
      await Promise.allSettled(accepted);
    }
  }, { timeout: STORE_BUDGET_MS }); // 128 serialized load-modify-persist store mutations; windows-latest measured ~7.3s against Bun's 5s default.

  test("OAuth 30 second wait timeout releases an unstarted lease and never enters the chain", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const blocker = mutateStore(async () => {
      firstStarted();
      await firstGate;
    }, ["provider", "running-account"]);
    let timedOut: Promise<unknown> | undefined;
    try {
      await started;
      let entered = false;
      timedOut = mutateStore(() => { entered = true; }, ["provider", "waiting-account"], { waitMs: 10 });
      // Belt-and-suspenders with the ref'd wait timer in store.ts: if reject still
      // never fires under isolate load, fail the case instead of hanging the job.
      // Use a clearable setTimeout (not Bun.sleep) so a settled race cannot keep
      // the isolate alive for the remainder of INTERNAL_DEADLINE_MS.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          timedOut.then(
            () => {
              throw new Error("expected OAuthMutationBusyError from waitMs timeout");
            },
            (error: unknown) => {
              expect(error).toBeInstanceOf(OAuthMutationBusyError);
            },
          ),
          new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(() => {
              reject(new Error(`OAuth mutation waitMs reject did not fire within ${INTERNAL_DEADLINE_MS}ms`));
            }, INTERNAL_DEADLINE_MS);
          }),
        ]);
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }
      expect(entered).toBe(false);
      expect(oauthMutationTailSnapshot().active).toBe(1);
      releaseFirst();
      await blocker;
      expect(oauthMutationTailSnapshot().active).toBe(0);
    } finally {
      releaseFirst();
      await Promise.allSettled([blocker, ...(timedOut ? [timedOut] : [])]);
    }
  }, { timeout: STORE_BUDGET_MS });
});
