import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { getAccountSet, saveAccountCredential, saveCredentialWithReceipt } from "../../src/oauth/store";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FAR = 9999999999999;
let testDir = "";
let previousHome: string | undefined;
let isolated: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;
let usageCalls: string[] = [];

type Row = { id: string; access: string; expires?: number; paused?: boolean; reason?: string; email: string; accountId: string };
function writeAuth(rows: Row[], extra: Record<string, unknown> = {}): void {
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({
    anthropic: {
      activeAccountId: "bbbb2222",
      accounts: rows.map(row => ({
        id: row.id,
        credential: { access: row.access, refresh: `r-${row.id}`, expires: row.expires ?? FAR, email: row.email, accountId: row.accountId, source: "oauth" },
        ...(row.paused ? { paused: true, pauseRevision: `rev-${row.id}` } : {}),
        ...(row.reason ? { pauseDetails: { reason: row.reason, pausedAt: 1 } } : {}),
      })),
    },
    ...extra,
  }), { mode: 0o600 });
}
const automatic: Row = { id: "aaaa1111", access: "t1", paused: true, reason: "subscription_expired", email: "first@example.com", accountId: "acct-1" };
const active: Row = { id: "bbbb2222", access: "t2", email: "second@example.com", accountId: "acct-2" };

function stubUsage(status: number): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === USAGE_URL) {
      usageCalls.push(new Headers(init?.headers).get("authorization") ?? "");
      return status === 200
        ? Response.json({ five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00Z" }, seven_day: { utilization: 30, resets_at: "2099-01-02T00:00:00Z" } })
        : new Response("{}", { status });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolated = installIsolatedCodexHome("ocx-resume-health-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-resume-health-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "anthropic",
    providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } } } as OcxConfig);
  usageCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolated?.restore();
  isolated = null;
  if (testDir) removeTreeWithRetry(testDir);
});

async function resume(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/api/oauth/accounts/pause", server.url), {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  } finally { await server.stop(true); }
}
const row = (id: string) => getAccountSet("anthropic")?.accounts.find(account => account.id === id);

describe("resume --if-healthy (#8398)", () => {
  test("a healthy usage read with the stored credential resumes an automatically paused account", async () => {
    writeAuth([automatic, active]);
    stubUsage(200);
    const result = await resume({ provider: "anthropic", accountId: "aaaa1111", paused: false, ifHealthy: true });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, paused: false });
    expect(usageCalls).toEqual(["Bearer t1"]);
    expect(row("aaaa1111")?.paused).toBeUndefined();
    expect(row("aaaa1111")?.pauseDetails).toBeUndefined();
  });

  test("a refused usage read keeps the pause and names the reason", async () => {
    writeAuth([automatic, active]);
    stubUsage(403);
    const result = await resume({ provider: "anthropic", accountId: "aaaa1111", paused: false, ifHealthy: true });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: "resume_refused", reason: "usage_read_failed" });
    expect(row("aaaa1111")?.paused).toBe(true);
    expect(row("aaaa1111")?.pauseDetails?.reason).toBe("subscription_expired");
  });

  test.each(["oauth_organization_disabled", "account_permission_denied"])("a permanent reason %s is never health-resumed and sends nothing", async reason => {
    writeAuth([{ ...automatic, reason }, active]);
    stubUsage(200);
    const result = await resume({ provider: "anthropic", accountId: "aaaa1111", paused: false, ifHealthy: true });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: "resume_refused", reason: "pause_not_remote_clearable" });
    expect(usageCalls).toEqual([]);
    expect(row("aaaa1111")?.paused).toBe(true);
  });

  test("an expired stored credential is reported without refreshing a paused account", async () => {
    writeAuth([{ ...automatic, expires: 1 }, active]);
    stubUsage(200);
    const result = await resume({ provider: "anthropic", accountId: "aaaa1111", paused: false, ifHealthy: true });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: "resume_refused", reason: "credential_expired" });
    expect(usageCalls).toEqual([]);
    expect(row("aaaa1111")?.paused).toBe(true);
  });

  test("an operator pause is resumed when healthy, and an unpaused account is left as is", async () => {
    writeAuth([{ ...automatic, reason: undefined }, active]);
    stubUsage(200);
    expect((await resume({ provider: "anthropic", accountId: "aaaa1111", paused: false, ifHealthy: true })).status).toBe(200);
    expect(row("aaaa1111")?.paused).toBeUndefined();
    expect(usageCalls).toEqual(["Bearer t1"]);
    usageCalls = [];
    expect((await resume({ provider: "anthropic", accountId: "bbbb2222", paused: false, ifHealthy: true })).status).toBe(200);
    expect(usageCalls).toEqual([]);
  });

  test("ifHealthy is only for a resume, and a provider without a health check refuses it", async () => {
    writeAuth([automatic, active], { "google-antigravity": { activeAccountId: "ga111111", accounts: [
      { id: "ga111111", paused: true, pauseDetails: { reason: "subscription_inactive", pausedAt: 1 },
        credential: { access: "g1", refresh: "gr1", expires: FAR, email: "g@example.test", accountId: "ga-1", projectId: "p1" } },
    ] } });
    stubUsage(200);
    expect((await resume({ provider: "anthropic", accountId: "aaaa1111", paused: true, ifHealthy: true })).status).toBe(400);
    expect((await resume({ provider: "anthropic", accountId: "aaaa1111", paused: false, ifHealthy: "yes" })).status).toBe(400);
    const generic = await resume({ provider: "google-antigravity", accountId: "ga111111", paused: false, ifHealthy: true });
    expect(generic.status).toBe(409);
    expect(generic.json).toMatchObject({ code: "resume_refused", reason: "health_check_unsupported" });
  });
});

describe("explicit login clears only an automatic pause (#8398)", () => {
  test("a login for the same identity clears an automatic pause", async () => {
    writeAuth([automatic, active]);
    await saveCredentialWithReceipt("anthropic", { access: "t1-new", refresh: "r1-new", expires: FAR, email: "first@example.com", accountId: "acct-1", source: "oauth" } as never);
    expect(row("aaaa1111")?.paused).toBeUndefined();
    expect(row("aaaa1111")?.pauseDetails).toBeUndefined();
    expect(getAccountSet("anthropic")?.activeAccountId).toBe("aaaa1111");
  });

  test("a login keeps an operator pause", async () => {
    writeAuth([{ ...automatic, reason: undefined }, active]);
    await saveCredentialWithReceipt("anthropic", { access: "t1-new", refresh: "r1-new", expires: FAR, email: "first@example.com", accountId: "acct-1", source: "oauth" } as never);
    expect(row("aaaa1111")?.paused).toBe(true);
    expect(getAccountSet("anthropic")?.activeAccountId).toBe("bbbb2222");
  });

  test("a reauthentication of one slot clears an automatic pause and keeps an operator pause", async () => {
    writeAuth([automatic, active, { id: "cccc3333", access: "t3", paused: true, email: "third@example.com", accountId: "acct-3" }]);
    await saveAccountCredential("anthropic", "aaaa1111", { access: "t1-new", refresh: "r1-new", expires: FAR, email: "other@example.com", accountId: "acct-9", source: "oauth" } as never, { clearAutomaticPause: true });
    await saveAccountCredential("anthropic", "cccc3333", { access: "t3-new", refresh: "r3-new", expires: FAR, email: "third@example.com", accountId: "acct-3", source: "oauth" } as never, { clearAutomaticPause: true });
    expect(row("aaaa1111")?.paused).toBeUndefined();
    expect(row("aaaa1111")?.pauseDetails).toBeUndefined();
    expect(row("cccc3333")?.paused).toBe(true);
  });
});

describe("routing learns about a login that cleared a pause (#8398)", () => {
  test("a cleared automatic pause is published; a kept operator pause is not", async () => {
    const { subscribeOAuthAccountPauseChanges } = await import("../../src/lib/account-selection-events");
    const seen: string[] = [];
    const unsubscribe = subscribeOAuthAccountPauseChanges(provider => { seen.push(provider); });
    try {
      writeAuth([automatic, active]);
      await saveCredentialWithReceipt("anthropic", { access: "t1-new", refresh: "r1-new", expires: FAR, email: "first@example.com", accountId: "acct-1", source: "oauth" } as never);
      expect(seen).toEqual(["anthropic"]);
      writeAuth([{ ...automatic, reason: undefined }, active]);
      await saveAccountCredential("anthropic", "aaaa1111", { access: "t1-other", refresh: "r1-other", expires: FAR, email: "first@example.com", accountId: "acct-1", source: "oauth" } as never);
      expect(seen).toEqual(["anthropic"]);
    } finally { unsubscribe(); }
  });
});

describe("only an explicit reauthentication clears an automatic pause (#8398 review)", () => {
  test("a credential write without the reauthentication flag (Kiro pre-login binding) keeps the pause", async () => {
    writeAuth([automatic, active]);
    await saveAccountCredential("anthropic", "aaaa1111", { access: "t1-bound", refresh: "r1-bound", expires: FAR, email: "first@example.com", accountId: "acct-1", source: "oauth" } as never);
    expect(row("aaaa1111")?.paused).toBe(true);
    expect(row("aaaa1111")?.pauseDetails?.reason).toBe("subscription_expired");
  });

  test("an account that is not paused when checked is answered without a write", async () => {
    writeAuth([automatic, active]);
    stubUsage(200);
    const before = row("bbbb2222")?.pauseRevision;
    const result = await resume({ provider: "anthropic", accountId: "bbbb2222", paused: false, ifHealthy: true });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, unchanged: true, paused: false });
    expect(row("bbbb2222")?.pauseRevision).toBe(before);
    expect(usageCalls).toEqual([]);
  });
});

describe("races and selection handoff (#8398 review)", () => {
  test("a credential replaced during the usage read refuses with account_changed", async () => {
    writeAuth([automatic, active]);
    const { checkOAuthResumeHealth } = await import("../../src/oauth/account-resume-health");
    const verdict = await checkOAuthResumeHealth("anthropic", "aaaa1111", { readUsage: async () => {
      await saveAccountCredential("anthropic", "aaaa1111", { access: "t1-swap", refresh: "r1-swap", expires: FAR, email: "first@example.com", accountId: "acct-1", source: "oauth" } as never);
      return { quota: { fiveHourPercent: 1 } };
    } });
    expect(verdict).toEqual({ ok: false, reason: "account_changed" });
    expect(row("aaaa1111")?.paused).toBe(true);
  });

  test("a stale resume guard changes nothing", async () => {
    writeAuth([automatic, active]);
    const { setAccountPaused } = await import("../../src/oauth/store");
    const result = await setAccountPaused("anthropic", "aaaa1111", false, undefined, { generation: "stale", pauseRevision: "rev-aaaa1111" });
    expect(result).toEqual({ status: "changed" });
    expect(row("aaaa1111")?.paused).toBe(true);
    expect(row("aaaa1111")?.pauseDetails?.reason).toBe("subscription_expired");
  });

  test("a local-cli import that clears an automatic pause takes a selection parked on a paused row", async () => {
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({ anthropic: { activeAccountId: "bbbb2222", accounts: [
      { id: "aaaa1111", paused: true, pauseRevision: "rev-a", pauseDetails: { reason: "subscription_expired", pausedAt: 1 },
        credential: { access: "t1", refresh: "shared-refresh", expires: FAR, source: "local-cli" } },
      { id: "bbbb2222", paused: true, credential: { access: "t2", refresh: "r2", expires: FAR, email: "second@example.com", accountId: "acct-2", source: "oauth" } },
    ] } }), { mode: 0o600 });
    await saveCredentialWithReceipt("anthropic", { access: "t1-new", refresh: "shared-refresh", expires: FAR, source: "local-cli" } as never);
    expect(row("aaaa1111")?.paused).toBeUndefined();
    expect(getAccountSet("anthropic")?.activeAccountId).toBe("aaaa1111");
  });
});
