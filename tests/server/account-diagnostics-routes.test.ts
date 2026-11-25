import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, getValidAccessTokenForAccount } from "../../src/oauth";
import { clearGenericFailoverHealth, rotateGenericOAuthAccountOn429 } from "../../src/oauth/generic-account-failover";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../../src/oauth/store";
import {
  classifyOAuthRefreshFailure,
  clearOAuthRefreshOutcomes,
  lastOAuthRefreshOutcome,
  observeOAuthRefresh,
  recordOAuthRefreshOutcome,
} from "../../src/oauth/refresh-outcomes";
import { clearModelCache, setCached } from "../../src/codex/model-cache";
import {
  ACCOUNT_DIAGNOSTICS_PATH,
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
    const url = new URL(`http://127.0.0.1${ACCOUNT_DIAGNOSTICS_PATH}${query}`);
    return handleAccountDiagnosticsRoutes({ req: new Request(url, { method }), url, config: cfg });
  };
  const ok = call("?provider=xai")!;
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect((await ok.json() as { accounts: unknown[] }).accounts).toHaveLength(1);
  expect(call("?provider=not-a-provider")!.status).toBe(400);
  expect(call("?provider=xai", "POST")).toBeNull();
});
