import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearComboSelectionState,
  clearComboTargetCooldowns,
  isComboTargetInCooldown,
} from "../src/combos";
import { readConfigDiagnostics, saveConfig } from "../src/config";
import type { ProviderAdapter } from "../src/adapters/base";
import { handleManagementAPI } from "../src/server/management-api";
import { saveCredential } from "../src/oauth/store";
import { XAI_OAUTH_DISCOVERY_URL } from "../src/oauth/xai";
import { XAI_GROK_CLI_BASE_URL } from "../src/providers/xai-transport";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { clearRequestLogsForTests, type RequestLogContext } from "../src/server/request-log";
import { responseWithDeferredRequestLog } from "../src/server/relay";
import { readUsageEntries } from "../src/usage/log";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { formatCodexProviderForLog } from "../src/codex/routing";
import { startServer } from "../src/server";

const actualResolver = await import("../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
const actualRetry = await import("../src/lib/upstream-retry");
const actualFetchWithTransientRetry = actualRetry.fetchWithTransientRetry;
let customRunTurn: NonNullable<ProviderAdapter["runTurn"]> | undefined;
let customFetchResponse: NonNullable<ProviderAdapter["fetchResponse"]> | undefined;
let customTransientResponse: (() => Promise<Response>) | undefined;
let customUsageEstimate: ((model: string) => number | undefined) | undefined;

mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter === "test-run-turn") {
      const adapter: ProviderAdapter = {
        name: "test-run-turn",
        buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
        async *parseStream(): AsyncGenerator<AdapterEvent> {
          yield { type: "error", message: "test runTurn adapter does not use parseStream" };
        },
        async runTurn(parsed, incoming, emit) {
          if (!customRunTurn) throw new Error("custom runTurn not installed");
          await customRunTurn(parsed, incoming, emit);
        },
      };
      return adapter;
    }
    if (provider.adapter === "test-response") {
      const base = actualResolveAdapter({ ...provider, adapter: "openai-chat" }, cacheRetention);
      return {
        ...base,
        name: "test-response",
        async buildRequest(parsed, options) {
          const request = await base.buildRequest(parsed, options);
          const estimate = customUsageEstimate?.(parsed.modelId);
          return estimate === undefined
            ? request
            : { ...request, usageLog: { inputTokens: estimate } };
        },
        async fetchResponse(request, context) {
          if (!customFetchResponse) throw new Error("custom fetchResponse not installed");
          return customFetchResponse(request, context);
        },
      };
    }
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

mock.module("../src/lib/upstream-retry", () => ({
  ...actualRetry,
  fetchWithTransientRetry(
    ...args: Parameters<typeof actualFetchWithTransientRetry>
  ): ReturnType<typeof actualFetchWithTransientRetry> {
    if (customTransientResponse) return customTransientResponse();
    return actualFetchWithTransientRetry(...args);
  },
}));

const { handleResponses } = await import("../src/server/responses");
type HandleOptions = NonNullable<Parameters<typeof handleResponses>[3]>;

const TOKEN_ENDPOINT = "https://auth.x.ai/oauth/token";
const XAI_CHAT_ENDPOINT = `${XAI_GROK_CLI_BASE_URL}/chat/completions`;

let testDir = "";
let previousHome: string | undefined;
let previousCursorToken: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;
let originalNow: () => number;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalNow = Date.now;
  previousHome = process.env.OPENCODEX_HOME;
  previousCursorToken = process.env.OPENCODEX_CURSOR_TEST_TOKEN;
  delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-030-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-030-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  customRunTurn = undefined;
  customFetchResponse = undefined;
  customTransientResponse = undefined;
  customUsageEstimate = undefined;
  clearRequestLogsForTests();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const server of servers.splice(0)) await server.stop(true);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCursorToken === undefined) delete process.env.OPENCODEX_CURSOR_TEST_TOKEN;
  else process.env.OPENCODEX_CURSOR_TEST_TOKEN = previousCursorToken;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearRequestLogsForTests();
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

function chatSuccess(text: string, model = "model"): Response {
  return Response.json({
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

function chatStream(text: string): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

function responsesSuccess(text: string, model = "responses-model"): Record<string, unknown> {
  return {
    id: `resp-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_backup",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

function provider(
  adapter: string,
  url: string,
  apiKey: string,
  extra: Partial<OcxProviderConfig> = {},
): OcxProviderConfig {
  return {
    adapter,
    baseUrl: url,
    allowPrivateNetwork: url.includes("127.0.0.1"),
    authMode: "key",
    apiKey,
    ...extra,
  };
}

function comboConfig(
  providers: OcxConfig["providers"],
  targets = Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
  extra: Partial<NonNullable<OcxConfig["combos"]>[string]> = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { free: { strategy: "failover", targets, ...extra } },
  };
}

async function post(
  config: OcxConfig,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, { model: "", provider: "" }, options);
}

let loggedRequestSequence = 0;

async function postLogged(
  config: OcxConfig,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const start = Date.now();
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, logCtx, options);
  loggedRequestSequence += 1;
  return responseWithDeferredRequestLog(
    response,
    `combo-test-${loggedRequestSequence}`,
    start,
    logCtx,
  );
}

async function latestAttemptReceipts(config: OcxConfig) {
  const response = await management(config, "GET", "/api/logs?tail=1");
  const logs = await response!.json() as Array<Record<string, unknown>>;
  const usage = readUsageEntries();
  return { log: logs[0]!, usage: usage.at(-1)! };
}

async function expectCancelledAttemptReceipt(
  config: OcxConfig,
  expected: { provider: string; model: string; adapter: string },
): Promise<void> {
  const { log, usage } = await latestAttemptReceipts(config);
  for (const receipt of [log, usage]) {
    expect(receipt).toMatchObject({
      provider: "combo",
      model: "combo/free",
      attempts: [{ ...expected, status: 499 }],
    });
    expect((receipt.attempts as unknown[])).toHaveLength(1);
  }
}

interface SseFrame {
  event?: string;
  data: Record<string, unknown>;
}

async function collectSse(response: Response): Promise<SseFrame[]> {
  const text = await response.text();
  return text.split("\n\n").flatMap(block => {
    if (!block.trim()) return [];
    let event: string | undefined;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data || data === "[DONE]") return [];
    try {
      return [{ ...(event ? { event } : {}), data: JSON.parse(data) as Record<string, unknown> }];
    } catch {
      return [];
    }
  });
}

async function management(
  config: OcxConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleManagementAPI(request, new URL(request.url), config, {
    refreshCodexCatalog: async () => {},
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("server combo failover 030 activation matrix", () => {
  test("ordinary openai-chat 503 hops to backup for non-stream and stream", async () => {
    const hits: string[] = [];
    const a = serve(async request => {
      hits.push(`a:${(await request.json() as { stream?: boolean }).stream}`);
      return Response.json({ error: { message: "overloaded" } }, { status: 503 });
    });
    const b = serve(async request => {
      const body = await request.json() as { stream?: boolean };
      hits.push(`b:${body.stream}`);
      return body.stream ? chatStream("stream backup") : chatSuccess("json backup", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });

    const unary = await post(config);
    expect(unary.status).toBe(200);
    expect(JSON.stringify(await unary.json())).toContain("json backup");
    clearComboTargetCooldowns();
    clearComboSelectionState();
    const streaming = await post(config, { stream: true });
    expect(streaming.status).toBe(200);
    expect(JSON.stringify(await collectSse(streaming))).toContain("stream backup");
    expect(hits).toEqual(["a:false", "b:false", "a:true", "b:true"]);
  });

  test("persists one logical A503 to B200 request with ordered physical usage", async () => {
    const a = serve(() => Response.json({
      error: { message: "overloaded" },
      usage: { input_tokens: 7, output_tokens: 1, total_tokens: 8 },
    }, { status: 503 }));
    const b = serve(() => chatSuccess("logged backup", "m2"));
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await postLogged(config);
    expect(response.status).toBe(200);
    await response.text();
    const { log, usage } = await latestAttemptReceipts(config);

    for (const receipt of [log, usage]) {
      expect(receipt).toMatchObject({
        provider: "combo",
        model: "combo/free",
        requestedModel: "combo/free",
        resolvedModel: "m2",
        attempts: [
          { ordinal: 1, provider: "a", model: "m1", status: 503, usage: { inputTokens: 7, outputTokens: 1 } },
          { ordinal: 2, provider: "b", model: "m2", status: 200, usage: { inputTokens: 2, outputTokens: 1 } },
        ],
      });
    }
  });

  test("bare alias runs full failover and preserves structural combo log identity", async () => {
    const targetBodies: Array<{ provider: string; model?: unknown }> = [];
    const a = serve(async request => {
      const body = await request.json() as { model?: unknown };
      targetBodies.push({ provider: "a", model: body.model });
      return Response.json({ error: { message: "overloaded" } }, { status: 503 });
    });
    const b = serve(async request => {
      const body = await request.json() as { model?: unknown };
      targetBodies.push({ provider: "b", model: body.model });
      return chatSuccess("alias backup", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    }, undefined, { alias: "deepseek-v4-flash" });
    const response = await postLogged(config, { model: "deepseek-v4-flash" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("alias backup");
    expect(targetBodies).toEqual([
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ]);
    const { log, usage } = await latestAttemptReceipts(config);
    for (const receipt of [log, usage]) {
      expect(receipt).toMatchObject({
        provider: "combo",
        model: "deepseek-v4-flash",
        requestedModel: "deepseek-v4-flash",
        attempts: [
          { ordinal: 1, provider: "a", model: "m1", status: 503 },
          { ordinal: 2, provider: "b", model: "m2", status: 200 },
        ],
      });
    }
  });

  test("ordinary /v1/models restores a non-OpenAI selector after combo alias rename and deletion", async () => {
    const selector = "deepseek/deepseek-chat";
    const combo = {
      strategy: "failover" as const,
      targets: [{ provider: "deepseek", model: "deepseek-chat" }],
      alias: selector,
    };
    const config = comboConfig({
      deepseek: provider("openai-chat", "http://127.0.0.1:1/v1", "key-deepseek", {
        liveModels: false,
        models: ["deepseek-chat"],
        modelContextWindows: { "deepseek-chat": 128_000 },
      }),
    }, combo.targets, { alias: combo.alias });
    saveConfig(config);
    const server = startServer(0);
    try {
      const publicRows = async () => {
        const response = await fetch(new URL("/v1/models", server.url));
        expect(response.status).toBe(200);
        const payload = await response.json() as {
          data: Array<{ id: string; owned_by: string }>;
        };
        return payload.data;
      };
      const updateAlias = async (alias: string) => fetch(new URL("/api/combos", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "free", combo: { ...combo, alias } }),
      });

      expect((await publicRows()).filter(model => model.id === selector)).toEqual([
        { id: selector, object: "model", created: 0, owned_by: "combo" },
      ]);

      const renamed = await updateAlias("fast-chat");
      expect(renamed.status).toBe(200);
      const renamedRows = await publicRows();
      expect(renamedRows.filter(model => model.id === selector)).toEqual([
        { id: selector, object: "model", created: 0, owned_by: "deepseek" },
      ]);
      expect(renamedRows.filter(model => model.id === "fast-chat")).toEqual([
        { id: "fast-chat", object: "model", created: 0, owned_by: "combo" },
      ]);

      const restored = await updateAlias(selector);
      expect(restored.status).toBe(200);
      const deleted = await fetch(new URL("/api/combos?id=free", server.url), { method: "DELETE" });
      expect(deleted.status).toBe(200);
      const deletedRows = await publicRows();
      expect(deletedRows.filter(model => model.id === selector)).toEqual([
        { id: selector, object: "model", created: 0, owned_by: "deepseek" },
      ]);
      expect(deletedRows.some(model => model.owned_by === "combo")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("ordinary /v1/models preserves raw nested selectors while an exact combo alias wins", async () => {
    const config = comboConfig({
      a: provider("openai-chat", "http://127.0.0.1:1/v1", "key-a", {
        liveModels: false,
        models: ["vendor/model", "vendor-model"],
        modelContextWindows: { "vendor/model": 128_000, "vendor-model": 128_000 },
      }),
    }, [{ provider: "a", model: "vendor/model" }], { alias: "a/vendor-model" });
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/models", server.url));
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        data: Array<{ id: string; owned_by: string }>;
      };
      expect(payload.data.filter(model => model.id.startsWith("a/vendor")).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "a/vendor-model", object: "model", created: 0, owned_by: "combo" },
        { id: "a/vendor/model", object: "model", created: 0, owned_by: "a" },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("streaming failover records request-relative parent TTFT and attempt-relative attempt TTFT", async () => {
    // A fails after a real delay so parent TTFT (request-relative) must exceed
    // the successful B attempt's own TTFT (attempt-relative) — WP4 separation.
    const A_DELAY_MS = 120;
    const a = serve(async () => {
      await new Promise(resolve => setTimeout(resolve, A_DELAY_MS));
      return Response.json({ error: { message: "overloaded" } }, { status: 503 });
    });
    const b = serve(() => chatStream("ttft backup"));
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await postLogged(config, { stream: true });
    expect(response.status).toBe(200);
    await response.text();
    const { log, usage } = await latestAttemptReceipts(config);
    for (const receipt of [log, usage]) {
      const parentTtft = receipt.firstOutputMs as number;
      expect(typeof parentTtft).toBe("number");
      expect(parentTtft).toBeGreaterThanOrEqual(A_DELAY_MS);
      const attempts = receipt.attempts as Array<Record<string, unknown>>;
      expect(attempts).toHaveLength(2);
      // failed attempt A produced no output: unset
      expect(attempts[0]).not.toHaveProperty("firstOutputMs");
      // successful attempt B: attempt-relative, strictly smaller than the parent value
      const attemptTtft = attempts[1]!.firstOutputMs as number;
      expect(typeof attemptTtft).toBe("number");
      expect(attemptTtft).toBeGreaterThanOrEqual(0);
      expect(attemptTtft).toBeLessThan(parentTtft);
    }
  });

  test("non-streaming failover leaves firstOutputMs unset", async () => {
    const a = serve(() => Response.json({ error: { message: "overloaded" } }, { status: 503 }));
    const b = serve(() => chatSuccess("json backup", "m2"));
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await postLogged(config);
    expect(response.status).toBe(200);
    await response.text();
    const { log, usage } = await latestAttemptReceipts(config);
    for (const receipt of [log, usage]) {
      expect(receipt).not.toHaveProperty("firstOutputMs");
      const attempts = receipt.attempts as Array<Record<string, unknown>>;
      for (const attempt of attempts) expect(attempt).not.toHaveProperty("firstOutputMs");
    }
  });

  test("seals a Codex pool child to its safe account label and final wire adapter", async () => {
    const rawAccountId = "raw-pool-account-id";
    const config = comboConfig({
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    }, [{ provider: "openai", model: "gpt-5.4" }]);
    config.codexAccounts = [{
      id: rawAccountId,
      email: "pool@example.test",
      isMain: false,
      logLabel: "pabc123",
    }];
    config.activeCodexAccountId = rawAccountId;
    config.autoSwitchThreshold = 0;
    saveCodexAccountCredential(rawAccountId, {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 300_000,
      chatgptAccountId: "acct-pool-safe",
    });
    customTransientResponse = async () => Response.json(responsesSuccess("pool success", "gpt-5.4"));

    const response = await postLogged(config);
    expect(response.status).toBe(200);
    await response.text();

    const expectedProvider = formatCodexProviderForLog("openai", rawAccountId, config);
    const { log, usage } = await latestAttemptReceipts(config);
    for (const receipt of [log, usage]) {
      expect(receipt).toMatchObject({
        provider: "combo",
        model: "combo/free",
        attempts: [{
          provider: expectedProvider,
          adapter: "openai-responses",
          status: 200,
        }],
      });
      expect(JSON.stringify(receipt)).not.toContain(rawAccountId);
      expect(JSON.stringify(receipt)).not.toContain("acct-pool-safe");
    }
  });

  test("keeps a failed estimate on A without overwriting B reported usage", async () => {
    customUsageEstimate = model => model === "m1" ? 41 : undefined;
    customFetchResponse = async request => {
      const model = (JSON.parse(String(request.body)) as { model?: string }).model;
      return model === "m1"
        ? Response.json({ error: { message: "down" } }, { status: 503 })
        : chatSuccess("estimate backup", "m2");
    };
    const config = comboConfig({
      a: provider("test-response", "https://test.invalid/v1", "key-a"),
      b: provider("test-response", "https://test.invalid/v1", "key-b"),
    });
    const response = await postLogged(config);
    await response.text();
    const { usage } = await latestAttemptReceipts(config);
    expect(usage.attempts).toMatchObject([
      { provider: "a", usageStatus: "estimated", inputTokenEstimate: 41, usage: { inputTokens: 41, outputTokens: 0, estimated: true } },
      { provider: "b", usageStatus: "reported", usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
  });

  test("captures ordinary failed usage from its original bounded body exactly once", async () => {
    let ordinaryReads = 0;
    customFetchResponse = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        ordinaryReads += 1;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          error: { message: "ordinary failed" },
          usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
        })));
        controller.close();
      },
    }), { status: 503, headers: { "content-type": "application/json" } });
    const ordinaryConfig = comboConfig({
      a: provider("test-response", "https://test.invalid/v1", "key-a"),
    });
    const ordinary = await postLogged(ordinaryConfig);
    const ordinaryBody = await ordinary.json() as Record<string, unknown>;
    expect(ordinaryBody).not.toHaveProperty("usage");
    expect(ordinaryReads).toBe(1);
    expect((await latestAttemptReceipts(ordinaryConfig)).usage.attempts?.[0]?.usage)
      .toEqual({ inputTokens: 11, outputTokens: 2, totalTokens: 13 });
  });

  test("captures passthrough failed usage from its original bounded body exactly once", async () => {
    let passthroughReads = 0;
    let passthroughResponses = 0;
    customTransientResponse = async () => {
      passthroughResponses += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          error: { message: "passthrough failed" },
          usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
        })));
        controller.close();
        },
      });
      const response = new Response(body, { status: 503, headers: { "content-type": "application/json" } });
      Object.defineProperty(response, "body", {
        configurable: true,
        get() {
          passthroughReads += 1;
          return body;
        },
      });
      return response;
    };
    const passthroughConfig = comboConfig({
      a: provider("openai-responses", "https://passthrough.test/v1", "key-a"),
    });
    const passthrough = await postLogged(passthroughConfig);
    expect(passthrough.status).toBe(503);
    const passthroughBody = await passthrough.json() as Record<string, unknown>;
    expect(passthroughBody).not.toHaveProperty("usage");
    expect(passthroughResponses).toBe(1);
    expect(passthroughReads).toBe(1);
    expect((await latestAttemptReceipts(passthroughConfig)).usage.attempts?.[0]?.usage)
      .toEqual({ inputTokens: 17, outputTokens: 3, totalTokens: 20 });
  });

  test("provider-local retry keeps one attempt, two sends, recovery kind, and latest estimate", async () => {
    const estimates = [10, 25];
    customUsageEstimate = () => estimates.shift();
    let calls = 0;
    customFetchResponse = async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: { message: "rotate" } }, { status: 429 })
        : chatSuccess("rotated", "m1");
    };
    const pool = [
      { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
      { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
    ];
    const config = comboConfig({
      a: provider("test-response", "https://test.invalid/v1", pool[0]!.key, { apiKeyPool: pool }),
    });
    const response = await postLogged(config);
    expect(response.status).toBe(200);
    await response.text();
    const attempt = (await latestAttemptReceipts(config)).usage.attempts?.[0];
    expect(attempt).toMatchObject({
      provider: "a",
      model: "m1",
      sendCount: 2,
      inputTokenEstimate: 25,
      recoveryKinds: ["key-429"],
    });
  });

  test("connection exception reaches the backup exactly once", async () => {
    let bHits = 0;
    const b = serve(() => {
      bHits += 1;
      return chatSuccess("connected backup", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", "http://127.0.0.1:1/v1", "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await post(config);
    expect(response.status).toBe(200);
    expect(bHits).toBe(1);
    expect(JSON.stringify(await response.json())).toContain("connected backup");
  });

  test("Azure passthrough 403 hops into ordinary openai-chat", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("azure");
      return Response.json({ error: { message: "permission denied" } }, { status: 403 });
    });
    const b = serve(() => {
      hits.push("chat");
      return chatSuccess("chat backup", "m2");
    });
    const config = comboConfig({
      a: provider("azure", baseUrl(a), "azure-key"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await post(config);
    expect(response.status).toBe(200);
    expect(hits).toEqual(["azure", "chat"]);
  });

  test("cross-adapter chat 503 to Responses 200 returns the exact backup response", async () => {
    const a = serve(() => Response.json({ error: { message: "down" } }, { status: 503 }));
    const exact = responsesSuccess("raw backup", "m2");
    let bBody: Record<string, unknown> | undefined;
    const b = serve(async request => {
      bBody = await request.json() as Record<string, unknown>;
      return Response.json(exact);
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });
    const response = await post(config);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(exact);
    expect(bBody?.model).toBe("m2");
  });

  test("Cursor runTurn first-event error hops before stream commit", async () => {
    let bHits = 0;
    const b = serve(() => {
      bHits += 1;
      return chatStream("cursor backup");
    });
    const config = comboConfig({
      a: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", models: ["m1"] },
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await post(config, { stream: true });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await collectSse(response))).toContain("cursor backup");
    expect(bHits).toBe(1);
  });

  test("hosted web-search eager model failure hops through the loop path", async () => {
    const modelHits: Array<{ model?: string; hasWebTool: boolean }> = [];
    const routed = serve(async request => {
      const body = await request.json() as { model?: string; tools?: Array<{ type?: string }> };
      modelHits.push({
        model: body.model,
        hasWebTool: body.tools?.some(tool => tool.type === "function") ?? false,
      });
      if (body.model === "m1") {
        return Response.json({ error: { message: "loop unavailable" } }, { status: 503 });
      }
      return chatStream("web loop backup");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(routed), "key-a"),
      b: provider("openai-chat", baseUrl(routed), "key-b"),
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    }, [
      { provider: "a", model: "m1" },
      { provider: "b", model: "m2" },
    ]);
    config.webSearchSidecar = { enabled: true, backend: "openai" };
    const response = await post(config, {
      stream: true,
      tools: [{ type: "web_search" }],
    }, {}, { authorization: "Bearer forwarded-main" });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await collectSse(response))).toContain("web loop backup");
    expect(modelHits.map(hit => hit.model)).toEqual(["m1", "m2"]);
    expect(modelHits.every(hit => hit.hasWebTool)).toBe(true);
  });

  test("context 400 stops while exhausted retryable targets return the sanitized last status", async () => {
    let stopBackupHits = 0;
    const context = serve(() => Response.json({ error: { code: "context_length_exceeded", message: "too many tokens" } }, { status: 400 }));
    const unused = serve(() => {
      stopBackupHits += 1;
      return chatSuccess("must not run");
    });
    const stopConfig = comboConfig({
      a: provider("openai-chat", baseUrl(context), "key-a"),
      b: provider("openai-chat", baseUrl(unused), "key-b"),
    });
    const stopped = await post(stopConfig);
    expect(stopped.status).toBe(400);
    expect(stopBackupHits).toBe(0);

    const order: string[] = [];
    const first = serve(() => {
      order.push("a");
      return new Response("secret sk-a-should-redact", { status: 503 });
    });
    const last = serve(() => {
      order.push("b");
      return Response.json({ error: { message: "missing model" } }, { status: 404 });
    });
    const exhausted = await post(comboConfig({
      a: provider("openai-chat", baseUrl(first), "key-a"),
      b: provider("openai-chat", baseUrl(last), "key-b"),
    }));
    expect(exhausted.status).toBe(404);
    expect(order).toEqual(["a", "b"]);
    expect(await exhausted.text()).not.toContain("sk-a-should-redact");
  });

  test("429 Retry-After 120 keeps A cooling at 60 seconds and restores it at 120", async () => {
    const t0 = Date.parse("2026-07-18T00:00:00.000Z");
    let now = t0;
    Date.now = () => now;
    let aHits = 0;
    let bHits = 0;
    const a = serve(() => {
      aHits += 1;
      if (aHits === 1) {
        return Response.json({ error: { message: "rate limited" } }, {
          status: 429,
          headers: { "retry-after": "120" },
        });
      }
      return chatSuccess("a recovered", "m1");
    });
    const b = serve(() => {
      bHits += 1;
      return chatSuccess("b backup", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    expect((await post(config)).status).toBe(200);
    now = t0 + 60_000;
    expect((await post(config)).status).toBe(200);
    expect(aHits).toBe(1);
    now = t0 + 120_000;
    expect((await post(config)).status).toBe(200);
    expect(aHits).toBe(2);
    expect(bHits).toBe(2);
  });

  test("fresh child reparsing recomputes vision and effort per target", async () => {
    const bodies: Array<{ provider: string; body: Record<string, unknown> }> = [];
    const a = serve(async request => {
      bodies.push({ provider: "a", body: await request.json() as Record<string, unknown> });
      return Response.json({ error: { message: "retry" } }, { status: 503 });
    });
    const b = serve(async request => {
      bodies.push({ provider: "b", body: await request.json() as Record<string, unknown> });
      return chatSuccess("vision backup", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a", {
        noVisionModels: ["m1"],
        reasoningEfforts: ["low"],
      }),
      b: provider("openai-chat", baseUrl(b), "key-b", {
        reasoningEfforts: ["low", "high"],
      }),
    }, undefined, { defaultEffort: "high" });
    const response = await post(config, {
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      }],
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(bodies[0]!.body)).not.toContain("data:image/png");
    expect(JSON.stringify(bodies[1]!.body)).toContain("data:image/png");
    expect(bodies[0]!.body.reasoning_effort).toBeUndefined();
    expect(bodies[1]!.body.reasoning_effort).toBe("high");

    clearComboSelectionState();
    clearComboTargetCooldowns();
    bodies.length = 0;
    const owned = await post(config, { reasoning: { effort: "low" } });
    expect(owned.status).toBe(200);
    expect(bodies.map(row => row.body.reasoning_effort)).toEqual(["low", "low"]);
  });

  test("backup noReasoningModels removes the fresh combo default", async () => {
    const a = serve(() => Response.json({ error: { message: "retry" } }, { status: 503 }));
    let backupBody: Record<string, unknown> | undefined;
    const b = serve(async request => {
      backupBody = await request.json() as Record<string, unknown>;
      return chatSuccess("no reasoning", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b", { noReasoningModels: ["m2"] }),
    }, undefined, { defaultEffort: "high" });
    expect((await post(config)).status).toBe(200);
    expect(backupBody).not.toHaveProperty("reasoning_effort");
  });

  test("xAI 401 refresh stays within one target and succeeds without backup", async () => {
    await saveCredential("xai", {
      access: "xai-old",
      refresh: "xai-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct-xai",
      source: "oauth",
    });
    let refreshHits = 0;
    let backupHits = 0;
    const auth: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === XAI_OAUTH_DISCOVERY_URL) {
        return Response.json({ authorization_endpoint: "https://auth.x.ai/oauth/authorize", token_endpoint: TOKEN_ENDPOINT });
      }
      if (url === TOKEN_ENDPOINT) {
        refreshHits += 1;
        return Response.json({ access_token: "xai-fresh", refresh_token: "xai-refresh-2", expires_in: 3600 });
      }
      if (url === XAI_CHAT_ENDPOINT) {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        auth.push(bearer);
        return bearer === "Bearer xai-old"
          ? Response.json({ error: { message: "rejected" } }, { status: 401 })
          : chatSuccess("xai refreshed", "grok");
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const backup = serve(() => {
      backupHits += 1;
      return chatSuccess("unused");
    });
    const config = comboConfig({
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    }, [{ provider: "xai", model: "grok" }, { provider: "b", model: "m2" }]);
    expect((await post(config)).status).toBe(200);
    expect(refreshHits).toBe(1);
    expect(auth).toEqual(["Bearer xai-old", "Bearer xai-fresh"]);
    expect(backupHits).toBe(0);
  });

  test("backup 401 never triggers xAI refresh or receives an xAI bearer", async () => {
    for (const includeC of [false, true]) {
      clearComboSelectionState();
      clearComboTargetCooldowns();
      await saveCredential("xai", {
        access: "xai-live",
        refresh: "xai-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "acct-xai",
        source: "oauth",
      });
      let refreshHits = 0;
      const backupAuth: string[] = [];
      const captured = new Set<string>();
      globalThis.fetch = (async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(init?.headers);
        captured.add(JSON.stringify([...headers.entries()]));
        if (typeof init?.body === "string") captured.add(init.body);
        if (url === XAI_OAUTH_DISCOVERY_URL) {
          return Response.json({ authorization_endpoint: "https://auth.x.ai/oauth/authorize", token_endpoint: TOKEN_ENDPOINT });
        }
        if (url === TOKEN_ENDPOINT) {
          refreshHits += 1;
          return Response.json({ access_token: "xai-refreshed-secret", refresh_token: "refresh", expires_in: 3600 });
        }
        if (url === XAI_CHAT_ENDPOINT) {
          return Response.json({ error: { message: "xai unavailable" } }, { status: 503 });
        }
        if (url.includes("/b/v1/chat/completions")) {
          backupAuth.push(headers.get("authorization") ?? "");
          return Response.json({ error: { message: "backup key rejected" } }, { status: 401 });
        }
        if (url.includes("/c/v1/chat/completions")) return chatSuccess("third target", "m3");
        return originalFetch(input, init);
      }) as typeof fetch;
      const local = serve(request => originalFetch(request));
      const root = local.url.toString().replace(/\/$/, "");
      const providers: OcxConfig["providers"] = {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
        b: provider("openai-chat", `${root}/b/v1`, "key-b"),
        ...(includeC ? { c: provider("openai-chat", `${root}/c/v1`, "key-c") } : {}),
      };
      const targets = [
        { provider: "xai", model: "grok" },
        { provider: "b", model: "m2" },
        ...(includeC ? [{ provider: "c", model: "m3" }] : []),
      ];
      const response = await post(comboConfig(providers, targets));
      expect(response.status).toBe(includeC ? 200 : 401);
      expect(refreshHits).toBe(0);
      expect(backupAuth).toEqual(["Bearer key-b"]);
      expect([...captured].join("\n")).not.toContain("xai-refreshed-secret");
      expect([...captured].filter(value => value.includes("/b/")).join("\n")).not.toContain("xai-live");
      globalThis.fetch = originalFetch;
      await local.stop(true);
      servers.splice(servers.indexOf(local), 1);
    }
  });

  test("committed runTurn heartbeat text error never replays on backup", async () => {
    let aHits = 0;
    let bHits = 0;
    customRunTurn = async (_parsed, _incoming, emit) => {
      aHits += 1;
      emit({ type: "heartbeat" });
      emit({ type: "text_delta", text: "once" });
      emit({ type: "error", message: "late failure" });
    };
    const b = serve(() => {
      bHits += 1;
      return chatStream("duplicate");
    });
    const config = comboConfig({
      a: provider("test-run-turn", "test://run-turn", "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await post(config, { stream: true });
    const frames = await collectSse(response);
    expect(aHits).toBe(1);
    expect(bHits).toBe(0);
    expect(frames.filter(frame => frame.event === "response.output_text.delta"))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({ delta: "once" }) })]);
    expect(frames.filter(frame => frame.event === "response.failed")).toHaveLength(1);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("PATCH-disable-all returns combo_unavailable without any fallback hit", async () => {
    let aHits = 0;
    let bHits = 0;
    let cHits = 0;
    const a = serve(() => { aHits += 1; return chatSuccess("a"); });
    const b = serve(() => { bHits += 1; return chatSuccess("b"); });
    const c = serve(() => { cHits += 1; return chatSuccess("default"); });
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "c",
      providers: {
        a: provider("openai-chat", baseUrl(a), "key-a"),
        b: provider("openai-chat", baseUrl(b), "key-b"),
        c: provider("openai-chat", baseUrl(c), "key-c"),
      },
    };
    saveConfig(config);
    expect((await management(config, "PUT", "/api/combos", {
      id: "free",
      combo: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
    }))?.status).toBe(200);
    expect((await management(config, "PATCH", "/api/providers?name=a", { disabled: true }))?.status).toBe(200);
    expect((await management(config, "PATCH", "/api/providers?name=b", { disabled: true }))?.status).toBe(200);
    const reloaded = readConfigDiagnostics().config;
    const response = await post(reloaded);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { type: "server_error", code: "combo_unavailable" },
    });
    expect([aHits, bHits, cHits]).toEqual([0, 0, 0]);
  });

  test("existence gate preserves physical combo provider and unknown routeModel 404", async () => {
    let physicalHits = 0;
    let memberHits = 0;
    let defaultHits = 0;
    let physicalModel = "";
    const physical = serve(async request => {
      physicalHits += 1;
      physicalModel = (await request.json() as { model?: string }).model ?? "";
      return chatSuccess("physical combo", "model");
    });
    const physicalConfig: OcxConfig = {
      port: 0,
      defaultProvider: "combo",
      providers: { combo: provider("openai-chat", baseUrl(physical), "key-combo") },
    };
    const physicalResponse = await post(physicalConfig, { model: "combo/model" });
    expect(physicalResponse.status).toBe(200);
    expect(physicalHits).toBe(1);
    expect(physicalModel).toBe("model");

    const member = serve(() => { memberHits += 1; return chatSuccess("member"); });
    const fallback = serve(() => { defaultHits += 1; return chatSuccess("default"); });
    const unknownConfig: OcxConfig = {
      port: 0,
      defaultProvider: "fallback",
      providers: {
        member: provider("openai-chat", baseUrl(member), "key-member"),
        fallback: provider("openai-chat", baseUrl(fallback), "key-fallback"),
      },
      combos: { free: { targets: [{ provider: "member", model: "m1" }] } },
    };
    const unknown = await post(unknownConfig, { model: "combo/missing" });
    expect(unknown.status).toBe(404);
    expect([memberHits, defaultHits]).toEqual([0, 0]);
  });

  test("failed passthrough child callbacks stay buffered and only B finalizes", async () => {
    const terminalFrame = (status: "failed" | "completed") => [
      `event: response.${status}`,
      `data: ${JSON.stringify({ type: `response.${status}`, response: { id: `resp_${status}`, status, output: [] } })}`,
      "",
      "",
    ].join("\n");
    const a = serve(() => new Response(terminalFrame("failed"), {
      status: 503,
      headers: { "content-type": "text/event-stream" },
    }));
    const b = serve(() => new Response(terminalFrame("completed"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });
    const finalized = deferred();
    const statuses: string[] = [];
    let cancels = 0;
    const response = await post(config, { stream: true }, {
      onNativePassthroughTerminal: status => {
        statuses.push(status);
        finalized.resolve();
      },
      onNativePassthroughCancel: () => { cancels += 1; },
    });
    expect(response.status).toBe(200);
    await response.text();
    await within(finalized.promise);
    expect(statuses).toEqual(["completed"]);
    expect(cancels).toBe(0);
  });

  test("connect cancellation wins with 499, no backup, warning, or cooldown", async () => {
    let bHits = 0;
    const aStarted = deferred();
    const a = serve(() => {
      aStarted.resolve();
      return new Promise<Response>(() => {});
    });
    const b = serve(() => { bHits += 1; return chatSuccess("must not run"); });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const abort = new AbortController();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const pending = postLogged(config, {}, { abortSignal: abort.signal });
      await aStarted.promise;
      abort.abort(new DOMException("client closed", "AbortError"));
      const response = await pending;
      expect(response.status).toBe(499);
      expect(await response.json()).toMatchObject({ error: { code: "client_cancelled" } });
      await expectCancelledAttemptReceipt(config, { provider: "a", model: "m1", adapter: "openai-chat" });
      expect(bHits).toBe(0);
      expect(warnings.some(row => String(row[0]).includes("[combo]"))).toBe(false);
      expect(isComboTargetInCooldown("free", { provider: "a", model: "m1" })).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("failure-body cancellation wins before cooldown or backup", async () => {
    const bodyRead = deferred();
    const bodyCancelled = deferred();
    let cancelled = 0;
    let bHits = 0;
    customFetchResponse = async request => {
      const body = JSON.parse(String(request.body)) as { model?: string };
      if (body.model === "m2") {
        bHits += 1;
        return chatSuccess("must not run");
      }
      let pulls = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(new TextEncoder().encode("partial"));
          else bodyRead.resolve();
        },
        cancel() {
          cancelled += 1;
          bodyCancelled.resolve();
        },
      }), { status: 429, headers: { "content-type": "application/json" } });
    };
    const config = comboConfig({
      a: provider("test-response", "https://test.invalid/v1", "key-a"),
      b: provider("test-response", "https://test.invalid/v1", "key-b"),
    });
    const abort = new AbortController();
    const pending = postLogged(config, {}, { abortSignal: abort.signal });
    await bodyRead.promise;
    abort.abort(new DOMException("client closed", "AbortError"));
    const response = await pending;
    expect(response.status).toBe(499);
    await response.text();
    await expectCancelledAttemptReceipt(config, { provider: "a", model: "m1", adapter: "test-response" });
    expect(bHits).toBe(0);
    await within(bodyCancelled.promise);
    expect(cancelled).toBe(1);
    expect(isComboTargetInCooldown("free", { provider: "a", model: "m1" })).toBe(false);
  });

  test("200 resolved after abort returns 499 with zero success accounting or callback publication", async () => {
    const started = deferred();
    let waitForAbort = true;
    const models: string[] = [];
    customFetchResponse = async (request, context) => {
      const model = (JSON.parse(String(request.body)) as { model?: string }).model ?? "";
      models.push(model);
      if (waitForAbort) {
        started.resolve();
        await new Promise<void>(resolve => {
          if (context?.abortSignal?.aborted) resolve();
          else context?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return chatSuccess(`ok ${model}`, model);
    };
    const config = comboConfig({
      a: provider("test-response", "https://test.invalid/v1", "key-a"),
      b: provider("test-response", "https://test.invalid/v1", "key-b"),
    }, undefined, { strategy: "round-robin", stickyLimit: 2 });
    const abort = new AbortController();
    let authPublications = 0;
    const pending = postLogged(config, {}, {
      abortSignal: abort.signal,
      onCodexAuthContextResolved: () => { authPublications += 1; },
    });
    await started.promise;
    abort.abort();
    const cancelledResponse = await pending;
    expect(cancelledResponse.status).toBe(499);
    await cancelledResponse.text();
    await expectCancelledAttemptReceipt(config, { provider: "a", model: "m1", adapter: "test-response" });
    expect(authPublications).toBe(0);

    waitForAbort = false;
    for (let i = 0; i < 3; i++) expect((await post(config)).status).toBe(200);
    expect(models).toEqual(["m1", "m1", "m1", "m2"]);
  });

  test("direct child status 499 is retained exactly once without backup", async () => {
    let bHits = 0;
    customFetchResponse = async request => {
      const model = (JSON.parse(String(request.body)) as { model?: string }).model;
      if (model === "m2") {
        bHits += 1;
        return chatSuccess("must not run", "m2");
      }
      return Response.json({ error: { code: "client_cancelled" } }, { status: 499 });
    };
    const config = comboConfig({
      a: provider("test-response", "https://test.invalid/v1", "key-a"),
      b: provider("test-response", "https://test.invalid/v1", "key-b"),
    });
    const response = await postLogged(config);
    expect(response.status).toBe(499);
    await response.text();
    expect(bHits).toBe(0);
    await expectCancelledAttemptReceipt(config, { provider: "a", model: "m1", adapter: "test-response" });
  });

  test("oversized ordinary failure is canceled once, leaks no prefix, and advances", async () => {
    const hostile = `hostile-prefix-${"x".repeat(70_000)}`;
    let reads = 0;
    let cancels = 0;
    customFetchResponse = async request => {
      const model = (JSON.parse(String(request.body)) as { model?: string }).model;
      if (model === "m2") return chatSuccess("safe backup", "m2");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          reads += 1;
          controller.enqueue(new TextEncoder().encode(hostile));
        },
        cancel() { cancels += 1; },
      }), { status: 429, headers: { "content-type": "application/json" } });
    };
    const config = comboConfig({
      a: provider("test-response", "https://test.invalid/v1", "key-a"),
      b: provider("test-response", "https://test.invalid/v1", "key-b"),
    });
    const response = await postLogged(config);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("safe backup");
    expect(text).not.toContain("hostile-prefix");
    expect(reads).toBe(1);
    expect(cancels).toBe(1);
    const attempt = (await latestAttemptReceipts(config)).usage.attempts?.[0];
    expect(attempt).toMatchObject({ provider: "a", status: 429, usageStatus: "unreported" });
    expect(attempt).not.toHaveProperty("usage");
  });

  test("stalled passthrough JSON is canceled at five seconds and advances once", async () => {
    let reads = 0;
    let cancels = 0;
    let bHits = 0;
    const cancelled = deferred();
    customTransientResponse = async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          reads += 1;
          controller.enqueue(new TextEncoder().encode("hostile-stalled-prefix"));
        },
        cancel() {
          cancels += 1;
          cancelled.resolve();
        },
      }), { status: 429, headers: { "content-type": "application/json" } });
    const b = serve(() => {
      bHits += 1;
      return chatSuccess("bounded backup", "m2");
    });
    const config = comboConfig({
      a: provider("openai-responses", "https://stalled.test/v1", "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const started = performance.now();
    const response = await postLogged(config);
    const elapsed = performance.now() - started;
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("bounded backup");
    expect(text).not.toContain("hostile-stalled-prefix");
    await within(cancelled.promise);
    expect([reads, cancels, bHits]).toEqual([1, 1, 1]);
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    const attempt = (await latestAttemptReceipts(config)).usage.attempts?.[0];
    expect(attempt).toMatchObject({ provider: "a", status: 429, usageStatus: "unreported" });
    expect(attempt).not.toHaveProperty("usage");
  }, 10_000);
});
