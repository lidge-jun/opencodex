import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_HEALTH_UNAVAILABLE_NOTE,
  CODEX_REAUTH_ACTION,
  collectOAuthHealthEntries,
  collectOAuthHealthEntriesForCli,
  oauthHealthLabel,
  oauthHealthSummary,
  projectOAuthAccountHealth,
  projectCodexAccountHealth,
  projectMainAccountPolicyHealth,
} from "../../src/oauth/health";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  credentialGeneration,
  getAccountSet,
  markAccountNeedsReauth,
  markAccountNeedsReauthIfGeneration,
  mergeAccountCredential,
  saveCredential,
} from "../../src/oauth/store";
import {
  clearAccountNeedsReauth,
  markAccountNeedsReauth as markCodexAccountNeedsReauth,
} from "../../src/codex/account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import {
  clearCodexUpstreamHealth,
  getCodexAccountHealthSnapshot,
  recordCodexUpstreamOutcome,
} from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";
import { formatOAuthHealthForStatus } from "../../src/cli/status-oauth";
import {
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
  LOCAL_MANAGEMENT_READ_PATHS,
  verifyLocalManagementReadCapability,
} from "../../src/lib/local-management-capability";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-health-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  clearCodexUpstreamHealth();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = origOcxHome;
  if (origAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = origAdminToken;
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  removeTreeWithRetry(tmp);
});

describe("projectOAuthAccountHealth", () => {
  test("pending Codex pool validation warns while reauthentication and native main keep their own health", () => {
    saveCodexAccountCredential("pending-health", {
      accessToken: "pending-access", refreshToken: "pending-refresh", expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "pending-health",
    }, { validationPending: true });
    expect(projectCodexAccountHealth({ accountId: "pending-health", needsReauth: false }))
      .toEqual({ status: "warning", reason: "validation_pending" });
    expect(projectCodexAccountHealth({ accountId: "pending-health", needsReauth: true }))
      .toEqual({ status: "reauth_required", reason: "refresh_failed" });
    expect(projectCodexAccountHealth({ accountId: MAIN_CODEX_ACCOUNT_ID, needsReauth: false }))
      .toEqual({ status: "healthy" });
  });
  test("reauth beats cooldown", () => {
    expect(projectOAuthAccountHealth({
      needsReauth: true,
      reauthReason: "refresh_failed",
      cooldownUntilMs: Date.now() + 60_000,
    })).toEqual({ status: "reauth_required", reason: "refresh_failed" });
  });

  test("a verify_account cause projects distinctly from a dead credential", () => {
    const health = projectOAuthAccountHealth({ needsReauth: true, reauthReason: "verify_account" });
    expect(health).toEqual({ status: "reauth_required", reason: "verify_account" });
    expect(oauthHealthLabel(health)).toBe("Verification required");
    expect(oauthHealthSummary("google-antigravity", "abc", health))
      .toContain("reauthentication required (verify account)");
  });

  test("active cooldown projects until ISO timestamp", () => {
    const until = Date.parse("2026-07-23T14:30:00.000Z");
    expect(projectOAuthAccountHealth({
      cooldownUntilMs: until,
      cooldownReason: "rate_limit",
      now: until - 1000,
    })).toEqual({
      status: "cooldown",
      until: "2026-07-23T14:30:00.000Z",
      reason: "rate_limit",
    });
  });

  test("cooldown beats warning, warning beats healthy", () => {
    const until = Date.now() + 60_000;
    expect(projectOAuthAccountHealth({
      cooldownUntilMs: until,
      cooldownReason: "quota",
      warningReason: "refresh_conflict",
      now: until - 1,
    })).toEqual({
      status: "cooldown",
      until: new Date(until).toISOString(),
      reason: "quota",
    });
    expect(projectOAuthAccountHealth({
      warningReason: "metadata_mismatch",
    })).toEqual({ status: "warning", reason: "metadata_mismatch" });
    expect(projectOAuthAccountHealth({})).toEqual({ status: "healthy" });
  });

  test("expired cooldown is healthy", () => {
    const until = Date.parse("2026-07-23T14:30:00.000Z");
    expect(projectOAuthAccountHealth({
      cooldownUntilMs: until,
      cooldownReason: "rate_limit",
      now: until,
    })).toEqual({ status: "healthy" });
  });
});

describe("projectCodexAccountHealth", () => {
  /**
   * The suite's beforeEach only creates the home root. Every other case in this file reads the
   * Codex store, and a read of a missing file is a clean empty store; these cases WRITE it, and
   * the credential mutation lock opens a SQLite file inside the config dir.
   */
  function withPoolStoreDir(): void {
    mkdirSync(join(tmp, "ocx"), { recursive: true });
  }

  test("a terminal validation verdict is projected as reauth_required", async () => {
    withPoolStoreDir();
    const { markCodexAccountValidationFailed, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../../src/codex/account-store");
    saveCodexAccountCredential("pool-revoked", {
      accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "cg",
    });

    // Before the verdict is recorded this is exactly the reported bug: a credential upstream has
    // revoked still projects healthy (#4120).
    expect(projectCodexAccountHealth({ accountId: "pool-revoked", needsReauth: false }))
      .toEqual({ status: "healthy" });

    markCodexAccountValidationFailed("pool-revoked", "refresh_revoked", {
      expectedGeneration: readCodexAccountRecord("pool-revoked")!.generation,
      terminal: true,
    });

    expect(projectCodexAccountHealth({ accountId: "pool-revoked", needsReauth: false }))
      .toEqual({ status: "reauth_required", reason: "refresh_failed" });
  });

  test("a non-terminal validation failure does not claim the credential is dead", async () => {
    withPoolStoreDir();
    const { markCodexAccountValidationFailed, saveCodexAccountCredential } =
      await import("../../src/codex/account-store");
    saveCodexAccountCredential("pool-warmup", {
      accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "cg",
    });
    markCodexAccountValidationFailed("pool-warmup", "http_status:500");

    expect(projectCodexAccountHealth({ accountId: "pool-warmup", needsReauth: false }))
      .toEqual({ status: "healthy" });
  });

  test.each([
    ["http_status:401", "unauthorized"],
    ["http_status:403", "forbidden"],
  ] as const)("a stored verification failure surfaces %s as %s", async (validationError, reason) => {
    withPoolStoreDir();
    const { markCodexAccountValidationFailed, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../../src/codex/account-store");
    const accountId = "pool-stored-" + reason;
    saveCodexAccountCredential(accountId, {
      accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "cg",
    }, { validationPending: true });
    markCodexAccountValidationFailed(accountId, validationError, {
      expectedGeneration: readCodexAccountRecord(accountId)!.generation,
    });

    expect(projectCodexAccountHealth({ accountId, needsReauth: false }))
      .toEqual({ status: "reauth_required", reason });
  });

  test("the CLI collector reports the terminal verdict too", async () => {
    withPoolStoreDir();
    const { markCodexAccountValidationFailed, readCodexAccountRecord, saveCodexAccountCredential } =
      await import("../../src/codex/account-store");
    saveCodexAccountCredential("pool-cli", {
      accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "cg",
    });
    markCodexAccountValidationFailed("pool-cli", "refresh_expired", {
      expectedGeneration: readCodexAccountRecord("pool-cli")!.generation,
      terminal: true,
    });

    // collectLocalCodexEntries used to inline its own copy of the projector, which is how
    // `ocx status`/`ocx doctor` would have kept calling this account healthy.
    const entry = collectOAuthHealthEntries().find(e => e.provider === "codex" && e.accountId === "pool-cli");
    expect(entry?.health).toEqual({ status: "reauth_required", reason: "refresh_failed" });
    expect(entry?.action).toBe(CODEX_REAUTH_ACTION);
  });
});

describe("collectOAuthHealthEntries", () => {
  test("local Codex diagnostics expose pending validation with its recovery action", () => {
    saveCodexAccountCredential("pending-local", {
      accessToken: "pending-access", refreshToken: "pending-refresh", expiresAt: Date.now() + 3600_000,
      chatgptAccountId: "pending-local",
    }, { validationPending: true });
    expect(collectOAuthHealthEntries().find(entry => entry.provider === "codex" && entry.accountId === "pending-local"))
      .toEqual({
        provider: "codex", accountId: "pending-local",
        health: { status: "warning", reason: "validation_pending" },
        action: "wait for quota recovery, then click Refresh quotas in the dashboard Codex account pool to finish validation",
      });
  });
  test("projects needsReauth account with reauth action", async () => {
    await saveCredential("kimi", {
      access: "kimi-access",
      refresh: "kimi-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct-1",
    });
    const accountId = getAccountSet("kimi")!.activeAccountId;
    await markAccountNeedsReauth("kimi", accountId, true);

    const entries = collectOAuthHealthEntries();
    const entry = entries.find(e => e.provider === "kimi" && e.accountId === accountId);
    expect(entry).toEqual({
      provider: "kimi",
      accountId,
      health: { status: "reauth_required", reason: "refresh_failed" },
      action: "run `ocx login kimi`",
    });
  });

  test("a verify_account mark survives the store round-trip with its own action", async () => {
    await saveCredential("kimi", {
      access: "kimi-access",
      refresh: "kimi-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct-verify",
    });
    const accountId = getAccountSet("kimi")!.activeAccountId;
    await markAccountNeedsReauth("kimi", accountId, true, "verify_account");
    expect(getAccountSet("kimi")!.accounts.find(a => a.id === accountId))
      .toMatchObject({ needsReauth: true, needsReauthReason: "verify_account" });

    const entry = collectOAuthHealthEntries()
      .find(e => e.provider === "kimi" && e.accountId === accountId);
    expect(entry).toEqual({
      provider: "kimi",
      accountId,
      health: { status: "reauth_required", reason: "verify_account" },
      action: "verify the account with the provider in a browser, then run `ocx login kimi`",
    });
  });

  test("a stale generation never marks: late 403 cannot quarantine a fresh login", async () => {
    await saveCredential("kimi", {
      access: "kimi-access",
      refresh: "kimi-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct-stale",
    });
    const accountId = getAccountSet("kimi")!.activeAccountId;
    const staleGeneration = credentialGeneration(getAccountSet("kimi")!.accounts
      .find(a => a.id === accountId)!.credential);
    // The credential rotates (refresh or re-login) before the late 403 arrives.
    await mergeAccountCredential("kimi", accountId, {
      access: "kimi-access-2",
      refresh: "kimi-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct-stale",
    });
    expect(await markAccountNeedsReauthIfGeneration("kimi", accountId, staleGeneration, undefined, "verify_account"))
      .toBe(false);
    const row = getAccountSet("kimi")!.accounts.find(a => a.id === accountId)!;
    expect(row.needsReauth).toBeUndefined();
    expect(row.needsReauthReason).toBeUndefined();
  });

  test("a silent refresh preserves a verify_account quarantine", async () => {
    await saveCredential("kimi", {
      access: "kimi-access",
      refresh: "kimi-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct-keep",
    });
    const accountId = getAccountSet("kimi")!.activeAccountId;
    const generation = credentialGeneration(getAccountSet("kimi")!.accounts
      .find(a => a.id === accountId)!.credential);
    expect(await markAccountNeedsReauthIfGeneration("kimi", accountId, generation, undefined, "verify_account"))
      .toBe(true);
    await mergeAccountCredential("kimi", accountId, {
      access: "kimi-access-2",
      refresh: "kimi-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct-keep",
    });
    expect(getAccountSet("kimi")!.accounts.find(a => a.id === accountId))
      .toMatchObject({ needsReauth: true, needsReauthReason: "verify_account" });
  });

  test("Codex reauth action points at the dashboard pool, not ocx login codex", () => {
    markCodexAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    const entries = collectOAuthHealthEntries();
    const entry = entries.find(e => e.provider === "codex" && e.accountId === MAIN_CODEX_ACCOUNT_ID);
    expect(entry).toEqual({
      provider: "codex",
      accountId: MAIN_CODEX_ACCOUNT_ID,
      health: { status: "reauth_required", reason: "refresh_failed" },
      action: CODEX_REAUTH_ACTION,
    });
    expect(entry!.action).not.toContain("ocx login codex");
  });

  test("kiro manual access-only unexpired credentials are healthy", async () => {
    await saveCredential("kiro", {
      access: "kiro-access-only",
      refresh: "",
      expires: Date.now() + 3_600_000,
      source: "manual",
    });
    const accountId = getAccountSet("kiro")!.activeAccountId;
    const entries = collectOAuthHealthEntries();
    const entry = entries.find(e => e.provider === "kiro" && e.accountId === accountId);
    expect(entry?.health).toEqual({ status: "healthy" });
  });

  test("kiro environment access-only unexpired credentials are healthy", async () => {
    await saveCredential("kiro", {
      access: "kiro-env-access",
      refresh: "",
      expires: Date.now() + 3_600_000,
      source: "environment",
    });
    const accountId = getAccountSet("kiro")!.activeAccountId;
    const entry = collectOAuthHealthEntries().find(e => e.provider === "kiro" && e.accountId === accountId);
    expect(entry?.health).toEqual({ status: "healthy" });
  });

  test("kiro access-only expired credentials are stale_credentials", async () => {
    await saveCredential("kiro", {
      access: "kiro-expired",
      refresh: "",
      expires: Date.now() - 1_000,
      source: "manual",
    });
    const accountId = getAccountSet("kiro")!.activeAccountId;
    const entry = collectOAuthHealthEntries().find(e => e.provider === "kiro" && e.accountId === accountId);
    expect(entry?.health).toEqual({ status: "warning", reason: "stale_credentials" });
  });
});

describe("collectOAuthHealthEntriesForCli", () => {
  test("uses management API Codex health and does not read CLI process maps", async () => {
    markCodexAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx-admin-health-test";
    const attestationSecret = "A".repeat(43);
    let authorization: string | null = null;
    let apiKey: string | null = null;
    let fetchCalls = 0;
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19191, attestationSecret }),
      fetchImpl: async (_input, init) => {
        fetchCalls += 1;
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization");
        apiKey = headers.get("x-opencodex-api-key");
        expect(headers.get(LOCAL_MANAGEMENT_EXPECTED_PID_HEADER)).toBe("4242");
        expect(verifyLocalManagementReadCapability(
          attestationSecret,
          headers.get(LOCAL_MANAGEMENT_NONCE_HEADER),
          "GET",
          LOCAL_MANAGEMENT_READ_PATHS.codexAccounts,
          4242,
          19191,
          Number(headers.get(LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER)),
          headers.get(LOCAL_MANAGEMENT_CAPABILITY_HEADER),
        )).toBe(true);
        return new Response(JSON.stringify({
          accounts: [{
            id: "proxy-codex-acct",
            health: {
              status: "cooldown",
              until: "2026-07-23T14:30:00.000Z",
              reason: "rate_limit",
            },
          }],
        }), { status: 200 });
      },
    });
    expect(fetchCalls).toBe(1);
    expect(authorization).toBeNull();
    expect(apiKey).toBeNull();
    expect(report.codexHealthSource).toBe("management-api");
    expect(report.entries.some(e => e.accountId === MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    const remote = report.entries.find(e => e.accountId === "proxy-codex-acct");
    expect(remote?.health).toEqual({
      status: "cooldown",
      until: "2026-07-23T14:30:00.000Z",
      reason: "rate_limit",
    });
    expect(remote?.action).toContain("wait until");
  });

  test("never sends the admin token to a configured-port listener without runtime attestation", async () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx-admin-health-test";
    let fetchCalls = 0;
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "config" }),
      readRuntimePortImpl: () => null,
      fetchImpl: async (_input, init) => {
        fetchCalls += 1;
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return new Response("fake");
      },
    });
    expect(fetchCalls).toBe(0);
    expect(report.codexHealthSource).toBe("management-api-unavailable");
  });

  test("a stale runtime record cannot launch a local capability request", async () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx-admin-health-test";
    const attestationSecret = "A".repeat(43);
    let apiCalls = 0;
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19192, attestationSecret }),
      fetchImpl: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        apiCalls += 1;
        return new Response("fake");
      },
    });
    expect(apiCalls).toBe(0);
    expect(report.codexHealthSource).toBe("management-api-unavailable");
  });

  test("labels unavailable fallback and omits process-local Codex maps", async () => {
    markCodexAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => null,
    });
    expect(report.codexHealthSource).toBe("unavailable");
    expect(report.entries.some(e => e.provider === "codex")).toBe(false);
    const text = formatOAuthHealthForStatus(report);
    expect(text).toContain(CODEX_HEALTH_UNAVAILABLE_NOTE);
    expect(text).not.toContain(MAIN_CODEX_ACCOUNT_ID);
  });

  test("distinguishes management authentication failure from a stopped proxy", async () => {
    const attestationSecret = "A".repeat(43);
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19191, attestationSecret }),
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    expect(report.codexHealthSource).toBe("management-auth-failed");
    const text = formatOAuthHealthForStatus(report);
    expect(text).toContain("proxy running");
    expect(text).toContain("management authentication failed");
    expect(text).not.toContain("proxy not running");
  });

  test("distinguishes an invalid management response from a stopped proxy", async () => {
    const attestationSecret = "A".repeat(43);
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19191, attestationSecret }),
      fetchImpl: async () => new Response("upstream error", { status: 500 }),
    });
    expect(report.codexHealthSource).toBe("management-api-unavailable");
    const text = formatOAuthHealthForStatus(report);
    expect(text).toContain("proxy running");
    expect(text).toContain("management API did not return account health");
  });

  test("malformed remote health is re-derived instead of rendering undefined", async () => {
    const attestationSecret = "A".repeat(43);
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19191, attestationSecret }),
      fetchImpl: async () =>
        new Response(JSON.stringify({
          accounts: [{
            id: "skewed-acct",
            needsReauth: true,
            health: { status: "not-a-real-status" },
          }],
        }), { status: 200 }),
    });
    const entry = report.entries.find(e => e.accountId === "skewed-acct");
    expect(entry?.health).toEqual({ status: "reauth_required", reason: "refresh_failed" });
    const text = formatOAuthHealthForStatus(report);
    expect(text).not.toContain("undefined");
  });
});

describe("getCodexAccountHealthSnapshot", () => {
  test("exposes active cooldown source without changing write policy", () => {
    const config = { providers: {} } as OcxConfig;
    const now = Date.parse("2026-07-23T14:00:00.000Z");
    recordCodexUpstreamOutcome(config, "pool-acct", 429, { retryAfter: "120", now });

    expect(getCodexAccountHealthSnapshot("pool-acct", now)).toEqual({
      cooldownUntil: now + 120_000,
      cooldownSource: "retry-after",
    });
    expect(getCodexAccountHealthSnapshot("missing", now)).toBeNull();
  });
});

describe("projectMainAccountPolicyHealth", () => {
  const valid = { enabled: true, state: "ready", thresholds: { short: 90, long: 98 } };

  test("projects a valid policy and copies only whitelisted fields", () => {
    expect(projectMainAccountPolicyHealth({ ...valid, window: "short", resetAt: 1_000, accountId: "leak" }))
      .toEqual({ enabled: true, state: "ready", thresholds: { short: 90, long: 98 }, window: "short", resetAt: 1_000 });
  });

  test("rejects a state that does not match enabled", () => {
    expect(projectMainAccountPolicyHealth({ ...valid, enabled: false })).toBeUndefined();
    expect(projectMainAccountPolicyHealth({ ...valid, state: "off" })).toBeUndefined();
    expect(projectMainAccountPolicyHealth({ enabled: false, state: "off", thresholds: valid.thresholds }))
      .toEqual({ enabled: false, state: "off", thresholds: { short: 90, long: 98 } });
  });

  test("rejects thresholds that are out of range, unordered, fractional or missing", () => {
    for (const thresholds of [
      { short: 79, long: 98 },
      { short: 99, long: 98 },
      { short: 90.5, long: 98 },
      { short: 90, long: 101 },
      { short: "90", long: 98 },
      undefined,
    ]) {
      expect(projectMainAccountPolicyHealth({ ...valid, thresholds })).toBeUndefined();
    }
    expect(projectMainAccountPolicyHealth(null)).toBeUndefined();
    expect(projectMainAccountPolicyHealth([valid])).toBeUndefined();
  });

  test("drops a malformed external-usage warning but keeps the policy", () => {
    for (const externalUsage of [
      { window: "monthly", fromPercent: 10, toPercent: 20, observedAt: 1 },
      { window: "short", fromPercent: -1, toPercent: 20, observedAt: 1 },
      { window: "short", fromPercent: 10, toPercent: 120, observedAt: 1 },
      { window: "short", fromPercent: 10, toPercent: 20, observedAt: Number.NaN },
    ]) {
      const projected = projectMainAccountPolicyHealth({ ...valid, externalUsage });
      expect(projected).toEqual({ enabled: true, state: "ready", thresholds: { short: 90, long: 98 } });
    }
    expect(projectMainAccountPolicyHealth({
      ...valid,
      externalUsage: { window: "long", fromPercent: 10, toPercent: 20, observedAt: 5, extra: "x" },
    })?.externalUsage).toEqual({ window: "long", fromPercent: 10, toPercent: 20, observedAt: 5 });
  });
});
