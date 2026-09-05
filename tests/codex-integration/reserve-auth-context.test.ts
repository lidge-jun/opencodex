import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAccountCooldownError, CodexMainAccountHardLockError, CodexReserveUnavailableError,
  cooldownErrorMessage, cooldownErrorResponse, headersForCodexAuthContext,
  materializeCodexUpstreamAuthAsync, resolveCodexAuthContext, shouldMarkAccountNeedsReauthForCodexAuthFailure,
  type CodexAuthContext,
} from "../../src/codex/auth-context";
import { NATIVE_RESERVE_MODEL } from "../../src/codex/catalog/native-models";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaCredential } from "../../src/codex/main-account-cache";
import { clearAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import * as mainAccount from "../../src/codex/main-account";
import * as authCollision from "../../src/codex/auth-collision";
import { isMainReserveAuthorizationLive, observeMainReserveRevocation } from "../../src/codex/reserve-availability";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { WhamUsageResponse } from "../../src/codex/quota-types";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MAIN = mainAccount.MAIN_CODEX_ACCOUNT_ID;
const accountId = "reserve-workspace-fixture";
let home: string;
let oldHome: string | undefined;
let oldCodexHome: string | undefined;
let accessToken: string;
let usage: WhamUsageResponse;
let requests: Request[];
let duringUsageRead: (() => void) | undefined;

function token(user = "reserve-user-a"): string {
  const payload = Buffer.from(JSON.stringify({ exp: 4_000_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: user },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function config(): OcxConfig {
  return {
    port: 0, defaultProvider: "openai", codexDesktopAuthless: true, codexMainAccountHardLock: true,
    autoSwitchThreshold: 0, activeCodexAccountId: "unused-pool", codexAccounts: [],
    providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "pool",
        baseUrl: "https://chatgpt.com/backend-api/codex" },
      "custom-native": { adapter: "openai-responses", authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex" },
      independent: { adapter: "openai-responses", authMode: "key", apiKey: "reserve-key-fixture",
        baseUrl: "https://independent.example.test/v1" },
    },
  };
}

function caller(value = accessToken, workspace = accountId): Headers {
  return new Headers({ authorization: `Bearer ${value}`, "chatgpt-account-id": workspace });
}

function writeMain(value = accessToken): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    tokens: { access_token: value, refresh_token: "reserve-refresh-fixture", account_id: accountId },
  }));
  reconcileMainCodexAccountRuntimeState();
  observeMainQuotaCredential(value, accountId);
}

function quota(percent: number): void {
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("fixture requires an owned identity");
  setAccountQuotaFromParsed(MAIN, { shortPercent: percent, shortWindowSeconds: 18_000 }, undefined, writer);
}

const selection = () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} });
const loopbackAdmission = { kind: "loopback", source: "loopback" } as const;
const reserveOptions = { modelId: NATIVE_RESERVE_MODEL, beginCodexAccountSelection: selection, admission: loopbackAdmission };

function prohibitPhysicalReads(): void {
  const fail = () => { throw new Error("unexpected physical-main credential read"); };
  spyOn(authCollision, "readCodexTokens").mockImplementation(fail);
  spyOn(authCollision, "getMainChatgptAccountId").mockImplementation(fail);
  spyOn(mainAccount, "getMainAccountToken").mockImplementation(fail);
  spyOn(mainAccount, "getValidMainAccountToken").mockImplementation(fail);
}

beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME;
  oldCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-reserve-auth-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth(MAIN);
  resetMainCodexAccountIdentityTrackingForTests();
  mainAccount.setMainAccountPlan(null);
  accessToken = token();
  writeMain();
  quota(20);
  usage = {
    account_id: accountId, user_id: "reserve-user-a",
    rate_limit: { allowed: false, primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
    rate_limit_upsell: { banner_type: "luna_reserve" },
    additional_rate_limits: [{ limit_name: NATIVE_RESERVE_MODEL, rate_limit: { allowed: true } }],
  };
  requests = [];
  duringUsageRead = undefined;
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (
    input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
  ) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    if (request.url === "https://chatgpt.com/backend-api/wham/usage") {
      duringUsageRead?.();
      return Response.json(usage);
    }
    if (request.url.endsWith("/responses/compact")) {
      return Response.json({ id: "cmp_reserve_fixture", object: "response.compaction", output: [] });
    }
    if (request.url.endsWith("/responses")) {
      return Response.json({ id: "resp_reserve_fixture", object: "response", status: "completed", created_at: 1,
        model: NATIVE_RESERVE_MODEL, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }
    throw new Error("unexpected outbound fixture destination");
  }, { preconnect() {} }));
});

afterEach(async () => {
  mock.restore();
  clearAccountQuota(); // Cancels this fixture's pending persistence timer before deleting its home.
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth(MAIN);
  resetMainCodexAccountIdentityTrackingForTests();
  mainAccount.setMainAccountPlan(null);
  try {
    await flushConfigDirHardeningForTests();
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    removeTreeWithRetry(home);
  }
});

describe("Reserve owned auth admission", () => {
  test("unqualified Reserve pins stored main, requires capability WHAM, and carries private proof", async () => {
    const cfg = config();
    const ctx = await resolveCodexAuthContext(new Headers(), cfg, "direct", reserveOptions);
    expect(ctx).toMatchObject({ kind: "main-pool", accountId: MAIN, fixedAccount: true, quotaScope: "reserve" });
    if (ctx.kind !== "main-pool") throw new Error("expected owned main context");
    expect(isMainReserveAuthorizationLive(ctx.reserveAuthorization, ctx)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("x-openai-codex-luna-reserve")).toBe("1");
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headersForCodexAuthContext(new Headers(), ctx, cfg, NATIVE_RESERVE_MODEL, loopbackAdmission).get("chatgpt-account-id")).toBe(accountId);
    expect(cfg.activeCodexAccountId).toBe("unused-pool");
  });

  test("explicit non-main selection and unmatched callers cannot manufacture a grant", async () => {
    prohibitPhysicalReads();
    await expect(resolveCodexAuthContext(caller(), config(), "pool", { ...reserveOptions, accountId: "other" }))
      .rejects.toBeInstanceOf(CodexReserveUnavailableError);
    for (const headers of [caller(token("reserve-user-b")), caller(accessToken, "different-workspace")]) {
      await expect(resolveCodexAuthContext(headers, config(), "direct", reserveOptions))
        .rejects.toBeInstanceOf(CodexReserveUnavailableError);
    }
    expect(requests).toHaveLength(0);
  });

  test("matched caller gets proof with no physical reads", async () => {
    prohibitPhysicalReads();
    const ctx = await resolveCodexAuthContext(caller(), config(), "pool", {
      ...reserveOptions, requestScopedMainCredential: true,
    });
    expect(ctx.kind).toBe("main");
    expect(headersForCodexAuthContext(caller(), ctx, config(), NATIVE_RESERVE_MODEL, loopbackAdmission).get("authorization"))
      .toBe(`Bearer ${accessToken}`);
    expect(requests).toHaveLength(1);
  });

  test("effective-authless off leaves native-client default handling unchanged", async () => {
    const cfg = config();
    cfg.runtimeRole = "client";
    await expect(resolveCodexAuthContext(caller("opaque-client"), cfg, "direct", reserveOptions))
      .resolves.toEqual({ kind: "main", accountId: null });
    expect(requests).toHaveLength(0);
  });

  test("a configured secondary listener cannot enable compatibility on public or unattributed ingress", async () => {
    const cfg = config();
    cfg.hostname = "0.0.0.0";
    cfg.unauthenticatedLoopbackListener = { enabled: true, port: 10101 };
    const admissions: Array<Pick<DataPlaneAdmission, "source"> | undefined> = [
      undefined, { source: "dedicated" }, { source: "bearer" }, { source: "x-api-key" },
    ];
    prohibitPhysicalReads();
    for (const admission of admissions) {
      const ctx = await resolveCodexAuthContext(caller(), cfg, "direct", { modelId: NATIVE_RESERVE_MODEL, admission });
      expect(ctx).toEqual({ kind: "main", accountId: null });
      const selected = await materializeCodexUpstreamAuthAsync(caller(), ctx, {
        config: cfg, modelId: NATIVE_RESERVE_MODEL, admission,
      });
      expect(headersForCodexAuthContext(selected, ctx, cfg, NATIVE_RESERVE_MODEL, admission).get("authorization"))
        .toBe(`Bearer ${accessToken}`);
    }
    expect(requests).toHaveLength(0);
  });

  test("retained99 and global cooldown prevent even the permission read, without a probe", async () => {
    quota(99);
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", reserveOptions))
      .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    expect(requests).toHaveLength(0);
    quota(0);
    recordCodexUpstreamOutcome(config(), MAIN, 429, { retryAfter: "3600", fixedAccount: true });
    const before = structuredClone(getCodexUpstreamHealth(MAIN));
    await expect(resolveCodexAuthContext(caller(), config(), "direct", reserveOptions))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
    expect(getCodexUpstreamHealth(MAIN)).toEqual(before);
    expect(requests).toHaveLength(0);
  });

  test("a granting WHAM response that observes99 still refuses Reserve", async () => {
    usage.rate_limit!.primary_window!.used_percent = 99;
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", reserveOptions))
      .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    expect(requests).toHaveLength(1);
    expect(getMainPolicyQuota()?.shortPercent).toBe(99);
    expect(isAccountNeedsReauth(MAIN)).toBe(false);
  });

  test("malformed negative WHAM cannot release99 observed while the permission read was pending", async () => {
    usage.rate_limit!.primary_window!.used_percent = -1;
    duringUsageRead = () => quota(99);
    await expect(resolveCodexAuthContext(caller(), config(), "direct", reserveOptions))
      .rejects.toBeInstanceOf(CodexMainAccountHardLockError);
    expect(getMainPolicyQuota()?.shortPercent).toBe(99);
    expect(requests).toHaveLength(1);
  });

  test("Reserve cooldown arriving during permission read wins over a positive grant", async () => {
    duringUsageRead = () => recordCodexUpstreamOutcome(config(), MAIN, 429, {
      modelId: NATIVE_RESERVE_MODEL, resetAt: Date.now() + 3_600_000, fixedAccount: true,
    });
    await expect(resolveCodexAuthContext(caller(), config(), "direct", reserveOptions))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
    expect(requests).toHaveLength(1);
    expect(isAccountNeedsReauth(MAIN)).toBe(false);
  });

  test("final sync materialization refuses a synthetic or revoked proof", async () => {
    const cfg = config();
    expect(() => headersForCodexAuthContext(caller(), { kind: "main", accountId: null }, cfg, NATIVE_RESERVE_MODEL, loopbackAdmission))
      .toThrow(CodexReserveUnavailableError);
    const ctx = await resolveCodexAuthContext(caller(), cfg, "direct", reserveOptions);
    observeMainReserveRevocation({ rate_limit: { allowed: true } }, captureMainQuotaWriter(accountId));
    expect(() => headersForCodexAuthContext(caller(), ctx, cfg, NATIVE_RESERVE_MODEL, loopbackAdmission)).toThrow(CodexReserveUnavailableError);
  });

  test("refreshed token cannot inherit spread authorization and must obtain its own permission", async () => {
    const cfg = config();
    const ctx = await resolveCodexAuthContext(new Headers(), cfg, "pool", reserveOptions);
    if (ctx.kind !== "main-pool") throw new Error("expected owned main context");
    const refreshed: CodexAuthContext = { ...ctx, accessToken: token("reserve-user-b") };
    expect(isMainReserveAuthorizationLive(ctx.reserveAuthorization, refreshed)).toBe(false);
    expect(() => headersForCodexAuthContext(new Headers(), refreshed, cfg, NATIVE_RESERVE_MODEL, loopbackAdmission))
      .toThrow(CodexReserveUnavailableError);
    usage.user_id = "reserve-user-b";
    usage.additional_rate_limits![0]!.rate_limit!.allowed = false;
    await expect(materializeCodexUpstreamAuthAsync(new Headers(), refreshed, {
      config: cfg, modelId: NATIVE_RESERVE_MODEL, admission: loopbackAdmission,
    }))
      .rejects.toBeInstanceOf(CodexReserveUnavailableError);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers.get("authorization")).toBe(`Bearer ${refreshed.accessToken}`);
    expect(isAccountNeedsReauth(MAIN)).toBe(false);
  });

  test("handler custom Reserve denial sends zero inference while the same caller's keyed model succeeds", async () => {
    usage.additional_rate_limits = [];
    const cfg = config();
    const post = (model: string) => handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { ...Object.fromEntries(caller()), "content-type": "application/json" },
      body: JSON.stringify({ model, input: "ping", stream: false }),
    }), cfg, { model: "", provider: "" }, { admission: loopbackAdmission });
    const refused = await post("custom-native/gpt-reserve");
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("Reserve is unavailable");
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(["/backend-api/wham/usage"]);
    const keyed = await post("independent/gpt-reserve");
    expect(keyed.status).toBe(200);
    await keyed.text();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe("https://independent.example.test/v1/responses");
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer reserve-key-fixture");
  });

  test("handler positive custom Reserve proof reaches inference exactly once", async () => {
    const result = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { ...Object.fromEntries(caller()), "content-type": "application/json" },
      body: JSON.stringify({ model: "custom-native/gpt-reserve", input: "ping", stream: false }),
    }), config(), { model: "", provider: "" }, { admission: loopbackAdmission });
    expect(result.status).toBe(200);
    await result.text();
    expect(requests.map(request => new URL(request.url).pathname))
      .toEqual(["/backend-api/wham/usage", "/backend-api/codex/responses"]);
    expect(requests[1]!.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  });

  test("custom canonical compact cannot skip permission because its context has no marker", async () => {
    usage.additional_rate_limits = [];
    const result = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
      method: "POST", headers: { ...Object.fromEntries(caller()), "content-type": "application/json" },
      body: JSON.stringify({ model: "custom-native/gpt-reserve", input: [{ role: "user", content: "ping" }] }),
    }), config(), { model: "", provider: "" }, undefined, loopbackAdmission);
    expect(result.status).toBe(429);
    await result.text();
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(["/backend-api/wham/usage"]);
  });

  test("Reserve errors preserve cooldown-family HTTP formatting without fake reset or reauth", () => {
    const error = new CodexReserveUnavailableError();
    expect(error).toBeInstanceOf(CodexAccountCooldownError);
    expect(cooldownErrorMessage(error)).not.toContain("clear-cooldown");
    expect(cooldownErrorResponse(error).status).toBe(429);
    expect(cooldownErrorResponse(error).headers.has("retry-after")).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(error)).toBe(false);
    expect(cooldownErrorMessage(new CodexAccountCooldownError(MAIN, Date.now() + 60_000, undefined, "reserve")))
      .toContain("Reserve quota");
  });
});
