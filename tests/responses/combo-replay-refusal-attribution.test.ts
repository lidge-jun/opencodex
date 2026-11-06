import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { WsData } from "../../src/server/ws-bridge";
import type { OcxConfig } from "../../src/types";
import { clearComboSelectionState, clearComboTargetCooldowns, isComboTargetInCooldown } from "../../src/combos";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth } from "../../src/codex/routing";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { resendPermission } from "../../src/lib/request-failure-model";
import { isReplayRefusalResponse, retainReplayRefusal } from "../../src/lib/upstream-retry";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const originalFetch = globalThis.fetch;
let home: TempHome;
let release: () => void;
let finishClient: (() => Promise<void>) | undefined;

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error("Combo refusal fixture did not settle");
    await Bun.sleep(1);
  }
}

function clearRouting(): void {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
}

beforeEach(() => {
  home = createTempHome("ocx-combo-refusal-");
  release = acquireOwnedSpendHome();
  clearRouting();
  clearRequestLogsForTests();
});

afterEach(async () => {
  try { await finishClient?.(); }
  finally {
    finishClient = undefined;
    globalThis.fetch = originalFetch;
    clearRouting();
    try { runOptionalShutdownHooks(); }
    finally { try { release(); } finally { home.remove(); } }
  }
});

async function turn(ingress: "HTTP" | "WebSocket", pool: boolean, reset: boolean) {
  const provider = pool ? "openai" : "fixture";
  const target = { provider, model: "gpt-5.5" };
  const config = { port: 0, defaultProvider: provider, websockets: true, autoSwitchThreshold: 0,
    activeCodexAccountId: "fixture-pool", codexAccounts: pool ? [{ id: "fixture-pool", isMain: false,
      email: "fixture@example.test", chatgptAccountId: "fixture-chatgpt" }] : [],
    providers: {
      [provider]: { adapter: "openai-responses", upstreamWebsocket: false, retryOn429: { enabled: false },
        ...(pool
          ? { baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" }
          : { baseUrl: "https://combo-fixture.invalid/v1", authMode: "key", apiKey: "synthetic-fixture" }),
      },
    },
    combos: { refusal: { alias: "chain/refusal", strategy: "failover", waitForCooldownMs: 0, targets: [target] } },
  } as OcxConfig;
  if (pool) {
    saveCodexAccountCredential("fixture-pool", { accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 300_000, chatgptAccountId: "fixture-chatgpt" });
    updateAccountQuota("fixture-pool", 10);
  }
  let sends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === "127.0.0.1" || new URL(url).hostname === "localhost") {
      return originalFetch(input, init);
    }
    expect(url).toBe(pool
      ? "https://chatgpt.com/backend-api/codex/responses" : "https://combo-fixture.invalid/v1/responses");
    sends++;
    if (reset) throw Object.assign(new Error("synthetic connection reset"), { code: "ECONNRESET" });
    return Response.json({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Fixture rate limit" } },
      { status: 429, headers: { "retry-after": "7" } });
  }) as typeof fetch;
  const body = { model: "chain/refusal", input: "fixture", store: false };
  let status: number;
  let code: string;
  if (ingress === "HTTP") {
    saveConfig(config);
    const server = startServer(0);
    finishClient = async () => { await server.stop(true); };
    const response = await originalFetch(new URL("/v1/responses", server.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    status = response.status;
    code = (await response.json() as { error: { code: string } }).error.code;
    if (reset) {
      expect(response.headers.get("retry-after")).toBeNull();
      expect(response.headers.get("x-should-retry")).toBe("false");
    }
  } else {
    const handler = createWebsocketHandler({ config, deps: {} } as ServeOptionsContext);
    const frames: Array<{ type: string; status: number; error: { code: string } }> = [];
    const ws = { readyState: 1,
      data: { headers: new Headers({ "thread-id": "combo-refusal-fixture" }) } as WsData,
      send: (text: string) => { frames.push(JSON.parse(text)); return 1; },
    } as unknown as ServerWebSocket<WsData>;
    finishClient = async () => {
      handler.close(ws, 1000, "fixture teardown");
      await until(() => !ws.data.cancel && !ws.data.nativeControl);
    };
    handler.message(ws, JSON.stringify({ type: "response.create", ...body }));
    await until(() => frames.some(frame => frame.type === "error") && !ws.data.cancel);
    const error = frames.find(frame => frame.type === "error")!;
    status = error.status;
    code = error.error.code;
  }
  await until(() => getRequestLogEntries().length === 1);
  expect(sends).toBe(1);
  const row = getRequestLogEntries()[0]!;
  expect(row.provider).toBe("combo");
  expect(row.attempts).toHaveLength(1);
  expect(row.attempts![0]!.sendCount).toBe(1);
  expect(row.attempts![0]!.recoveryKinds).toEqual([]);
  // Pool failures cool the physical account; keyed gateways cool the combo target.
  expect(isComboTargetInCooldown("refusal", target)).toBe(!reset && !pool);
  if (pool) {
    if (reset) expect(getCodexUpstreamHealth("fixture-pool")?.lastFailureStatus).toBeUndefined();
    else {
      expect(getCodexUpstreamHealth("fixture-pool")?.lastFailureStatus).toBe(429);
      expect(getCodexUpstreamHealth("fixture-pool")?.cooldownUntil).toBeGreaterThan(Date.now());
    }
  }
  return { row, status, code };
}

test("combo rebuild carries a replay-refusal marker even without a parseable error code", async () => {
  const source = retainReplayRefusal(new Response("opaque fixture", { status: 429,
    headers: { "retry-after": "7", "x-codex-primary-reset-at": "1900000000" } }));
  const failure = await consumeComboFailure(source);
  expect(isReplayRefusalResponse(failure.response)).toBe(true);
  expect(failure.nonReplayable).toBe(true);
  expect(failure.retryAfter).toBeUndefined();
  expect(failure.resetAt).toBeUndefined();
  expect(failure.response.headers.get("retry-after")).toBeNull();
  expect(failure.response.headers.get("x-should-retry")).toBe("false");
  expect((await failure.response.json()).error.code).toBe("upstream_reset_replay_refused");
});

for (const ingress of ["HTTP", "WebSocket"] as const) {
  for (const pool of [false, true]) {
    test(`${ingress} combo ${pool ? "pool" : "gateway"} reset keeps synthetic replay-refusal attribution`, async () => {
      const { row, status, code } = await turn(ingress, pool, true);
      expect(status).toBe(429);
      expect(code).toBe("upstream_reset_replay_refused");
      expect(row.errorCode).toBe("upstream_reset_replay_refused");
      expect(row.failureCause).toBe("transport-ambiguous");
      expect(row.terminalSource).toBe("synthetic");
      expect(row.failureStage).toBe("headers-only");
      expect(row.attempts![0]!.errorCode).toBe("upstream_reset_replay_refused");
      expect(row.attempts![0]!.failureCause).toBe("transport-ambiguous");
      expect(row.attempts![0]!.failureStage).toBe("headers-only");
      expect(resendPermission(row.failureStage!, row.failureCause!)).toBe("refused-ambiguous");
    });

    test(`${ingress} combo ${pool ? "pool" : "gateway"} genuine upstream 429 remains rate-limit evidence`, async () => {
      const { row, status, code } = await turn(ingress, pool, false);
      expect(status).toBe(429);
      expect(code).toBe("rate_limit_exceeded");
      expect(row.errorCode).toBe("rate_limit_exceeded");
      expect(row.failureCause).toBe("rate-limit");
      expect(row.attempts![0]!.failureCause).toBe("rate-limit");
      expect(row.terminalSource).not.toBe("synthetic");
    });
  }
}
