import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLoginStatus, OAUTH_PROVIDERS, refreshAnthropicAccountWithLock } from "../../src/oauth";
import { loginAnthropic, refreshAnthropicToken, AnthropicOAuthFlow } from "../../src/oauth/anthropic";
import { bindAnthropicIdentity, mergeAnthropicIdentity, resolveAnthropicAccountIdentity } from "../../src/oauth/anthropic-identity";
import { newerClaudeCredential } from "../../src/oauth/anthropic-continuity";
import { refreshAntigravityToken } from "../../src/oauth/google-antigravity";
import { mergeOAuthPlan } from "../../src/oauth/plan";
import { getAccountCredential, getAccountSet, saveCredential } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";

const originalFetch = globalThis.fetch;
const originalEnv = { HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oauth-account-plans-"));
  process.env.HOME = home;
  process.env.OPENCODEX_HOME = join(home, "ocx");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "{}");
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  // Store writes start async config-dir hardening (icacls on Windows); drain it under the
  // config dir before removing the tree, and restore the environment last.
  await drainAndRemoveFixtureRoots({
    roots: [{ path: join(home, "ocx"), remove: () => {} }, { path: home }],
    restoreEnvironment: () => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    },
  });
});
function credential(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return { access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000,
    accountId: "synthetic-account", source: "oauth", ...overrides };
}
function anthropicFetch(organization: unknown, fail = false) {
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/v1/oauth/token")) return Response.json({
      access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600,
      account: { uuid: "synthetic-account" },
    });
    if (fail) throw new Error("synthetic transport failure");
    return Response.json({ account: { uuid: "synthetic-account" }, organization });
  }) as typeof fetch;
}
function googleFetch(tiers: Record<string, unknown>, fail = false, onboard = false) {
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/token")) return Response.json({ access_token: "synthetic-access", expires_in: 3600 });
    if (String(url).endsWith(":onboardUser")) return Response.json({ done: true,
      response: { projectId: "synthetic-project" } });
    if (fail) throw new Error("synthetic transport failure");
    return Response.json({ ...(onboard ? {} : { projectId: "synthetic-project" }), ...tiers });
  }) as typeof fetch;
}

for (const [organization, plan] of [
  [{ rate_limit_tier: "default_claude_max_20x", organization_type: "claude_pro" }, "max_20x"],
  [{ rate_limit_tier: " default_claude_max_5x " }, "max_5x"],
  [{ organization_type: "claude_pro" }, "pro"],
  [{ rate_limit_tier: "invalid tier", organization_type: "claude_pro" }, "pro"],
] as const) {
  test(`Anthropic profile extracts and stores ${plan}`, async () => {
    anthropicFetch(organization);
    const identity = await resolveAnthropicAccountIdentity("synthetic-access");
    expect(identity?.plan).toBe(plan);
    const fresh = await refreshAnthropicToken("synthetic-refresh");
    expect(fresh.anthropicIdentity).toEqual(bindAnthropicIdentity(fresh.access, "synthetic-account"));
    await saveCredential("anthropic", fresh);
    expect(getAccountCredential("anthropic", getAccountSet("anthropic")!.activeAccountId)?.plan).toBe(plan);
    expect(getLoginStatus("anthropic").accounts![0]!.plan).toBe(plan);
  });
}
const invalid = [undefined, null, 123, {}, "", " ", "MAX_20X", "max 20x", "pro/extra", "x".repeat(65)];
for (const [index, value] of invalid.entries()) {
  test(`invalid or absent tier ${index} projects null for both providers`, async () => {
    anthropicFetch({ rate_limit_tier: value });
    await saveCredential("anthropic", await refreshAnthropicToken("synthetic-refresh"));
    expect(getLoginStatus("anthropic").accounts![0]!.plan).toBeNull();
    googleFetch({ paidTier: { id: value } });
    await saveCredential("google-antigravity", await refreshAntigravityToken("synthetic-refresh"));
    expect(getLoginStatus("google-antigravity").accounts![0]!.plan).toBeNull();
  });
}
test("Anthropic Pool 2 projects its own profile plan", async () => {
  anthropicFetch({ rate_limit_tier: "default_claude_max_20x" });
  await saveCredential("anthropic2", await refreshAnthropicToken("synthetic-refresh"));
  expect(getLoginStatus("anthropic2").accounts![0]!.plan).toBe("max_20x");
});
test("Anthropic browser and local imports keep profile plan", async () => {
  anthropicFetch({ rate_limit_tier: "default_claude_max_5x" });
  const flow = new AnthropicOAuthFlow({});
  await flow.generateAuthUrl("synthetic-state", "http://localhost/callback");
  expect((await flow.exchangeToken("synthetic-code", "synthetic-state", "http://localhost/callback")).plan).toBe("max_5x");
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3_600_000,
  } }));
  expect((await loginAnthropic({}, { importLocal: "only" })).plan).toBe("max_5x");
});
test("matching local import preserves previous plan when profile is unavailable", async () => {
  const stored = credential({ source: "local-cli", plan: "max_20x" });
  await saveCredential("anthropic", stored);
  await saveCredential("anthropic", { ...stored, plan: undefined });
  expect(getLoginStatus("anthropic").accounts![0]!.plan).toBe("max_20x");
});
test("profile-proven local rotation updates the plan", async () => {
  const stored = credential({ source: "local-cli", access: "synthetic-old", refresh: "synthetic-old-refresh",
    expires: 1, plan: "max_20x", anthropicIdentity: bindAnthropicIdentity("synthetic-old", "synthetic-account") });
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3_600_000,
  } }));
  anthropicFetch({ rate_limit_tier: "default_claude_max_5x" });
  const observation = await newerClaudeCredential(stored, Date.now());
  expect(observation.kind).toBe("adopt");
  if (observation.kind === "adopt") expect(observation.credential.plan).toBe("max_5x");
});
test("refresh updates observed tier and clears an observed unknown", async () => {
  await saveCredential("anthropic", credential({ expires: 1, plan: "max_20x" }));
  const id = getAccountSet("anthropic")!.activeAccountId;
  const def = OAUTH_PROVIDERS.anthropic!;
  for (const [organization, expected] of [[{ organization_type: "claude_pro" }, "pro"], [{}, null]] as const) {
    anthropicFetch(organization);
    const stored = getAccountCredential("anthropic", id)!;
    await refreshAnthropicAccountWithLock("anthropic", id, def, stored);
    expect(getLoginStatus("anthropic").accounts![0]!.plan).toBe(expected);
  }
});
test("plan merging preserves unobserved metadata but never inherits across identities", () => {
  const previous = credential({ plan: "max_20x" });
  expect(mergeOAuthPlan(credential(), previous)).toBe("max_20x");
  expect(mergeOAuthPlan(credential({ plan: null }), previous)).toBeNull();
  expect(mergeOAuthPlan(credential({ accountId: "synthetic-other" }), previous)).toBeUndefined();
  const before = { ...previous, anthropicIdentity: bindAnthropicIdentity(previous.access, "synthetic-account") };
  const after = credential({ access: "synthetic-new", anthropicIdentity: bindAnthropicIdentity("synthetic-new", "synthetic-other") });
  expect(mergeOAuthPlan(after, before)).toBeUndefined();
  expect(() => mergeAnthropicIdentity(after, before)).toThrow("Anthropic credential identity changed");
  // Identifiers compare kind for kind: an email-only reauth of an account stored with an id and
  // the same email is the same account, while a different email is not.
  const stored = credential({ accountId: "synthetic-google-id", email: "user@example.test", plan: "g1-pro-tier" });
  expect(mergeOAuthPlan(credential({ accountId: undefined, email: "USER@example.test" }), stored)).toBe("g1-pro-tier");
  expect(mergeOAuthPlan(credential({ accountId: undefined, email: "other@example.test" }), stored)).toBeUndefined();
});
test("a same-account login whose tier read failed keeps the stored plan", async () => {
  await saveCredential("anthropic", credential({ plan: "max_20x" }));
  await saveCredential("anthropic", credential({ access: "synthetic-access-2" }));
  expect(getLoginStatus("anthropic").accounts!).toHaveLength(1);
  expect(getLoginStatus("anthropic").accounts![0]!.plan).toBe("max_20x");
  await saveCredential("anthropic", credential({ access: "synthetic-access-3", plan: null }));
  expect(getLoginStatus("anthropic").accounts![0]!.plan).toBeNull();
});
test("an explicit account replacement cannot inherit previous plan", async () => {
  await saveCredential("anthropic", credential({ plan: "max_20x" }));
  await saveCredential("anthropic", credential({ accountId: "synthetic-other" }));
  expect(getLoginStatus("anthropic").accounts!.find(row => row.active)!.plan).toBeNull();
});
test("Antigravity prefers paidTier, falls back to currentTier, and keeps plan through onboarding", async () => {
  for (const [tiers, expected, onboard] of [
    [{ paidTier: { id: "g1-pro-tier" }, currentTier: { id: "free-tier" } }, "g1-pro-tier", false],
    [{ paidTier: { id: "g1-ultra-lite-tier" }, currentTier: { id: "free-tier" } }, "g1-ultra-lite-tier", false],
    [{ currentTier: { id: "free-tier" } }, "free-tier", false],
    [{ paidTier: { id: "g1-pro-tier" } }, "g1-pro-tier", true],
  ] as const) {
    googleFetch(tiers, false, onboard);
    const fresh = await refreshAntigravityToken("synthetic-refresh");
    expect(fresh.projectId).toBe("synthetic-project");
    await saveCredential("google-antigravity", fresh);
    expect(getLoginStatus("google-antigravity").accounts![0]!.plan).toBe(expected);
  }
});
test("an unanswered loadCodeAssist leaves the stored Antigravity plan in place", async () => {
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/token")) return Response.json({ access_token: "synthetic-access", expires_in: 3600 });
    if (String(url).endsWith(":onboardUser")) return Response.json({ done: true,
      response: { projectId: "synthetic-project" } });
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  const fresh = await refreshAntigravityToken("synthetic-refresh");
  expect(fresh.projectId).toBe("synthetic-project");
  expect(fresh.plan).toBeUndefined();
  expect(mergeOAuthPlan(fresh, credential({ accountId: undefined, plan: "g1-pro-tier" }))).toBe("g1-pro-tier");
});
test("an onboarding failure keeps the tier loadCodeAssist already reported", async () => {
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/token")) return Response.json({ access_token: "synthetic-access", expires_in: 3600 });
    if (String(url).endsWith(":onboardUser")) throw new Error("synthetic onboarding failure");
    return Response.json({ paidTier: { id: "g1-ultra-lite-tier" } });
  }) as typeof fetch;
  const fresh = await refreshAntigravityToken("synthetic-refresh");
  expect(fresh.plan).toBe("g1-ultra-lite-tier");
  expect(fresh.projectId).toBeUndefined();
});
test("failed profile and project reads keep an unknown plan null", async () => {
  anthropicFetch({}, true);
  await saveCredential("anthropic", await refreshAnthropicToken("synthetic-refresh"));
  expect(getLoginStatus("anthropic").accounts![0]!.plan).toBeNull();
  googleFetch({}, true);
  await saveCredential("google-antigravity", await refreshAntigravityToken("synthetic-refresh"));
  expect(getLoginStatus("google-antigravity").accounts![0]!.plan).toBeNull();
});
test("status validates stored plans for every provider without exposing private proof", async () => {
  for (const value of ["pro", "INVALID", "x".repeat(65), null, undefined]) {
    await saveCredential("kimi", credential({ plan: value }));
    const row = getLoginStatus("kimi").accounts![0]!;
    expect(row.plan).toBe(value === "pro" ? "pro" : null);
    expect("anthropicIdentity" in row).toBe(false);
    expect("access" in row).toBe(false);
  }
});
