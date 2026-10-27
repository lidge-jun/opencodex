import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePoolQuotaWriter, poolQuotaHistoryIdentity, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { codexCreditsFor, rememberCodexCredits, resetCodexCreditsForTests } from "../../src/codex/credits";
import { listCodexAuthAccounts, poolAccountDto } from "../../src/codex/auth-api/account-list";
import { fetchMainAccountInfoSnapshot } from "../../src/codex/auth-api/main-account-probe";
import { commitPoolQuotaResponse } from "../../src/codex/auth-api/pool-quota-probe";
import { clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearAccountQuota } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import type { CodexAccount, OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fakeChatGptJwt } from "../helpers/agent-task-recovery";
import { getMainAccountCredentialStatus, getMainAccountToken, getValidMainAccountToken } from "../../src/codex/main-account";
import { nativeMainRefusals } from "../../src/codex/native-main-refusals";
import { setNativeMainRefreshResolutionForTests, type CodexAuthStatus } from "../../src/codex/native-main-refresh-mode";
import { inspectResetCredits, consumeResetCredits } from "../../src/codex/auth-api/reset-credit-service";
import { clearCodexQuotaPrimeState, primeCodexPoolQuotas } from "../../src/codex/auth-api/pool-mode-gate";
import { getAccountQuota } from "../../src/codex/quota";
import { getMainAccountInfoCache } from "../../src/codex/main-account-cache";

let testDir: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let originalFetch: typeof fetch;
const account: CodexAccount = { id: "credits-pool", email: "credits@example.test", isMain: false };
const config = (): OcxConfig => ({ port: 10100, defaultProvider: "openai", providers: {}, codexAccounts: [] });

function writeMain(bearer = "fixture-main-bearer", identity = "fixture-main-identity") {
  writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({
    tokens: { access_token: bearer, account_id: identity },
  }));
}
function poolContext() {
  const record = readCodexAccountRecord(account.id)!;
  const credential = record.credential!;
  return { accountId: account.id, existing: null, configuredPlan: undefined,
    generation: record.generation, writerGeneration: captureConfigGeneration(),
    poolWriter: capturePoolQuotaWriter(account.id, { ...credential, generation: record.generation }),
  };
}
function savePool(identity = "fixture-pool-identity") {
  saveCodexAccountCredential(account.id, {
    accessToken: "fixture-pool-bearer", refreshToken: "fixture-pool-refresh",
    chatgptAccountId: identity, expiresAt: Date.now() + 3_600_000,
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  originalFetch = globalThis.fetch;
  testDir = mkdtempSync(join(tmpdir(), "ocx-credits-probes-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = join(testDir, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  globalThis.fetch = (async () => { throw new Error("unexpected fixture network request"); }) as typeof fetch;
  clearMainAccountInfoCache();
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  resetCodexCreditsForTests();
  resetQuotaQueryBackoffForTests();
});
afterEach(() => {
  nativeMainRefusals.verifiedLogin(process.env.CODEX_HOME!);
  setNativeMainRefreshResolutionForTests(null);
  clearCodexQuotaPrimeState();
  clearMainAccountInfoCache();
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  resetCodexCreditsForTests();
  resetQuotaQueryBackoffForTests();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(testDir);
});

async function refuseFileless(bearer: string, kind: "known" | "unknown" | "saturated" = "known") {
  setNativeMainRefreshResolutionForTests({ mode: "codex", configured: "auto", reason: "codex-compatible", command: "/fake/codex", version: "0.162.1" });
  const answer = (authToken: string | null) => async (): Promise<CodexAuthStatus> => ({ authMethod: "chatgpt", authToken, requiresOpenaiAuth: true });
  if (kind !== "unknown") await getValidMainAccountToken({ codexAuthStatus: answer(bearer) });
  await expect(getValidMainAccountToken({ codexAuthStatus: answer(null) })).rejects.toMatchObject({ reason: "reauth" });
  if (kind === "saturated") for (let i = 0; i < 5; i++) nativeMainRefusals.refuse(process.env.CODEX_HOME!, `fixture-refused-${i}`);
}

describe("native-main refusal at every metadata dispatch", () => {
  for (const history of ["known", "unknown", "saturated", "plain"] as const) {
    test.each(["probe", "list", "inspect", "consume", "prime"] as const)(`${history} history gates %s`, async path => {
      const bearer = fakeChatGptJwt("fixture-main-identity");
      if (history !== "plain") await refuseFileless(bearer, history);
      writeMain(bearer);
      let requests = 0;
      globalThis.fetch = (async () => {
        requests++;
        return Response.json({ plan_type: "plus", email: "fixture@example.test", code: "no_credit", available_count: 2,
          rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 } } });
      }) as typeof fetch;
      const cfg: OcxConfig = { ...config(), providers: { openai: { name: "OpenAI", adapter: "openai-responses",
        authMode: "forward", codexAccountMode: "pool", baseUrl: "https://chatgpt.com/backend-api/codex" } } };
      let response: Response | undefined;
      if (path === "probe") await fetchMainAccountInfoSnapshot(true, cfg);
      else if (path === "list") await listCodexAuthAccounts(cfg, true);
      else if (path === "inspect") response = await inspectResetCredits(cfg, "__main__", new AbortController().signal);
      else if (path === "consume") response = await consumeResetCredits(cfg, "__main__", undefined);
      else await primeCodexPoolQuotas(cfg, "startup");
      expect(requests).toBe(history === "plain" ? 1 : 0);
      if (response) expect(response.status).toBe(history === "plain" ? 200 : 401);
      if (history !== "plain") {
        expect(getMainAccountInfoCache()).toBeNull();
        expect(getAccountQuota("__main__")).toBeNull();
        expect(nativeMainRefusals.has(process.env.CODEX_HOME!)).toBe(true);
      }
    });
  }

  test.each([200, 401])("successor candidate clears refusal only after upstream %s", async status => {
    const bearer = fakeChatGptJwt("fixture-main-identity", { jti: "refused" });
    await refuseFileless(bearer);
    const successor = fakeChatGptJwt("fixture-main-identity", { jti: "successor" });
    writeMain(successor);
    expect(getMainAccountCredentialStatus().usable).toBe(true);
    expect(getMainAccountToken()?.accessToken).toBe(successor);
    expect(nativeMainRefusals.has(process.env.CODEX_HOME!)).toBe(true);
    let requests = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${successor}`);
      return Response.json({ plan_type: "plus" }, { status });
    }) as typeof fetch;
    await fetchMainAccountInfoSnapshot(true, config());
    expect(requests).toBe(1);
    expect(nativeMainRefusals.has(process.env.CODEX_HOME!)).toBe(status !== 200);
    if (status !== 200) {
      writeMain(bearer);
      expect(getMainAccountToken()).toBeNull();
    }
  });

  test("a refusal during WHAM invalidates publication and authenticated recovery", async () => {
    const bearer = fakeChatGptJwt("fixture-main-identity");
    writeMain(bearer);
    globalThis.fetch = (async () => {
      nativeMainRefusals.refuse(process.env.CODEX_HOME!, bearer);
      return Response.json({ plan_type: "plus", credits: { balance: "999" }, rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 } } });
    }) as typeof fetch;
    await fetchMainAccountInfoSnapshot(true, config());
    expect(getMainAccountInfoCache()).toBeNull();
    expect(getAccountQuota("__main__")).toBeNull();
    expect(nativeMainRefusals.has(process.env.CODEX_HOME!)).toBe(true);
  });

  test.each(["inspect", "consume"] as const)("reset-credit %s authenticates a successor only after upstream success", async path => {
    await refuseFileless(fakeChatGptJwt("fixture-main-identity", { jti: "refused-reset" }));
    const successor = fakeChatGptJwt("fixture-main-identity", { jti: "successor-reset" });
    writeMain(successor);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${successor}`);
      expect(nativeMainRefusals.has(process.env.CODEX_HOME!)).toBe(true);
      return Response.json({ available_count: 2, code: "no_credit" });
    }) as typeof fetch;
    const response = path === "inspect" ? await inspectResetCredits(config(), "__main__", new AbortController().signal)
      : await consumeResetCredits(config(), "__main__", undefined);
    expect(response.status).toBe(200);
    expect(nativeMainRefusals.has(process.env.CODEX_HOME!)).toBe(false);
  });

  test("reset inspection cannot publish after a concurrent refusal", async () => {
    const bearer = fakeChatGptJwt("fixture-main-identity");
    writeMain(bearer);
    globalThis.fetch = (async () => {
      nativeMainRefusals.refuse(process.env.CODEX_HOME!, bearer);
      return Response.json({ available_count: 2 });
    }) as typeof fetch;
    expect((await inspectResetCredits(config(), "__main__", new AbortController().signal)).status).toBe(409);
    expect(nativeMainRefusals.has(process.env.CODEX_HOME!)).toBe(true);
  });
});

describe("main credits publication", () => {
  test("current credential publishes credits-only usage, omission keeps, null clears", async () => {
    writeMain();
    for (const payload of [{ credits: { balance: "125.725" } }, {}, { credits: null }]) {
      globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
      await fetchMainAccountInfoSnapshot(true, config());
      expect(codexCreditsFor("__main__", "fixture-main-identity"))
        .toEqual("credits" in payload && payload.credits === null ? undefined : { balance: "125.725" });
    }
  });
  test("a response from a replaced bearer never publishes credits", async () => {
    writeMain();
    globalThis.fetch = (async () => {
      writeMain("fixture-replacement-bearer");
      return Response.json({ credits: { balance: "999" } });
    }) as typeof fetch;
    await fetchMainAccountInfoSnapshot(true, config());
    expect(codexCreditsFor("__main__", "fixture-main-identity")).toBeUndefined();
  });
  test("main account DTO is gated, identity-bound and pruning removes retired pool observations", async () => {
    writeMain();
    globalThis.fetch = (async () => Response.json({ credits: { balance: "24.5" } })) as typeof fetch;
    const cfg = config();
    const off = await listCodexAuthAccounts(cfg, true);
    expect(off[0].credits).toBeUndefined();
    cfg.showCodexCredits = true;
    rememberCodexCredits("removed-pool", "removed-identity", { balance: "11" });
    const on = await listCodexAuthAccounts(cfg);
    expect(on[0].credits).toEqual({ balance: "24.5" });
    expect(codexCreditsFor("removed-pool", "removed-identity")).toBeUndefined();
    writeMain("fixture-new-bearer", "fixture-new-identity");
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    expect((await listCodexAuthAccounts(cfg, true))[0].credits).toBeUndefined();
  });
});

describe("pool credits publication", () => {
  test("credits-only response publishes without usage windows and DTO follows the switch", async () => {
    savePool();
    const ctx = poolContext();
    const result = await commitPoolQuotaResponse(Response.json({ credits: { balance: "7.125" } }), ctx);
    expect(result.quota?.credits).toEqual({ balance: 7.125, observedAt: expect.any(Number) });
    for (const window of ["weeklyPercent", "monthlyPercent", "shortPercent", "customWindows"]) {
      expect(result.quota).not.toHaveProperty(window);
    }
    expect(ctx.poolWriter).toBeDefined();
    const cfg = config();
    expect(poolAccountDto(cfg, account, result, true, false, 0, false).credits).toBeUndefined();
    cfg.showCodexCredits = true;
    expect(poolAccountDto(cfg, account, result, true, false, 0, false).credits).toEqual({ balance: "7.125" });
    await commitPoolQuotaResponse(Response.json({}), ctx);
    expect(codexCreditsFor(account.id, poolQuotaHistoryIdentity(account.id)!)).toEqual({ balance: "7.125" });
    await commitPoolQuotaResponse(Response.json({ credits: null }), ctx);
    expect(codexCreditsFor(account.id, poolQuotaHistoryIdentity(account.id)!)).toBeUndefined();
  });
  test("same pool id with a replaced identity hides previous credits and rejects a dead generation", async () => {
    savePool();
    const old = poolContext();
    await commitPoolQuotaResponse(Response.json({ credits: { balance: "5" } }), old);
    savePool("fixture-other-pool-identity");
    expect(poolQuotaHistoryIdentity(account.id)).not.toBe(old.poolWriter!.historyIdentity);
    const dto = poolAccountDto({ ...config(), showCodexCredits: true }, account,
      { quota: null, needsReauth: false }, true, false, 0, false);
    expect(dto.credits).toBeUndefined();
    await commitPoolQuotaResponse(Response.json({ credits: { balance: "9" } }), old);
    expect(codexCreditsFor(account.id, old.poolWriter!.historyIdentity)).toBeUndefined();
  });
  test("a superseded request and a request without a captured writer cannot publish or clear credits", async () => {
    savePool();
    const ctx = poolContext();
    await commitPoolQuotaResponse(Response.json({ credits: { balance: "5" } }), ctx);
    await commitPoolQuotaResponse(Response.json({ credits: null }), { ...ctx, mayPublish: () => false });
    await commitPoolQuotaResponse(Response.json({ credits: { balance: "99" } }), { ...ctx, poolWriter: undefined });
    expect(codexCreditsFor(account.id, ctx.poolWriter!.historyIdentity)).toEqual({ balance: "5" });
  });
  test("with the switch on, the listing bypasses a fresh quota cache once per identity", async () => {
    savePool();
    writeMain();
    const resetAt = Math.floor(Date.now() / 1000) + 3_600;
    const usage = { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: resetAt },
      secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: resetAt } } };
    // A restart keeps the disk-hydrated quota but loses the process-local credits.
    await commitPoolQuotaResponse(Response.json(usage), poolContext());
    resetCodexCreditsForTests();
    let poolReads = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.includes("fixture-pool-bearer")) {
        poolReads += 1;
        return Response.json({ ...usage, credits: { balance: "62498.725" } });
      }
      return Response.json({});
    }) as typeof fetch;
    const cfg: OcxConfig = { ...config(), codexAccounts: [account] };
    expect((await listCodexAuthAccounts(cfg)).find(row => row.id === account.id)?.credits).toBeUndefined();
    expect(poolReads).toBe(0);
    cfg.showCodexCredits = true;
    expect((await listCodexAuthAccounts(cfg)).find(row => row.id === account.id)?.credits).toEqual({ balance: "62498.725" });
    expect(poolReads).toBe(1);
    await listCodexAuthAccounts(cfg);
    expect(poolReads).toBe(1);
  });
});
