import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodexAuthContextToProvider,
  assertCodexAuthContextNotCooled,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  cooldownErrorMessage,
  cooldownErrorResponse,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  shouldMarkAccountNeedsReauthForCodexAuthFailure,
  stripCodexRuntimeProviderFields,
} from "../src/codex/auth-context";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  getCodexAccountCredential,
  removeCodexAccountCredential,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../src/codex/auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-auth-ctx-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  // Isolate the main-account credential source: testDir has no auth.json, so the main
  // account is deterministically absent (these cases test pool-only fail-closed behavior).
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    activeCodexAccountId: "pool-a",
    providers: {
      routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" },
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/backend-api/codex", authMode: "forward" },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
    ],
  };
}

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/backend-api/codex",
  authMode: "forward",
};

describe("Codex auth context", () => {
  test("direct mode returns caller-owned main context without touching pool selection", async () => {
    const cfg = { ...config(), activeCodexAccountId: "missing-pool-account" };
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer caller" }), cfg, "direct"))
      .resolves.toEqual({ kind: "main", accountId: null });
  });
  test("direct mode fails locally without a caller bearer", async () => {
    await expect(resolveCodexAuthContext(new Headers(), config(), "direct"))
      .rejects.toBeInstanceOf(CodexDirectAuthenticationError);
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer   " }), config(), "direct"))
      .rejects.toBeInstanceOf(CodexDirectAuthenticationError);
  });
  test("selects pool auth independently of the routed provider", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });

    const ctx = await resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool");

    expect(ctx).toMatchObject({
      kind: "pool",
      accountId: "pool-a",
      generation: 1,
      accessToken: "pool_token",
      chatgptAccountId: "pool_acc",
    });
  });

  test("exclusion selects another eligible account without changing the active account", async () => {
    const cfg = config();
    cfg.codexAccounts?.push({
      id: "pool-b",
      email: "pool-b@example.test",
      isMain: false,
      chatgptAccountId: "pool_b_acc",
    });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_b_token",
      refreshToken: "pool_b_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_b_acc",
    });

    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      excludeAccountId: "pool-a",
    })).resolves.toMatchObject({
      kind: "pool",
      accountId: "pool-b",
      accessToken: "pool_b_token",
      chatgptAccountId: "pool_b_acc",
    });
    expect(cfg.activeCodexAccountId).toBe("pool-a");
  });

  test("exclusion fails closed when no alternate account is eligible", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });

    await expect(resolveCodexAuthContext(
      new Headers({ authorization: "Bearer caller_token" }),
      config(),
      "pool",
      { excludeAccountId: "pool-a" },
    )).rejects.toBeInstanceOf(CodexPoolAuthenticationError);
  });

  test("pause excludes new auth selection without invalidating an in-flight context", async () => {
    const cfg = config();
    cfg.codexAccounts?.push({
      id: "pool-b",
      email: "pool-b@example.test",
      isMain: false,
      chatgptAccountId: "pool_b_acc",
    });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_b_token",
      refreshToken: "pool_b_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_b_acc",
    });

    const captured = await resolveCodexAuthContext(new Headers(), cfg, "pool");
    expect(captured).toMatchObject({ kind: "pool", accountId: "pool-a" });

    cfg.pausedCodexAccountIds = ["pool-a"];

    expect(isCodexAuthContextUsable(captured, cfg)).toBe(true);
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
      .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
  });

  test("selected pool headers replace inbound main auth", () => {
    const headers = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main_token", "chatgpt-account-id": "main_acc", "openai-beta": "responses=experimental" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    );

    expect(headers.get("authorization")).toBe("Bearer pool_token");
    expect(headers.get("chatgpt-account-id")).toBe("pool_acc");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
  });

  test("pool token failure marks reauth and throws before fallback", async () => {
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
      .rejects.toBeInstanceOf(CodexAuthContextError);
    expect(isAccountNeedsReauth("pool-a")).toBe(true);
  });

  test("pool token failure error message does not expose local account id", async () => {
    try {
      await resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool");
      throw new Error("expected auth context failure");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAuthContextError);
      expect((err as Error).message).not.toContain("pool-a");
    }
  });

  test("cooled single pool account fails closed instead of falling back to inbound main auth", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config(), "pool-a", 429, { retryAfter: "60", now });

    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
  });

  test("reset-derived cooldown admits one probe and clears on its success (#433)", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    // Keep the credential valid against the frozen clock, not the wall clock —
    // otherwise the probe path tries a real token refresh.
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 24 * 60 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    const headers = new Headers({ authorization: "Bearer main_token" });
    try {
      // Upstream announces a reset four days out; the account actually recovers early.
      const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
      Date.now = () => now;
      recordCodexUpstreamOutcome(config(), "pool-a", 429, { resetAt, now });

      // Before the probe interval the account is still short-circuited locally.
      Date.now = () => now + 1_000;
      await expect(resolveCodexAuthContext(headers, config(), "pool"))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);

      // After the interval exactly one request is admitted, carrying the lease.
      const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
      Date.now = () => probeAt;
      const probeCtx = await resolveCodexAuthContext(headers, config(), "pool");
      expect(probeCtx).toMatchObject({ kind: "pool", accountId: "pool-a" });
      const probeLeaseId = (probeCtx as { probeLeaseId?: string }).probeLeaseId;
      expect(probeLeaseId).toBeTruthy();
      // The admitted request must not be blocked again downstream.
      expect(() => assertCodexAuthContextNotCooled(probeCtx)).not.toThrow();

      // A second concurrent request still gets the cooldown.
      await expect(resolveCodexAuthContext(headers, config(), "pool"))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);

      // The probe succeeds: the account is proven healthy and routes normally again.
      recordCodexUpstreamOutcome(config(), "pool-a", 200, { now: probeAt + 500, probeLeaseId });
      Date.now = () => probeAt + 500;
      await expect(resolveCodexAuthContext(headers, config(), "pool")).resolves.toMatchObject({
        kind: "pool",
        accountId: "pool-a",
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("reset-derived native cooldowns stay within their confirmed quota group", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const cfg = config();
    const headers = new Headers({ authorization: "Bearer main_token" });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 24 * 60 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    try {
      Date.now = () => now;
      const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt,
        modelId: "gpt-5.3-codex-spark",
      });

      // Spark owns a separate quota, so Terra can use the same account.
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.6-terra" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);

      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt,
        modelId: "gpt-5.6-terra",
      });

      // Terra and Luna stay in the shared native quota group, while Spark keeps
      // its independent cooldown instead of being overwritten by Terra's 429.
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.6-luna" }))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);

      // An explicit retry directive is still account-wide, regardless of the
      // originating model's otherwise independent quota group.
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        retryAfter: "60",
        modelId: "gpt-5.3-codex-spark",
      });
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.6-terra" }))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a scoped cooldown uses another account without moving the independent native scope", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const cfg = config();
    cfg.codexAccounts?.push({
      id: "pool-b",
      email: "pool-b@example.test",
      isMain: false,
      chatgptAccountId: "pool_b_acc",
    });
    const headers = new Headers({
      authorization: "Bearer main_token",
      "x-codex-parent-thread-id": "independent-scope-thread",
    });
    for (const accountId of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(accountId, {
        accessToken: `${accountId}-token`,
        refreshToken: `${accountId}-refresh`,
        expiresAt: now + 24 * 60 * 60_000,
        chatgptAccountId: `${accountId}-acc`,
      });
    }
    try {
      Date.now = () => now;
      // Establish the shared-scope binding first. The Spark fallback below must
      // create a second binding rather than replacing this one.
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.6-terra" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });

      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt: Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000),
        modelId: "gpt-5.3-codex-spark",
      });

      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
      expect(cfg.activeCodexAccountId).toBe("pool-a");
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.6-terra" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
      // This second Spark request proves routing retained the peer choice for
      // the Spark affinity instead of relying on an auth-layer substitution.
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
    } finally {
      Date.now = originalNow;
    }
  });

  test("a successful Spark recovery probe leaves the shared native cooldown intact", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const cfg = config();
    const headers = new Headers({ authorization: "Bearer main_token" });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 24 * 60 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    try {
      Date.now = () => now;
      const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000);
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt,
        modelId: "gpt-5.3-codex-spark",
      });
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt,
        modelId: "gpt-5.6-terra",
      });

      const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
      Date.now = () => probeAt;
      const sparkProbe = await resolveCodexAuthContext(headers, cfg, "pool", {
        modelId: "gpt-5.3-codex-spark",
      });
      expect(sparkProbe).toMatchObject({
        kind: "pool",
        probeQuotaScope: "spark",
      });

      recordCodexUpstreamOutcome(cfg, "pool-a", 200, {
        now: probeAt + 1,
        modelId: "gpt-5.3-codex-spark",
        probeLeaseId: (sparkProbe as { probeLeaseId?: string }).probeLeaseId,
        probeQuotaScope: (sparkProbe as { probeQuotaScope?: "spark" }).probeQuotaScope,
      });

      Date.now = () => probeAt + 1;
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.6-luna" }))
        .resolves.toMatchObject({ kind: "pool", probeQuotaScope: "shared" });
    } finally {
      Date.now = originalNow;
    }
  });

  test("expired thread affinity fails closed instead of falling back to main auth", async () => {
    const now = 1_800_000_000_000;
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    const originalNow = Date.now;
    const headers = new Headers({
      authorization: "Bearer main_token",
      "x-codex-parent-thread-id": "expired-auth-context",
    });
    try {
      Date.now = () => now;
      await expect(resolveCodexAuthContext(headers, config(), "pool")).resolves.toMatchObject({
        kind: "pool",
        accountId: "pool-a",
      });

      Date.now = () => now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1;
      await expect(resolveCodexAuthContext(headers, config(), "pool"))
        .rejects.toBeInstanceOf(CodexThreadAffinityExpiredError);
    } finally {
      Date.now = originalNow;
    }
  });

  test("cached pool auth context is rejected while cooled and accepted after expiry", () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };
    try {
      recordCodexUpstreamOutcome(config(), "pool-a", 429, { retryAfter: "60", now });
      Date.now = () => now + 1_000;
      expect(() => assertCodexAuthContextNotCooled(ctx)).toThrow(CodexAccountCooldownError);

      Date.now = () => now + 61_000;
      expect(() => assertCodexAuthContextNotCooled(ctx)).not.toThrow();
      expect(() => assertCodexAuthContextNotCooled({ kind: "main", accountId: null })).not.toThrow();
    } finally {
      Date.now = originalNow;
    }
  });

  test("generation conflict does not mark account as reauth-needed", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "old_token",
      refreshToken: "old_refresh",
      expiresAt: 0,
      chatgptAccountId: "pool_acc",
    });
    const replacement = {
      accessToken: "replacement_token",
      refreshToken: "replacement_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      saveCodexAccountCredential("pool-a", replacement);
      return new Response(JSON.stringify({ access_token: "stale_token", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
        .rejects.toBeInstanceOf(CodexAuthContextError);
      expect(isAccountNeedsReauth("pool-a")).toBe(false);
      expect(getCodexAccountCredential("pool-a")).toEqual(replacement);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reauth marking is reserved for real token failures", () => {
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new CodexCredentialGenerationConflictError())).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new CodexCredentialRefreshLockTimeoutError())).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new Error("bad token"))).toBe(true);
  });

  test("runtime provider metadata is applied only to forward provider copies", () => {
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };
    const runtimeForward = applyCodexAuthContextToProvider(forwardProvider, ctx, "pool");
    expect(runtimeForward).toMatchObject({
      _codexAccountRequired: true,
      _codexAccountOverride: { accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    });
    expect(forwardProvider).not.toHaveProperty("_codexAccountOverride");

    const routed = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" };
    expect(applyCodexAuthContextToProvider(routed, ctx, "pool")).toBe(routed);
  });

  test("runtime provider metadata is stripped before persistence", () => {
    const runtimeProvider = {
      ...forwardProvider,
      _codexAccountRequired: true,
      _codexAccountOverride: { accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    };

    const stripped = stripCodexRuntimeProviderFields(runtimeProvider);

    expect(stripped).not.toHaveProperty("_codexAccountRequired");
    expect(stripped).not.toHaveProperty("_codexAccountOverride");
    expect(stripped).toMatchObject(forwardProvider);
  });

  test("auth context usability follows account lifecycle state", () => {
    const cfg = config();
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };

    expect(isCodexAuthContextUsable({ kind: "main", accountId: null }, cfg)).toBe(true);
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(false);

    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(true);

    saveCodexAccountCredential("pool-a", {
      accessToken: "replacement_token",
      refreshToken: "replacement_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(false);

    const replacementCtx = { ...ctx, generation: 2, accessToken: "replacement_token" };
    expect(isCodexAuthContextUsable(replacementCtx, cfg)).toBe(true);

    removeCodexAccountCredential("pool-a");
    expect(isCodexAuthContextUsable(replacementCtx, cfg)).toBe(false);

    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    cfg.codexAccounts = cfg.codexAccounts?.filter(account => account.id !== "pool-a");
    expect(isCodexAuthContextUsable({ ...ctx, generation: 4 }, cfg)).toBe(false);
  });
});

// A cooled-down account is the ONLY thing standing between the user and a working
// Codex Desktop, because injected routing has no second path. The refusal therefore has
// to say who is cooled, until when, and how to escape — without leaking the raw id to a
// possibly remote data-plane client.
describe("cooldown error surface", () => {
  test("message names the account, deadline, source, and escape command", () => {
    const until = Date.parse("2026-07-26T10:00:00.000Z");
    const err = new CodexAccountCooldownError("acct_9f3c21", until, "reset-derived");

    const message = cooldownErrorMessage(err);

    expect(message).toContain("2026-07-26T10:00:00.000Z");
    expect(message).toContain("reset-derived");
    expect(message).toContain("ocx account clear-cooldown openai <id>");
    // Masked, never raw: /v1/* bodies can reach remote authenticated clients when the
    // proxy binds a non-loopback hostname.
    expect(message).not.toContain("acct_9f3c21");
    expect(message).toContain("account-…3c21");
  });

  test("message identifies a model-scoped cooldown without implying an account-wide block", () => {
    const err = new CodexAccountCooldownError(
      "acct_9f3c21",
      Date.parse("2026-07-26T10:00:00.000Z"),
      "reset-derived",
      "spark",
    );

    const message = cooldownErrorMessage(err);

    expect(message).toContain("Spark quota is cooling down");
    expect(message).not.toContain("Selected Codex account (account-…3c21) is cooling down");
  });

  test("the main login renders as the alias users actually type", () => {
    const err = new CodexAccountCooldownError(MAIN_CODEX_ACCOUNT_ID, Date.now() + 60_000);

    const message = cooldownErrorMessage(err);

    expect(message).toContain("(main)");
    expect(message).not.toContain("__main__");
    // No recorded source falls back to the default label rather than printing undefined.
    expect(message).toContain("source: default");
  });

  test("HTTP form carries a Retry-After the client can act on", async () => {
    const now = 1_800_000_000_000;
    const err = new CodexAccountCooldownError("pool-a", now + 90_000, "retry-after");

    const response = cooldownErrorResponse(err, now);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("90");
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain("ocx account clear-cooldown");
  });

  test("an already-elapsed cooldown still yields a valid Retry-After", () => {
    const now = 1_800_000_000_000;
    const err = new CodexAccountCooldownError("pool-a", now - 5_000, "default");

    expect(cooldownErrorResponse(err, now).headers.get("Retry-After")).toBe("1");
  });
});
