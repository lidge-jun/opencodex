import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAccountCooldownError, CodexReserveUnavailableError, CodexReserveHelperUnsupportedError,
  cooldownErrorResponse, createCodexReserveDispatchGuard,
  resolveCodexAuthContext, unwrapUpstreamRetryEvidenceError,
} from "../../src/codex/auth-context";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaCredential, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearCodexUpstreamHealth, getCodexUpstreamHealth, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { isMainReserveAuthorizationLive, observeMainReserveRevocation } from "../../src/codex/reserve-availability";
import { clearUpstreamHostHealth, getUpstreamHostHealth, upstreamHostHealthKey } from "../../src/codex/upstream-host-health";
import { providerFetch, fetchWithHeaderTimeout } from "../../src/server/responses/fetch-helpers";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { UpstreamRetryEvidenceError } from "../../src/lib/upstream-retry";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const accountId = "reserve-dispatch-workspace";
const accessToken = "reserve-dispatch-owned-fixture";
const URL = "https://chatgpt.com/backend-api/codex/responses";
const loopbackAdmission = { kind: "loopback", source: "loopback" } as const;
let home: string;
let oldHome: string | undefined;
let oldCodexHome: string | undefined;
let now: number;
let usageReads: number;
let inferenceSends: number;
let inference: () => Response | Promise<Response>;

function config(): OcxConfig {
  return {
    port: 0, defaultProvider: "custom", codexDesktopAuthless: true, codexMainAccountHardLock: true,
    providers: { custom: {
      adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
    } },
  };
}

function headers(token = accessToken, workspace = accountId): Headers {
  return new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": workspace });
}

function revoke(): void {
  observeMainReserveRevocation({ rate_limit: { allowed: true } }, captureMainQuotaWriter(accountId));
}

async function authorize() {
  const cfg = config();
  const ctx = await resolveCodexAuthContext(headers(), cfg, "direct", { modelId: "gpt-reserve", admission: loopbackAdmission });
  if (ctx.kind !== "main" || !ctx.reserveAuthorization) throw new Error("fixture expected an owned private grant");
  const guard = createCodexReserveDispatchGuard(ctx, cfg, "gpt-reserve", loopbackAdmission);
  if (!guard) throw new Error("fixture expected a dispatch guard");
  return { ctx, cfg, guard };
}

beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME;
  oldCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-reserve-dispatch-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearAccountNeedsReauth("__main__");
  clearCodexUpstreamHealth();
  clearUpstreamHostHealth();
  observeMainQuotaIdentity(accountId);
  observeMainQuotaCredential(accessToken, accountId);
  now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now);
  usageReads = 0;
  inferenceSends = 0;
  inference = () => Response.json({ id: "resp_dispatch_fixture", object: "response", status: "completed",
    created_at: 1, model: "gpt-reserve", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (
    input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
  ) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === "https://chatgpt.com/backend-api/wham/usage") {
      usageReads += 1;
      return Response.json({
        account_id: accountId,
        rate_limit: { allowed: false, primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
        rate_limit_upsell: { banner_type: "luna_reserve" },
        additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: true } }],
      });
    }
    if (request.url === URL || request.url === `${URL}/compact`) {
      inferenceSends += 1;
      return inference();
    }
    throw new Error("unexpected dispatch fixture destination");
  }, { preconnect() {} }));
});

afterEach(async () => {
  mock.restore();
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearAccountNeedsReauth("__main__");
  clearCodexUpstreamHealth();
  clearUpstreamHostHealth();
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

describe("Reserve dispatch-time permission", () => {
  test("a positive conversation grant cannot authorize a terminal helper enabled during pacing", async () => {
    const { ctx, cfg } = await authorize();
    const token = { accessToken, chatgptAccountId: accountId };
    expect(isMainReserveAuthorizationLive(ctx.reserveAuthorization, token)).toBe(true);
    cfg.codexDesktopAuthless = false;
    const guard = createCodexReserveDispatchGuard(ctx, cfg, "gpt-reserve", loopbackAdmission, true);
    expect(guard).toBeDefined();
    const executor = providerFetch(cfg.providers.custom!, "1.3.14", { beforeDispatch: guard });
    let release!: () => void;
    const paced = new Promise<void>(resolve => { release = resolve; });
    executor.waitForPacing = () => paced;
    const pending = fetchWithHeaderTimeout(URL, { method: "POST", headers: headers(), body: "{}" },
      new AbortController().signal, 1000, false, executor);
    const observed = pending.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    cfg.codexDesktopAuthless = true;
    release();
    const outcome = await observed;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Expected terminal helper refusal");
    expect(outcome.error).toBeInstanceOf(CodexReserveHelperUnsupportedError);
    if (!(outcome.error instanceof CodexReserveHelperUnsupportedError)) throw outcome.error;
    const response = cooldownErrorResponse(outcome.error);
    expect(response.status).toBe(429);
    expect(response.headers.has("retry-after")).toBe(false);
    expect(await response.text()).toContain("only available as a conversation model");
    expect(isMainReserveAuthorizationLive(ctx.reserveAuthorization, token)).toBe(true);
    expect(inferenceSends).toBe(0);
    expect(usageReads).toBe(1);
    expect(getCodexUpstreamHealth("__main__")).toBeNull();
    expect(getUpstreamHostHealth(upstreamHostHealthKey("custom", "https://chatgpt.com"))).toBeNull();
  });

  test("off-to-on during pacing activates the installed guard without obtaining a new grant", async () => {
    const cfg = config();
    cfg.codexDesktopAuthless = false;
    const guard = createCodexReserveDispatchGuard({ kind: "main", accountId: null }, cfg, "gpt-reserve", loopbackAdmission);
    expect(guard).toBeDefined();
    const executor = providerFetch(cfg.providers.custom!, "1.3.14", { beforeDispatch: guard });
    let release!: () => void;
    const paced = new Promise<void>(resolve => { release = resolve; });
    executor.waitForPacing = () => paced;
    const pending = fetchWithHeaderTimeout(URL, { method: "POST", headers: headers(), body: "{}" },
      new AbortController().signal, 1000, false, executor);
    const observed = pending.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    cfg.codexDesktopAuthless = true;
    release();
    const outcome = await observed;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Expected dispatch refusal");
    expect(outcome.error).toBeInstanceOf(CodexReserveUnavailableError);
    expect(inferenceSends).toBe(0);
    expect(usageReads).toBe(0);
  });

  test("an installed guard leaves a still-disabled request on its original unproved path", async () => {
    const cfg = config();
    cfg.codexDesktopAuthless = false;
    const guard = createCodexReserveDispatchGuard({ kind: "main", accountId: null }, cfg, "gpt-reserve", loopbackAdmission);
    expect(guard).toBeDefined();
    const response = await providerFetch(cfg.providers.custom!, "1.3.14", { beforeDispatch: guard })(URL, {
      method: "POST", headers: headers(), body: "{}",
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(inferenceSends).toBe(1);
    expect(usageReads).toBe(0);
  });

  test("dispatch freezes admission source while keeping policy config live", async () => {
    const { ctx, cfg } = await authorize();
    const admission: Pick<DataPlaneAdmission, "source"> = { source: "loopback" };
    const guard = createCodexReserveDispatchGuard(ctx, cfg, "gpt-reserve", admission);
    expect(guard).toBeDefined();
    admission.source = "dedicated";
    revoke();
    expect(() => guard!(headers())).toThrow(CodexReserveUnavailableError);
    cfg.codexDesktopAuthless = false;
    expect(() => guard!(headers())).not.toThrow();
    expect(usageReads).toBe(1);
    expect(inferenceSends).toBe(0);
  });

  test("public or missing admission never creates a compatibility guard despite a secondary listener", async () => {
    const { ctx, cfg } = await authorize();
    cfg.hostname = "0.0.0.0";
    cfg.unauthenticatedLoopbackListener = { enabled: true, port: 10101 };
    const admissions: Array<Pick<DataPlaneAdmission, "source"> | undefined> = [
      undefined, { source: "dedicated" }, { source: "bearer" }, { source: "x-api-key" },
    ];
    for (const admission of admissions) {
      expect(createCodexReserveDispatchGuard(ctx, cfg, "gpt-reserve", admission)).toBeUndefined();
    }
    expect(createCodexReserveDispatchGuard(ctx, cfg, "gpt-reserve", loopbackAdmission)).toBeDefined();
  });

  test("cached proof expiring during pacing refuses before HTTP and never renews", async () => {
    const { ctx, cfg, guard } = await authorize();
    const executor = providerFetch(cfg.providers.custom!, "1.3.14", { beforeDispatch: guard });
    let release!: () => void;
    const paced = new Promise<void>(resolve => { release = resolve; });
    executor.waitForPacing = () => paced;
    const pending = fetchWithHeaderTimeout(URL, { method: "POST", headers: headers(), body: "{}" },
      new AbortController().signal, 1000, false, executor);
    const observed = pending.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    now = ctx.reserveAuthorization!.expiresAt + 1;
    release();
    const outcome = await observed;
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("Expected dispatch refusal");
    expect(outcome.error).toBeInstanceOf(CodexReserveUnavailableError);
    expect(inferenceSends).toBe(0);
    expect(usageReads).toBe(1);
  });

  test("HTTP guards the actual init override, not the earlier Request credential", async () => {
    const { cfg, guard } = await authorize();
    const executor = providerFetch(cfg.providers.custom!, "1.3.14", { beforeDispatch: guard });
    const request = new Request(URL, { method: "POST", headers: headers(), body: "{}" });
    await expect(executor(request, { headers: headers("different-token") }))
      .rejects.toBeInstanceOf(CodexReserveUnavailableError);
    await expect(executor(request, { headers: headers(accessToken, "different-workspace") }))
      .rejects.toBeInstanceOf(CodexReserveUnavailableError);
    expect(inferenceSends).toBe(0);
    const response = await executor(new Request(URL, { headers: headers("wrong-inherited-token") }), { headers: headers() });
    expect(response.status).toBe(200);
    await response.text();
    expect(inferenceSends).toBe(1);
    expect(usageReads).toBe(1);
  });

  test("unguarded unrelated transport remains unchanged", async () => {
    const { ctx, cfg } = await authorize();
    expect(createCodexReserveDispatchGuard(ctx, cfg, "gpt-5.6-luna", loopbackAdmission)).toBeUndefined();
    const provider: OcxProviderConfig & { fetch: typeof fetch } = {
      adapter: "openai-responses", authMode: "key", baseUrl: "https://independent.example.test/v1",
      fetch: Object.assign(async () => new Response("keyed-ok"), { preconnect() {} }),
    };
    now = ctx.reserveAuthorization!.expiresAt + 1;
    const response = await providerFetch(provider)("https://independent.example.test/v1/responses", { headers: headers("keyed") });
    expect(await response.text()).toBe("keyed-ok");
  });

  test("nested reset and502 wrappers preserve the original local refusal", () => {
    const refusal = new CodexReserveUnavailableError();
    const nested = new UpstreamRetryEvidenceError([502], new UpstreamRetryEvidenceError([], refusal, true));
    expect(unwrapUpstreamRetryEvidenceError(nested)).toBe(refusal);
    const transport = new Error("network failed");
    expect(unwrapUpstreamRetryEvidenceError(transport)).toBe(transport);
  });

  for (const endpoint of ["responses", "compact"] as const) {
    for (const firstFailure of ["reset", "502"] as const) {
      test(`${endpoint}: ${firstFailure} then revoked proof maps to429 without a second inference or health mutation`, async () => {
        inference = () => {
          // Permission changes after the first real attempt, before the retry wrapper dispatches.
          revoke();
          if (firstFailure === "reset") throw Object.assign(new Error("fixture connection reset"), { code: "ECONNRESET" });
          return new Response("gateway failed", { status: 502, headers: { "retry-after": "0" } });
        };
        const request = new Request(`http://localhost/v1/responses${endpoint === "compact" ? "/compact" : ""}`, {
          method: "POST", headers: { ...Object.fromEntries(headers()), "content-type": "application/json" },
          body: JSON.stringify({ model: "custom/gpt-reserve", input: [{ role: "user", content: "ping" }], stream: false }),
        });
        const response = endpoint === "compact"
          ? await handleResponsesCompact(request, config(), { model: "", provider: "" }, undefined, loopbackAdmission)
          : await handleResponses(request, config(), { model: "", provider: "" }, { admission: loopbackAdmission });
        expect(response.status).toBe(429);
        expect(await response.text()).toContain("Reserve is unavailable");
        expect(inferenceSends).toBe(1);
        expect(usageReads).toBe(1);
        expect(getCodexUpstreamHealth("__main__")).toBeNull();
        expect(getUpstreamHostHealth(upstreamHostHealthKey("custom", "https://chatgpt.com"))).toBeNull();
      });
    }
  }

  test("global cooldown activated between attempts is authoritative without quota-read renewal", async () => {
    const cfg = config();
    let recorded: ReturnType<typeof getCodexUpstreamHealth>;
    inference = () => {
      recordCodexUpstreamOutcome(cfg, "__main__", 429, { retryAfter: "3600", fixedAccount: true });
      recorded = structuredClone(getCodexUpstreamHealth("__main__"));
      return new Response("gateway failed", { status: 502, headers: { "retry-after": "0" } });
    };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { ...Object.fromEntries(headers()), "content-type": "application/json" },
      body: JSON.stringify({ model: "custom/gpt-reserve", input: "ping", stream: false }),
    }), cfg, { model: "", provider: "" }, { admission: loopbackAdmission });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("cooling down");
    expect(getCodexUpstreamHealth("__main__")).toEqual(recorded!);
    expect(inferenceSends).toBe(1);
    expect(usageReads).toBe(1);
  });

  test("guard rechecks a live global cooldown against already granted actual headers", async () => {
    const { cfg, guard } = await authorize();
    recordCodexUpstreamOutcome(cfg, "__main__", 429, { retryAfter: "3600", fixedAccount: true });
    expect(() => guard(headers())).toThrow(CodexAccountCooldownError);
    expect(inferenceSends).toBe(0);
  });
});
