import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexAccountCooldownUntil } from "../../src/codex/routing";
import type { CodexAuthContext } from "../../src/codex/auth-context";
import { codexForwardTerminalOutcomeRecorder } from "../../src/server/responses/core";
import {
  httpStatusForRequestLogTerminal,
  inspectResponseLogSsePayload,
  type RequestLogContext,
} from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/quota";
import {
  isModelHealthBlocked,
  resetSubagentModelFallbackStateForTests,
  setSubagentQuotaPrimeForTests,
} from "../../src/codex/subagent-model-fallback";
import { handleResponses } from "../../src/server/responses";
import type { HandleResponsesOptions } from "../../src/server/responses/core";
import { isEagerRelaySseResponse } from "../../src/server/relay";
import { sendResponseToWebSocket, type WsData } from "../../src/server/ws-bridge";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SERVER_BUDGET_MS } from "../helpers/test-budget";

const provider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};

function auth(fixedAccount = false): CodexAuthContext {
  return {
    kind: "pool", accountId: "incomplete-quota-fixture", accessToken: "test-token",
    chatgptAccountId: "test-account", generation: 1,
    writerGeneration: captureConfigGeneration(), fixedAccount,
  };
}

function inspect(response: Record<string, unknown>): RequestLogContext {
  const log: RequestLogContext = { model: "gpt-test", provider: "openai" };
  inspectResponseLogSsePayload(log, JSON.stringify({ type: "response.incomplete", response }));
  return log;
}

afterEach(() => clearCodexUpstreamHealth());

describe("incomplete quota terminal attribution", () => {
  for (const response of [
    { incomplete_details: { reason: "usage_limit_reached" } },
    { incomplete_details: { reason: "rate_limit_exceeded" } },
    { incomplete_details: { reason: "insufficient_quota" } },
    { error: { code: "usage_limit_reached" } },
    { error: { type: "rate_limit_error" } },
    { incomplete_details: { message: "The usage limit has been reached" } },
  ]) {
    test(`SSE inspection records quota health for ${JSON.stringify(response)}`, () => {
      const log = inspect(response);
      expect(log.terminalHttpStatus).toBe(429);
      expect(httpStatusForRequestLogTerminal("incomplete", log)).toBe(429);
      const record = codexForwardTerminalOutcomeRecorder(getDefaultConfig(), auth(), provider, "gpt-test", log);
      expect(record).toBeDefined();
      record!("incomplete");
      expect(getCodexAccountCooldownUntil("incomplete-quota-fixture")).toBeGreaterThan(Date.now());
    });
  }

  for (const reason of ["max_output_tokens", "content_filter", "steered", "upstream_stall_timeout", "unknown"]) {
    test(`ordinary ${reason} incomplete does not cool the account`, () => {
      const log = inspect({ incomplete_details: { reason } });
      expect(log.terminalHttpStatus).toBeUndefined();
      codexForwardTerminalOutcomeRecorder(getDefaultConfig(), auth(), provider, "gpt-test", log)!("incomplete");
      expect(getCodexAccountCooldownUntil("incomplete-quota-fixture")).toBeNull();
    });
  }

  test("policy refusal takes precedence over conflicting quota details", () => {
    const log = inspect({
      error: { code: "cyber_policy", message: "blocked" },
      incomplete_details: { reason: "usage_limit_reached" },
    });
    expect(log.terminalHttpStatus).toBe(400);
    codexForwardTerminalOutcomeRecorder(getDefaultConfig(), auth(), provider, "gpt-test", log)!("incomplete");
    expect(getCodexAccountCooldownUntil("incomplete-quota-fixture")).toBeNull();
  });

  test("a generic transport override does not erase captured quota evidence", () => {
    const log = inspect({ incomplete_details: { reason: "usage_limit_reached" } });
    codexForwardTerminalOutcomeRecorder(getDefaultConfig(), auth(), provider, "gpt-test", log)!("incomplete", 502);
    expect(getCodexAccountCooldownUntil("incomplete-quota-fixture")).toBeGreaterThan(Date.now());
  });

  for (const status of [402, 429]) {
    test(`parent terminal override ${status} reaches the child recorder`, () => {
      // Combo/WS inspection owns the parent log, while this recorder closes over a child log.
      const child: RequestLogContext = { model: "gpt-test", provider: "openai" };
      codexForwardTerminalOutcomeRecorder(getDefaultConfig(), auth(true), provider, "gpt-test", child)!("incomplete", status);
      expect(getCodexAccountCooldownUntil("incomplete-quota-fixture")).toBeGreaterThan(Date.now());
    });
  }
});

type ReporterPath = "parent-recorder" | "guarded-ws" | "native-sse";

// Drive the endpoint and its real transport/inspection owners. Only the external
// Codex destination is redirected; the recorder and spawn health store stay real.
async function exerciseSpawnReporter(path: ReporterPath): Promise<void> {
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-incomplete-quota-"));
  const codexHome = installIsolatedCodexHome("ocx-incomplete-quota-codex-");
  process.env.OPENCODEX_HOME = home;
  const accountId = "incomplete-quota-endpoint";
  const model = "gpt-test";
  const config: OcxConfig = {
    ...getDefaultConfig(),
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    streamMode: "legacy-tee",
    providers: { openai: { ...provider, codexAccountMode: "pool" } },
    codexAccounts: [{
      id: accountId, email: "quota@example.test", isMain: false,
      chatgptAccountId: "acct-quota-endpoint",
    }],
    activeCodexAccountId: accountId,
  };
  let reason = "max_output_tokens";
  let httpDispatches = 0;
  let wsDispatches = 0;
  const terminal = () => ({
    type: "response.incomplete",
    response: {
      id: `resp-${path}-${reason}`, object: "response", status: "incomplete",
      model, output: [], incomplete_details: { reason },
    },
  });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket" && server.upgrade(req)) return;
      httpDispatches++;
      return new Response(`event: response.incomplete\ndata: ${JSON.stringify(terminal())}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    websocket: {
      message(ws, message) {
        const request = JSON.parse(String(message));
        expect(request.type).toBe("response.create");
        expect(request.model).toBe(model);
        wsDispatches++;
        ws.send(JSON.stringify(terminal()));
      },
    },
  });
  let logCtx: RequestLogContext = { model: "", provider: "" };
  const resolved: { auth?: CodexAuthContext } = {};
  let parentTerminal: string | undefined;
  let eager: boolean | undefined;
  let registered: Parameters<NonNullable<HandleResponsesOptions["setTerminalOutcomeRecorder"]>>[0];
  let reportTerminal: (status: string) => void = () => {};
  let rejectTerminal: (error: unknown) => void = () => {};
  const options = (): HandleResponsesOptions => ({
    // Use the existing runtime seam: HTTP fixtures must not accidentally select
    // WS on a newer Bun, and the WS fixture must exercise the guarded relay.
    codexWsRuntimeIdentity: path === "guarded-ws" ? "1.4.0" : "1.3.14",
    recordTerminalOutcomes: path !== "parent-recorder",
    onCodexAuthContextResolved: context => { resolved.auth = context; },
    setTerminalOutcomeRecorder: recorder => { registered = recorder; },
    onNativePassthroughTerminal: status => {
      if (path === "parent-recorder") parentTerminal = status;
      else reportTerminal(status);
    },
  });
  const endpoint = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      if (path === "parent-recorder" && server.upgrade(req, { data: { headers: req.headers } })) return;
      const response = await handleResponses(req, config, logCtx, options());
      eager = isEagerRelaySseResponse(response);
      return response;
    },
    websocket: {
      async message(ws, message) {
        try {
          const payload = JSON.parse(String(message));
          const response = await handleResponses(new Request("http://localhost/v1/responses", {
            method: "POST", headers: ws.data.headers,
            body: JSON.stringify({ ...payload, stream: true }),
          }), config, logCtx, { ...options(), inboundTransport: "websocket" });
          expect(response.status).toBe(200);
          expect(registered).toBeDefined();
          // Same ownership as server/index.ts: the bridge inspects first, then
          // calls the recorder registered by core. Inject 502 only at this
          // existing override seam to prove it cannot erase captured typed 429.
          await sendResponseToWebSocket(ws, response, () => true, {
            onSsePayload: payload => inspectResponseLogSsePayload(logCtx, payload),
            onTerminal: status => registered!(status, 502),
          });
          expect(parentTerminal).toBe("incomplete");
          reportTerminal(parentTerminal!);
        } catch (error) {
          rejectTerminal(error);
        }
      },
    },
  });
  let client: WebSocket | undefined;
  try {
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountQuota();
    resetSubagentModelFallbackStateForTests();
    setSubagentQuotaPrimeForTests(async () => {});
    saveCodexAccountCredential(accountId, {
      accessToken: "endpoint-token", refreshToken: "endpoint-refresh",
      expiresAt: Date.now() + 60 * 60_000, chatgptAccountId: "acct-quota-endpoint",
    });
    updateAccountQuota(accountId, 10);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
        return realFetch(new URL("/responses", upstream.url), init);
      }
      if (url.origin === endpoint.url.origin) return realFetch(input, init);
      throw new Error(`Unexpected quota fixture fetch: ${url.origin}${url.pathname}`);
    }) as typeof fetch;
    globalThis.WebSocket = new Proxy(RealWebSocket, {
      construct(target, args) {
        const url = new URL(String(args[0]));
        if (url.origin === "wss://chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
          return Reflect.construct(target, [upstream.url.toString().replace("http:", "ws:"), ...args.slice(1)]);
        }
        throw new Error(`Unexpected quota fixture WebSocket: ${url.origin}${url.pathname}`);
      },
    });

    // Ordinary incomplete comes first, so its negative assertion cannot be
    // masked by clearing health produced by the quota terminal.
    for (const quota of [false, true]) {
      reason = quota ? "usage_limit_reached" : "max_output_tokens";
      logCtx = { model: "", provider: "" };
      resolved.auth = undefined;
      parentTerminal = undefined;
      registered = undefined;
      expect(isModelHealthBlocked(model, config, accountId)).toBe(false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reported = new Promise<string>((resolve, reject) => {
        reportTerminal = resolve;
        rejectTerminal = reject;
        timer = setTimeout(() => reject(new Error(`${path}: terminal reporter did not run`)), INTERNAL_DEADLINE_MS);
      });
      const headers = {
        "content-type": "application/json", authorization: "Bearer inbound-fixture",
        "x-openai-subagent": "collab_spawn",
      };
      const body = { model, input: "hello", stream: true };
      try {
        const deliver = async () => {
          if (path === "parent-recorder") {
            // Real downstream WS; construction bypasses only our upstream redirect.
            client = new RealWebSocket(endpoint.url.toString().replace("http:", "ws:") + "v1/responses", {
              headers,
            } as unknown as string[]);
            client.addEventListener("open", () => client!.send(JSON.stringify({ type: "response.create", ...body })));
            client.addEventListener("error", () => rejectTerminal(new Error("endpoint WebSocket failed")));
          } else {
            const response = await realFetch(new URL("/v1/responses", endpoint.url), {
              method: "POST", headers, body: JSON.stringify(body),
              signal: AbortSignal.timeout(INTERNAL_DEADLINE_MS),
            });
            expect(response.status).toBe(200);
            expect(await response.text()).toContain('"status":"incomplete"');
            expect(eager).toBe(path === "guarded-ws");
          }
        };
        const [status] = await Promise.all([reported, deliver()]);
        expect(status).toBe("incomplete");
        expect(resolved).toMatchObject({ auth: { kind: "pool", accountId } });
        expect(resolved).not.toMatchObject({ auth: { fixedAccount: true } });
        expect(logCtx.terminalHttpStatus).toBe(quota ? 429 : undefined);
        // This is the actual store read by selectAvailableSubagentModel, separate
        // from pool cooldown: removing any one reporter's spawn write fails here.
        expect(isModelHealthBlocked(model, config, accountId)).toBe(quota);
        expect(isModelHealthBlocked(model, config, "another-account")).toBe(false);
        if (quota) expect(getCodexAccountCooldownUntil(accountId)).toBeGreaterThan(Date.now());
        else expect(getCodexAccountCooldownUntil(accountId)).toBeNull();
      } finally {
        clearTimeout(timer);
        client?.close();
        client = undefined;
      }
    }
    expect(wsDispatches).toBe(path === "guarded-ws" ? 2 : 0);
    expect(httpDispatches).toBe(path === "guarded-ws" ? 0 : 2);
  } finally {
    client?.close();
    await endpoint.stop(true);
    await upstream.stop(true);
    globalThis.fetch = realFetch;
    globalThis.WebSocket = RealWebSocket;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountQuota();
    resetSubagentModelFallbackStateForTests();
    codexHome.restore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
}

describe("incomplete quota endpoint reporter wiring", () => {
  test("registered parent reporter preserves typed quota over 502 and updates spawn health", async () => {
    await exerciseSpawnReporter("parent-recorder");
  }, { timeout: SERVER_BUDGET_MS });

  test("guarded native WS reporter updates spawn health only for quota incomplete", async () => {
    await exerciseSpawnReporter("guarded-ws");
  }, { timeout: SERVER_BUDGET_MS });

  // core always applies a field-backfill rewrite; win32 therefore forces eager
  // before the tee reporter regardless of streamMode (Bun#32111). Do not label
  // that eager path as native-SSE reporter coverage on Windows.
  test.skipIf(process.platform === "win32")("regular native SSE reporter updates spawn health only for quota incomplete", async () => {
    await exerciseSpawnReporter("native-sse");
  }, { timeout: SERVER_BUDGET_MS });
});
