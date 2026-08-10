import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_HEALTH_UNAVAILABLE_NOTE,
  CODEX_REAUTH_ACTION,
  collectOAuthHealthEntries,
  collectOAuthHealthEntriesForCli,
  projectOAuthAccountHealth,
} from "../src/oauth/health";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../src/oauth/store";
import {
  clearAccountNeedsReauth,
  markAccountNeedsReauth as markCodexAccountNeedsReauth,
} from "../src/codex/account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import {
  clearCodexUpstreamHealth,
  getCodexAccountHealthSnapshot,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import type { OcxConfig } from "../src/types";
import { formatOAuthHealthForStatus } from "../src/cli/status-oauth";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
} from "../src/lib/local-management-attestation";

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
  rmSync(tmp, { recursive: true, force: true });
});

describe("projectOAuthAccountHealth", () => {
  test("reauth beats cooldown", () => {
    expect(projectOAuthAccountHealth({
      needsReauth: true,
      reauthReason: "refresh_failed",
      cooldownUntilMs: Date.now() + 60_000,
    })).toEqual({ status: "reauth_required", reason: "refresh_failed" });
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

describe("collectOAuthHealthEntries", () => {
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
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19191, attestationSecret }),
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/healthz")) {
          const challenge = new Headers(init?.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER)!;
          const proof = createLocalAttestationProof(attestationSecret, challenge, 4242, 19191)!;
          return new Response("ok", { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: proof } });
        }
        authorization = new Headers(init?.headers).get("authorization");
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
    expect(authorization).toBe("Bearer ocx-admin-health-test");
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

  test("an invalid listener proof cannot unlock the bearer-bearing request", async () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "ocx-admin-health-test";
    const attestationSecret = "A".repeat(43);
    let apiCalls = 0;
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19191, attestationSecret }),
      fetchImpl: async (input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        if (!String(input).endsWith("/healthz")) apiCalls += 1;
        return new Response("fake", { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: "B".repeat(43) } });
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
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: null }),
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    expect(report.codexHealthSource).toBe("management-auth-failed");
    const text = formatOAuthHealthForStatus(report);
    expect(text).toContain("proxy running");
    expect(text).toContain("management authentication failed");
    expect(text).not.toContain("proxy not running");
  });

  test("distinguishes an invalid management response from a stopped proxy", async () => {
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: null }),
      fetchImpl: async () => new Response("upstream error", { status: 500 }),
    });
    expect(report.codexHealthSource).toBe("management-api-unavailable");
    const text = formatOAuthHealthForStatus(report);
    expect(text).toContain("proxy running");
    expect(text).toContain("management API did not return account health");
  });

  test("malformed remote health is re-derived instead of rendering undefined", async () => {
    const report = await collectOAuthHealthEntriesForCli(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: null }),
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
