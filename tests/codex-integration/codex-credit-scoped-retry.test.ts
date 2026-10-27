import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import {
  CodexPoolAccountCreditsOffError, cooldownErrorResponse, resolveCodexAuthContext,
  materializeCodexUpstreamAuth, materializeCodexUpstreamAuthAsync,
  createCodexAuthDispatchGuard, applyCodexAuthContextToProvider, assertCodexAuthContextNotCooled,
} from "../../src/codex/auth-context";
import { createOpenAiSidecarCreditGuard } from "../../src/providers/openai-sidecar-credit";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import {
  clearCodexUpstreamHealth, clearThreadAccountMap, getCodexQuotaHealthSnapshot, recordCodexUpstreamOutcome,
} from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ID = "scoped-credit-fixture";
const NOW = 1_800_000_000_000;
const RESET = NOW + 6 * 86_400_000;
const MODEL = "gpt-5.5";
let home: string;
let previousHome: string | undefined, previousCodexHome: string | undefined;
let clock: ReturnType<typeof spyOn>;
let originalFetch: typeof fetch;
let networkCalls: number;
let expectedNetworkCalls: number;
const cfg = (): OcxConfig => ({
  port: 10100, defaultProvider: "openai", providers: {}, codexMainAccountHardLock: false,
  codexAccounts: [{ id: ID, email: "fixture@example.test", plan: "plus", isMain: false }],
  codexAccountNamespaces: { subAlias: ID }, creditCodexAccountIds: [ID],
  activeCodexAccountId: ID, autoSwitchThreshold: 0, upstreamFailoverThreshold: 3,
});
function observe(age: number) {
  setAccountQuotaFromParsed(ID, { weeklyPercent: 100, weeklyResetAt: RESET,
    credits: { hasCredits: true, balance: 5, allowed: true, observedAt: NOW - age } });
}
const resolve = (config: OcxConfig) => resolveCodexAuthContext(new Headers(), config, "direct", { accountId: ID, modelId: MODEL });
function state() {
  return structuredClone({ quota: getAccountQuota(ID),
    account: getCodexQuotaHealthSnapshot(ID, undefined),
    shared: getCodexQuotaHealthSnapshot(ID, "shared"),
    reserve: getCodexQuotaHealthSnapshot(ID, "reserve") });
}
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME; previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-credit-scoped-retry-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  clock = spyOn(Date, "now").mockReturnValue(NOW);
  const ok = { success: true, exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  setIcaclsRunnerForTests(() => ok); setAsyncIcaclsRunnerForTests(async () => ok);
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); clearAccountNeedsReauth(ID);
  saveCodexAccountCredential(ID, { accessToken: "fixture-scoped-access", refreshToken: "fixture-scoped-refresh",
    expiresAt: NOW + 3_600_000, chatgptAccountId: "fixture-scoped-workspace" });
  originalFetch = globalThis.fetch; networkCalls = 0; expectedNetworkCalls = 0;
  globalThis.fetch = Object.assign((): never => { networkCalls++; throw new Error("Unexpected network request"); },
    { preconnect: originalFetch.preconnect });
});
afterEach(async () => {
  try {
    expect(networkCalls).toBe(expectedNetworkCalls);
    clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); clearAccountNeedsReauth(ID);
    await flushConfigDirHardeningForTests();
  } finally {
    globalThis.fetch = originalFetch; clock.mockRestore();
    setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  }
});

const cases = [
  { name: "shared reset-derived hold", modelId: MODEL, retry: 900 },
  { name: "independent Reserve hold", modelId: "gpt-reserve", retry: 300 },
  { name: "account-wide Retry-After", modelId: "gpt-reserve", retryAfter: "3600", retry: 3600 },
  { name: "expired shared hold", modelId: MODEL, age: 901_000, retry: 300 },
  { name: "shared hold recorded before a shorter account hold", modelId: MODEL, retryAfter: "600", combined: "before", retry: 900 },
  { name: "shared hold recorded after a shorter account hold", modelId: MODEL, retryAfter: "600", combined: "after", retry: 900 },
  { name: "oversized numeric Retry-After", modelId: MODEL, retryAfter: "99999999999999999999", retry: 86_400 },
  { name: "far-future Retry-After date", modelId: MODEL, retryAfter: "Fri, 31 Dec 9999 23:59:59 GMT", retry: 86_400 },
] as const;
for (const boundary of ["resolve", "materialize", "materialize-async", "dispatch", "provider", "cooldown", "sidecar"] as const) {
  for (const scenario of cases) test(`${boundary} credit refusal respects ${scenario.name}`, async () => {
    const config = cfg();
    observe(0);
    const context = boundary === "resolve" ? undefined : await resolve(config);
    if (context) expect(context).toMatchObject({ kind: "pool", accountId: ID, quotaScope: "shared" });
    observe(360_000);
    const recordedAt = NOW - ("age" in scenario ? scenario.age : 0);
    const recordSharedHold = () => recordCodexUpstreamOutcome(config, ID, 429, {
      modelId: MODEL, resetAt: NOW + 3_600_000, fixedAccount: true, now: NOW,
    });
    if ("combined" in scenario && scenario.combined === "before") recordSharedHold();
    recordCodexUpstreamOutcome(config, ID, 429, { modelId: scenario.modelId,
      resetAt: recordedAt + 3_600_000, fixedAccount: true, now: recordedAt,
      ...("retryAfter" in scenario ? { retryAfter: scenario.retryAfter } : {}) });
    if ("combined" in scenario && scenario.combined === "after") recordSharedHold();
    const before = state();
    let error: unknown;
    try {
      if (boundary === "resolve") await resolve(config);
      else if (boundary === "materialize") materializeCodexUpstreamAuth(new Headers(), context!);
      else if (boundary === "materialize-async") await materializeCodexUpstreamAuthAsync(new Headers(), context!);
      else if (boundary === "dispatch") createCodexAuthDispatchGuard(context!, config, MODEL)!(new Headers());
      else if (boundary === "provider") applyCodexAuthContextToProvider({
        adapter: "openai-responses", baseUrl: "https://example.test", authMode: "forward",
      }, context!, "pool");
      else if (boundary === "cooldown") assertCodexAuthContextNotCooled(context!);
      else createOpenAiSidecarCreditGuard(context!, config)!();
    } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(CodexPoolAccountCreditsOffError);
    const refusal = error as CodexPoolAccountCreditsOffError;
    expect(refusal.accountId).toBe(ID);
    expect(refusal.resetAt).toBe(RESET);
    const response = cooldownErrorResponse(refusal, NOW);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(scenario.retry));
    expect(state()).toEqual(before);
    expect(isAccountNeedsReauth(ID)).toBe(false);
  });
}

test("resolve retains shared scope when credits become stale during token preparation", async () => {
  const config = cfg();
  observe(0);
  saveCodexAccountCredential(ID, { accessToken: "fixture-expired-access", refreshToken: "fixture-scoped-refresh",
    expiresAt: NOW - 1, chatgptAccountId: "fixture-scoped-workspace" });
  expectedNetworkCalls = 1;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    networkCalls++;
    expect(String(input)).toBe("https://auth.openai.com/oauth/token");
    expect(init?.method).toBe("POST");
    observe(360_000);
    recordCodexUpstreamOutcome(config, ID, 429, { modelId: MODEL,
      resetAt: NOW + 3_600_000, fixedAccount: true, now: NOW });
    return Response.json({ access_token: "fixture-refreshed-access", refresh_token: "fixture-refreshed-grant", expires_in: 3600 });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  const error = await resolve(config).catch(cause => cause);
  expect(error).toBeInstanceOf(CodexPoolAccountCreditsOffError);
  expect(error.resetAt).toBe(RESET);
  expect(cooldownErrorResponse(error, NOW).headers.get("retry-after")).toBe("900");
  expect(getCodexQuotaHealthSnapshot(ID, "shared")?.cooldownUntil).toBe(NOW + 900_000);
  expect(isAccountNeedsReauth(ID)).toBe(false);
});
