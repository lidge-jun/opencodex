import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, getValidAccessTokenForAccount } from "../../src/oauth";
import { clearGenericFailoverHealth, rotateGenericOAuthAccountOn429 } from "../../src/oauth/generic-account-failover";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../../src/oauth/store";
import {
  classifyOAuthRefreshFailure,
  clearOAuthRefreshOutcomes,
  lastOAuthRefreshOutcome,
  MAX_OAUTH_REFRESH_OUTCOMES,
  oauthRefreshOutcomeCountForTests,
  observeOAuthRefresh,
  recordOAuthRefreshOutcome,
} from "../../src/oauth/refresh-outcomes";
import { AnthropicTokenError } from "../../src/oauth/anthropic";
import { KiroTokenRefreshError } from "../../src/oauth/kiro";
import { acquireAccountLease } from "../../src/oauth/kiro-account-load";
import { clearAntigravityAccountRosters, recordAntigravityAccountRoster } from "../../src/providers/antigravity-account-roster";
import { join as joinPath } from "node:path";
import { clearModelCache, setCached } from "../../src/codex/model-cache";
import {
  buildAccountDiagnostics,
  handleAccountDiagnosticsRoutes,
} from "../../src/server/management/account-diagnostics-routes";
import type { CatalogModel } from "../../src/codex/catalog/parsing";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const originalKimiRefresh = OAUTH_PROVIDERS.kimi!.refresh;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-account-diagnostics-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
  clearOAuthRefreshOutcomes();
});
afterEach(() => {
  OAUTH_PROVIDERS.kimi!.refresh = originalKimiRefresh;
  clearGenericFailoverHealth();
  clearOAuthRefreshOutcomes();
  clearModelCache("xai");
  clearModelCache("google-antigravity");
  clearAntigravityAccountRosters();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

const oauthProvider = (adapter: string, baseUrl: string, models?: string[]) =>
  ({ adapter, baseUrl, authMode: "oauth", ...(models ? { models } : {}) }) as unknown as OcxProviderConfig;

function config(providers: Record<string, OcxProviderConfig>): OcxConfig {
  return { port: 0, defaultProvider: Object.keys(providers)[0], providers, oauthAccountFailover: { enabled: true } } as unknown as OcxConfig;
}

async function seed(provider: string, count: number): Promise<string[]> {
  for (let i = 0; i < count; i += 1) {
    await saveCredential(provider, {
      access: `secret-access-${i}`, refresh: `secret-refresh-${i}`, expires: Date.now() + 3_600_000,
      accountId: `uuid-${provider}-${i}`, email: `user${i}@example.com`,
    } as never, { addAccount: true });
  }
  return getAccountSet(provider)!.accounts.map(account => account.id);
}

test("a refresh failure is reduced to a fixed reason and status, never its message", async () => {
  const rejected = Object.assign(new Error("invalid_grant for secret-refresh-0"), { status: 401 });
  await expect(observeOAuthRefresh("xai", "acct", () => Promise.reject(rejected))).rejects.toBe(rejected);
  expect(lastOAuthRefreshOutcome("xai", "acct")).toMatchObject({ ok: false, reason: "rejected", status: 401 });
  expect(JSON.stringify(lastOAuthRefreshOutcome("xai", "acct"))).not.toContain("secret");

  await expect(observeOAuthRefresh("xai", "acct", () => Promise.resolve("token"))).resolves.toBe("token");
  expect(lastOAuthRefreshOutcome("xai", "acct")).toMatchObject({ ok: true });
  expect(lastOAuthRefreshOutcome("xai", "acct")?.reason).toBeUndefined();

  expect(classifyOAuthRefreshFailure(Object.assign(new Error("x"), { status: 503 }))).toEqual({ reason: "upstream_error", status: 503 });
  expect(classifyOAuthRefreshFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toEqual({ reason: "network" });
  expect(classifyOAuthRefreshFailure(new DOMException("t", "TimeoutError"))).toEqual({ reason: "timeout" });
  expect(classifyOAuthRefreshFailure(new DOMException("a", "AbortError"))).toEqual({ reason: "aborted" });
  expect(classifyOAuthRefreshFailure("boom")).toEqual({ reason: "error" });
  // A synchronous throw from the refresh call is recorded too.
  await expect(observeOAuthRefresh("xai", "sync", () => { throw new Error("sync"); })).rejects.toThrow("sync");
  expect(lastOAuthRefreshOutcome("xai", "sync")).toMatchObject({ ok: false, reason: "error" });
});

test("a real generic refresh records its outcome for the account", async () => {
  await saveCredential("kimi", { access: "kimi-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "kimi-acct" } as never);
  const accountId = getAccountSet("kimi")!.activeAccountId!;
  OAUTH_PROVIDERS.kimi!.refresh = async () => ({ access: "kimi-fresh", refresh: "rt-new", expires: Date.now() + 3_600_000 });
  await expect(getValidAccessTokenForAccount("kimi", accountId)).resolves.toBe("kimi-fresh");
  expect(lastOAuthRefreshOutcome("kimi", accountId)).toMatchObject({ ok: true });
});

test("rows show cooldown, refresh result, reauth and eligibility without any credential field", async () => {
  const cfg = config({ xai: oauthProvider("openai-chat", "https://api.x.ai/v1", ["grok-a", "grok-b"]) });
  const [cooled, failing, flagged] = await seed("xai", 3);
  const now = Date.now();
  rotateGenericOAuthAccountOn429(cfg, "xai", cooled!, "120", now);
  recordOAuthRefreshOutcome("xai", failing!, { at: now, ok: false, reason: "rejected", status: 400 });
  await markAccountNeedsReauth("xai", flagged!, true);

  const view = buildAccountDiagnostics("xai", cfg, now);
  expect(view.models).toEqual(["grok-a", "grok-b"]);
  const row = (id: string) => view.accounts.find(account => account.id === id)!;
  expect(row(cooled!)).toMatchObject({ eligible: false, eligibleModels: [], cooldownUntil: now + 120_000, inFlight: 0, lastRefresh: null });
  expect(row(failing!)).toMatchObject({ eligible: true, eligibleModels: ["grok-a", "grok-b"], cooldownUntil: null,
    lastRefresh: { at: now, ok: false, reason: "rejected", status: 400 } });
  expect(row(flagged!)).toMatchObject({ eligible: false, needsReauth: true, eligibleModels: [] });

  const body = JSON.stringify(view);
  for (const forbidden of ["secret-access", "secret-refresh", "@example.com", "email", "organization"]) expect(body).not.toContain(forbidden);
});

test("a family-scoped cooldown removes only that family's models", async () => {
  const cfg = config({ "google-antigravity": oauthProvider("google", "https://cloudcode-pa.googleapis.com") });
  setCached("google-antigravity", [{ id: "gemini-3-pro" }, { id: "claude-sonnet-4-6" }] as CatalogModel[]);
  const [first, second] = await seed("google-antigravity", 2);
  const now = Date.now();
  rotateGenericOAuthAccountOn429(cfg, "google-antigravity", first!, "300", now, "gemini-3-pro");
  const view = buildAccountDiagnostics("google-antigravity", cfg, now);
  const row = (id: string) => view.accounts.find(account => account.id === id)!;
  expect(row(first!)).toMatchObject({ eligible: true, eligibleModels: ["claude-sonnet-4-6"], cooldownUntil: null });
  expect(row(second!).eligibleModels).toEqual(["gemini-3-pro", "claude-sonnet-4-6"]);
});

test("an unknown model list is reported as null rather than empty", async () => {
  const cfg = config({ xai: oauthProvider("openai-chat", "https://api.x.ai/v1") });
  await seed("xai", 1);
  expect(buildAccountDiagnostics("xai", cfg).accounts[0]!.eligibleModels).toBeNull();
});

test("the route answers GET for a known OAuth provider and refuses an unknown one", async () => {
  const cfg = config({ xai: oauthProvider("openai-chat", "https://api.x.ai/v1", ["grok-a"]) });
  await seed("xai", 1);
  const call = (query: string, method = "GET") => {
    const url = new URL(`http://127.0.0.1/api/oauth/accounts/diagnostics${query}`);
    return handleAccountDiagnosticsRoutes({ req: new Request(url, { method }), url, config: cfg });
  };
  const ok = call("?provider=xai")!;
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect((await ok.json() as { accounts: unknown[] }).accounts).toHaveLength(1);
  expect(call("?provider=not-a-provider")!.status).toBe(400);
  expect(call("?provider=xai", "POST")).toBeNull();
});

test("provider token errors keep their HTTP status", () => {
  expect(classifyOAuthRefreshFailure(new AnthropicTokenError("denied", 401, "invalid_grant"))).toEqual({ reason: "rejected", status: 401 });
  expect(classifyOAuthRefreshFailure(new AnthropicTokenError("unreachable", undefined, undefined, true))).toEqual({ reason: "error" });
  expect(classifyOAuthRefreshFailure(new KiroTokenRefreshError(503))).toEqual({ reason: "upstream_error", status: 503 });
});

test("refresh results are scoped to the config home, the account's lifetime and a bounded size", async () => {
  const cfg = config({ xai: oauthProvider("openai-chat", "https://api.x.ai/v1", ["grok-a"]) });
  const [id] = await seed("xai", 1);
  const addedAt = getAccountSet("xai")!.accounts[0]!.addedAt ?? 0;
  recordOAuthRefreshOutcome("xai", id!, { at: addedAt - 1, ok: false, reason: "rejected" });
  // A result older than the account (a removed and re-added login) is not this account's.
  expect(buildAccountDiagnostics("xai", cfg).accounts[0]!.lastRefresh).toBeNull();
  recordOAuthRefreshOutcome("xai", id!, { at: addedAt + 1, ok: true });
  expect(buildAccountDiagnostics("xai", cfg).accounts[0]!.lastRefresh).toMatchObject({ ok: true });

  const other = mkdtempSync(joinPath(tmpdir(), "ocx-account-diagnostics-other-"));
  try {
    process.env.OPENCODEX_HOME = other;
    expect(lastOAuthRefreshOutcome("xai", id!)).toBeNull();
  } finally {
    process.env.OPENCODEX_HOME = home;
    removeTreeWithRetry(other);
  }

  for (let i = 0; i < MAX_OAUTH_REFRESH_OUTCOMES + 10; i += 1) recordOAuthRefreshOutcome("xai", `churn-${i}`, { at: i, ok: true });
  expect(oauthRefreshOutcomeCountForTests()).toBe(MAX_OAUTH_REFRESH_OUTCOMES);
  expect(lastOAuthRefreshOutcome("xai", "churn-0")).toBeNull();
});

test("an Antigravity account whose roster omits every known model is not eligible", async () => {
  const cfg = config({ "google-antigravity": oauthProvider("google", "https://cloudcode-pa.googleapis.com") });
  setCached("google-antigravity", [{ id: "gemini-3-pro" }, { id: "claude-sonnet-4-6" }] as CatalogModel[]);
  const [narrow, wide] = await seed("google-antigravity", 2);
  recordAntigravityAccountRoster("google-antigravity", narrow!, [{ id: "gemini-2-flash", wireModelId: "gemini-2-flash" }]);
  const view = buildAccountDiagnostics("google-antigravity", cfg);
  const row = (id: string) => view.accounts.find(account => account.id === id)!;
  expect(row(narrow!)).toMatchObject({ eligible: false, eligibleModels: [] });
  expect(row(wide!)).toMatchObject({ eligible: true, eligibleModels: ["gemini-3-pro", "claude-sonnet-4-6"] });
});

test("a Kiro account at its concurrency cap is reported at capacity and not eligible", async () => {
  const kiro = { ...oauthProvider("kiro", "https://q.us-east-1.amazonaws.com", ["claude-sonnet-4-6"]),
    oauthAccountFailover: { enabled: true, maxConcurrentPerAccount: 1 } } as unknown as OcxProviderConfig;
  const cfg = config({ kiro });
  const [busy, idle] = await seed("kiro", 2);
  const lease = await acquireAccountLease("kiro", busy!, { maxConcurrentPerAccount: 1 });
  try {
    const view = buildAccountDiagnostics("kiro", cfg);
    const row = (id: string) => view.accounts.find(account => account.id === id)!;
    expect(row(busy!)).toMatchObject({ inFlight: 1, atCapacity: true, eligible: false, eligibleModels: [] });
    expect(row(idle!)).toMatchObject({ inFlight: 0, atCapacity: false });
  } finally {
    lease?.release();
  }
});

test.skipIf(process.platform === "win32")("the diagnostics read does not harden or rewrite the credential store", async () => {
  const cfg = config({ xai: oauthProvider("openai-chat", "https://api.x.ai/v1", ["grok-a"]) });
  await seed("xai", 1);
  const authPath = joinPath(home, "auth.json");
  chmodSync(authPath, 0o644);
  const before = statSync(authPath);
  buildAccountDiagnostics("xai", cfg);
  const after = statSync(authPath);
  expect(after.mode & 0o777).toBe(0o644);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});
