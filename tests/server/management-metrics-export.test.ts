import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { configDiagnosticsFromRaw, validateConfigCandidate } from "../../src/config/diagnostics";
import { metricsExportEnabled } from "../../src/config/feature-flags";
import { getDefaultConfig } from "../../src/config/proxy-env";
import { handleManagementAPI } from "../../src/server/management-api";
import { requireManagementAuth, type ManagementAuthState } from "../../src/server/management-auth";
import { addFinalRequestLog, type RequestLogContext } from "../../src/server/request-log";
import { createRequestMetricsOwner } from "../../src/server/request-metrics";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import type { AttemptRecoveryKind } from "../../src/usage/log";
import { ManagementRequest } from "../helpers/management-auth";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const ADMIN_TOKEN = "ocx_admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DATA_TOKEN = "ocx_data_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const METRICS_UPSTREAM = "metrics-upstream.example";

function authState(): ManagementAuthState {
  return {
    available: true,
    token: ADMIN_TOKEN,
    source: "environment",
    sessions: new Map(),
    pairingGrants: new Map(),
  };
}

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    ...getDefaultConfig(),
    apiKeys: [{ id: "data-key", key: DATA_TOKEN, name: "data key", createdAt: "2026-09-19T00:00:00.000Z" }],
    ...overrides,
  };
}

async function metricsRoute(snapshot?: () => string): Promise<Response> {
  const req = new ManagementRequest("http://localhost/api/metrics");
  const url = new URL(req.url);
  const response = await handleManagementAPI(req, url, config(), snapshot ? {
    requestMetrics: { snapshot },
  } : {});
  if (!response) throw new Error("metrics route was not handled");
  return response;
}

async function authenticatedMetricsRoute(req: Request, snapshot: () => string): Promise<Response> {
  const denied = requireManagementAuth(req, authState(), config());
  if (denied) return denied;
  const response = await handleManagementAPI(req, new URL(req.url), config(), {
    requestMetrics: { snapshot },
  });
  if (!response) throw new Error("metrics route was not handled");
  return response;
}

function sampleValue(text: string, prefix: string): number {
  const line = text.split("\n").find(candidate => candidate.startsWith(prefix));
  if (!line) throw new Error(`missing metric sample: ${prefix}`);
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

function attempt(sendCount: number, recoveryKinds: AttemptRecoveryKind[]) {
  return {
    ordinal: 1,
    provider: "private-provider-canary",
    model: "private-model-canary",
    adapter: "openai-responses",
    status: 200,
    durationMs: 10,
    sendCount,
    recoveryKinds,
    usageStatus: "unreported" as const,
  };
}

function runtimeConfig(
  adapter: "openai-chat" | "openai-responses",
  metricsEnabled = true,
): OcxConfig {
  return {
    port: 0,
    codexAutoStart: false,
    websockets: true,
    metricsExport: { enabled: metricsEnabled },
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter,
        baseUrl: `https://${METRICS_UPSTREAM}/v1`,
        apiKey: "sk-metrics-fixture",
        transientRetryOn5xx: { enabled: true, attempts: 2 },
      },
    },
  } as OcxConfig;
}

function completedResponseJson(text = "ok"): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_metrics",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  });
}

function responseSse(options: { terminal?: "completed" | "failed" | "incomplete"; output?: string } = {}): string {
  const id = "resp_metrics_sse";
  const events = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } })}`,
  ];
  if (options.output !== undefined) {
    events.push(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: options.output })}`);
  }
  if (options.terminal) {
    events.push(`event: response.${options.terminal}\ndata: ${JSON.stringify({
      type: `response.${options.terminal}`,
      response: { id, status: options.terminal, output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
    })}`);
  }
  return `${events.join("\n\n")}\n\n${options.terminal ? "data: [DONE]\n\n" : ""}`;
}

function installUpstream(
  originalFetch: typeof fetch,
  responder: (send: number, request: Request) => Response | Promise<Response>,
): () => number {
  let sends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === METRICS_UPSTREAM) {
      sends += 1;
      return responder(sends, request);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => sends;
}

async function scrapeServer(server: ReturnType<typeof startServer>): Promise<string> {
  const response = await fetch(new URL("/api/metrics", server.url), {
    headers: { "x-opencodex-api-key": ADMIN_TOKEN },
  });
  expect(response.status).toBe(200);
  return response.text();
}

async function sendResponsesRequest(server: ReturnType<typeof startServer>, stream = false): Promise<Response> {
  return fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/metrics-model", input: "hello", stream }),
  });
}

async function sendChatRequest(server: ReturnType<typeof startServer>): Promise<Response> {
  return fetch(new URL("/v1/chat/completions", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/metrics-model", messages: [{ role: "user", content: "hello" }] }),
  });
}

async function runWebSocketTurn(server: ReturnType<typeof startServer>): Promise<void> {
  const url = new URL("/v1/responses", server.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("metrics websocket timeout")), 5_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "response.create",
        model: "fixture/metrics-model",
        input: "hello",
      }));
    }, { once: true });
    socket.addEventListener("message", event => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text.includes("response.completed")) return;
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("metrics websocket failed"));
    }, { once: true });
  });
}

describe("request metrics aggregation", () => {
  test("one finalized logical request counts once while attempts preserve physical sends and distinct recovery kinds", () => {
    const metrics = createRequestMetricsOwner(123);
    const logCtx: RequestLogContext = {
      model: "private-model-canary",
      provider: "private-provider-canary",
      inboundProtocol: "responses",
      requestMetricsRecorder: metrics,
      attempts: [
        attempt(2, ["connection-reset", "connection-reset"]),
        { ...attempt(1, ["key-429", "rate-limit-429"]), ordinal: 2 },
      ],
    };

    addFinalRequestLog("private-request-canary", Date.now() - 1_000, logCtx, 200, {
      terminalStatus: "completed",
      closeReason: "terminal",
    }, () => {});

    const output = metrics.snapshot();
    expect(sampleValue(output, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_physical_sends_total{protocol="responses"}')).toBe(3);
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="connection"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="rate_limit"}')).toBe(2);
  });

  test("a failed terminal carried over HTTP 200 is never counted as completed", () => {
    const metrics = createRequestMetricsOwner(123);
    metrics.recordFinalRequest({
      protocol: "responses",
      status: 200,
      durationMs: 250,
      firstOutputMs: 0,
      terminalStatus: "failed",
      closeReason: "terminal",
    });
    const output = metrics.snapshot();
    expect(sampleValue(output, 'opencodex_logical_requests_total{protocol="responses",result="failed"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(0);
    expect(sampleValue(output, 'opencodex_ttft_seconds_count{protocol="responses",result="failed"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_ttft_missing_total{protocol="responses",result="failed"}')).toBe(0);
  });

  test("incomplete, aborted, and missing TTFT denominators remain distinct", () => {
    const metrics = createRequestMetricsOwner(123);
    metrics.recordFinalRequest({ protocol: "chat", status: 502, durationMs: 100, terminalStatus: "incomplete" });
    metrics.recordFinalRequest({ protocol: "chat", status: 499, durationMs: 200, closeReason: "client_cancel" });
    const output = metrics.snapshot();
    expect(sampleValue(output, 'opencodex_logical_requests_total{protocol="chat",result="incomplete"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_logical_requests_total{protocol="chat",result="aborted"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_request_duration_seconds_count{protocol="chat",result="incomplete"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_request_duration_seconds_count{protocol="chat",result="aborted"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_ttft_missing_total{protocol="chat",result="incomplete"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_ttft_missing_total{protocol="chat",result="aborted"}')).toBe(1);
  });

  test("series and labels stay bounded and privacy canaries never reach exposition", () => {
    const metrics = createRequestMetricsOwner(123);
    const canaries = [
      "private-request-canary",
      "private-logical-canary",
      "private-key-canary",
      "private-account-canary",
      "private-model-canary",
      "private-provider-canary",
      "private-error-canary",
      "private-prompt-canary",
      "private-tool-body-canary",
    ];
    const logCtx = {
      model: canaries[4],
      provider: canaries[5],
      logicalRequestId: canaries[1],
      apiKeyId: canaries[2],
      accountLogLabel: canaries[3],
      upstreamError: canaries[6],
      inboundProtocol: "messages",
      requestMetricsRecorder: metrics,
      prompt: canaries[7],
      toolBody: canaries[8],
    } as unknown as RequestLogContext;
    addFinalRequestLog(canaries[0]!, Date.now() - 1, logCtx, 400, undefined, () => {});
    for (let index = 0; index < 64; index += 1) {
      addFinalRequestLog(`request-${index}`, Date.now() - 1, {
        model: `model-${index}`,
        provider: `provider-${index}`,
        apiKeyId: `key-${index}`,
        accountLogLabel: `account-${index}`,
        requestMetricsRecorder: metrics,
      }, 400, undefined, () => {});
    }
    const output = metrics.snapshot();
    for (const canary of canaries) expect(output).not.toContain(canary);
    const samples = output.split("\n").filter(line => line && !line.startsWith("#"));
    expect(samples).toHaveLength(453);
  });

  test("text exposition has deterministic HELP/TYPE groups and cumulative +Inf buckets", () => {
    const metrics = createRequestMetricsOwner(123);
    metrics.recordFinalRequest({ protocol: "responses", status: 200, durationMs: 125, firstOutputMs: 75 });
    const output = metrics.snapshot();
    expect(output.endsWith("\n")).toBe(true);
    expect(output.indexOf("# HELP opencodex_request_duration_seconds"))
      .toBeLessThan(output.indexOf("opencodex_request_duration_seconds_bucket"));
    expect(output.indexOf("# TYPE opencodex_request_duration_seconds histogram"))
      .toBeLessThan(output.indexOf("opencodex_request_duration_seconds_bucket"));
    const helpLines = output.split("\n").filter(line => line.startsWith("# HELP "));
    const typeLines = output.split("\n").filter(line => line.startsWith("# TYPE "));
    expect(helpLines).toHaveLength(7);
    expect(typeLines).toHaveLength(7);
    expect(new Set(helpLines.map(line => line.split(" ")[2])).size).toBe(7);
    expect(new Set(typeLines.map(line => line.split(" ")[2])).size).toBe(7);
    expect(sampleValue(output, 'opencodex_request_duration_seconds_bucket{protocol="responses",result="completed",le="+Inf"}'))
      .toBe(sampleValue(output, 'opencodex_request_duration_seconds_count{protocol="responses",result="completed"}'));
    expect(metrics.snapshot()).toBe(output);
  });

  test("a fresh owner documents process restart by resetting counters and changing start time", () => {
    const first = createRequestMetricsOwner(100);
    first.recordFinalRequest({ status: 200, durationMs: 1 });
    const second = createRequestMetricsOwner(200);
    expect(sampleValue(first.snapshot(), "opencodex_metrics_process_start_time_seconds")).toBe(100);
    expect(sampleValue(second.snapshot(), "opencodex_metrics_process_start_time_seconds")).toBe(200);
    expect(sampleValue(second.snapshot(), 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(0);
  });
});

describe("metrics management boundary", () => {
  test("admin authentication admits the route while absent and data-plane credentials do not", async () => {
    const admin = new ManagementRequest("http://localhost/api/metrics", {
      headers: { "x-opencodex-api-key": ADMIN_TOKEN },
    });
    const data = new ManagementRequest("http://localhost/api/metrics", {
      headers: { "x-opencodex-api-key": DATA_TOKEN },
    });
    const absent = new ManagementRequest("http://localhost/api/metrics");
    const metrics = createRequestMetricsOwner(123);
    const snapshot = () => metrics.snapshot();
    const response = await authenticatedMetricsRoute(admin, snapshot);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain;version=0.0.4");
    expect(await response.text()).not.toContain(DATA_TOKEN);
    expect((await authenticatedMetricsRoute(data, snapshot)).status).toBe(401);
    expect((await authenticatedMetricsRoute(absent, snapshot)).status).toBe(401);
  });

  test("disabled mode wires no snapshot route and returns the locked 404", async () => {
    expect(metricsExportEnabled(config())).toBe(false);
    const response = await metricsRoute();
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("the metrics modules contain no timer, listener, network, or module-global owner", () => {
    const source = [
      readFileSync(repoPath("src/server/request-metrics.ts"), "utf8"),
      readFileSync(repoPath("src/server/management/metrics-routes.ts"), "utf8"),
    ].join("\n");
    for (const forbidden of ["setInterval(", "setTimeout(", "Bun.serve(", ".listen(", "fetch("]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/(?:let|const)\s+activeRequestMetrics/);
    const composition = readFileSync(repoPath("src/server/index/serve-options.ts"), "utf8");
    expect(composition).toContain(
      "metricsExportEnabled(config) ? createRequestMetricsOwner() : undefined",
    );
    expect(composition).toContain("requestMetrics ? { requestMetricsRecorder: requestMetrics } : {}");
    expect(composition).toContain("createWebsocketHandler(ctx, requestMetrics)");
    expect(readFileSync(repoPath("src/server/index/websocket-handler.ts"), "utf8"))
      .toContain("requestMetricsRecorder ? { requestMetricsRecorder } : {}");
  });
});

describe("metrics through live HTTP and WebSocket server flows", () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const previousOpenCodexHome = process.env.OPENCODEX_HOME;
  const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  let openCodexHome = "";
  let isolatedCodexHome: IsolatedCodexHome | null = null;

  beforeEach(() => {
    openCodexHome = mkdtempSync(join(tmpdir(), "ocx-metrics-export-"));
    process.env.OPENCODEX_HOME = openCodexHome;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
    isolatedCodexHome = installIsolatedCodexHome("ocx-metrics-export-codex-");
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpenCodexHome;
    if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (openCodexHome) removeTreeWithRetry(openCodexHome);
    openCodexHome = "";
  });

  test("HTTP retry flow records one logical request and both physical sends", async () => {
    const sends = installUpstream(originalFetch, send => send === 1
      ? Response.json({ error: { message: "retry" } }, { status: 500 })
      : Response.json({
        id: "chat_metrics",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }));
    saveConfig(runtimeConfig("openai-chat"));
    const server = startServer(0);
    try {
      const response = await sendChatRequest(server);
      expect(response.status).toBe(200);
      await response.text();
      const metrics = await scrapeServer(server);
      expect(sends()).toBe(2);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="chat",result="completed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_physical_sends_total{protocol="chat"}')).toBe(2);
      expect(sampleValue(metrics, 'opencodex_recoveries_total{protocol="chat",recovery="transient"}')).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("WebSocket response.create finalizes into the shared metrics owner", async () => {
    const sends = installUpstream(originalFetch, () => new Response(responseSse({
      terminal: "completed",
      output: "socket output",
    }), { headers: { "content-type": "text/event-stream" } }));
    saveConfig(runtimeConfig("openai-responses"));
    const server = startServer(0);
    try {
      await runWebSocketTurn(server);
      const metrics = await scrapeServer(server);
      expect(sends()).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_physical_sends_total{protocol="responses"}')).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("buffered HTTP 200 response.failed is classified as failed", async () => {
    installUpstream(originalFetch, () => Response.json({
      type: "response.failed",
      response: {
        id: "resp_failed_metrics",
        status: "failed",
        error: { type: "server_error", code: "upstream_error", message: "bounded failure" },
        output: [],
      },
    }));
    saveConfig(runtimeConfig("openai-responses"));
    const server = startServer(0);
    try {
      const response = await sendResponsesRequest(server);
      expect(response.status).toBe(200);
      await response.text();
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="failed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("buffered HTTP 200 response.incomplete is classified as incomplete", async () => {
    installUpstream(originalFetch, () => Response.json({
      type: "response.incomplete",
      response: {
        id: "resp_incomplete_metrics",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
    }));
    saveConfig(runtimeConfig("openai-responses"));
    const server = startServer(0);
    try {
      const response = await sendResponsesRequest(server);
      expect(response.status).toBe(200);
      await response.text();
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="incomplete"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("buffered read errors stay failed even after terminal-looking partial bytes", async () => {
    const bytes = new TextEncoder().encode(completedResponseJson("partial"));
    installUpstream(originalFetch, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.error(new Error("fixture read failure"));
      },
    }), { headers: { "content-type": "application/json" } }));
    saveConfig(runtimeConfig("openai-responses"));
    const server = startServer(0);
    try {
      const response = await sendResponsesRequest(server);
      await response.text().catch(() => "");
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="failed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("terminal-free SSE EOF and downstream cancellation remain incomplete and aborted", async () => {
    const encoder = new TextEncoder();
    installUpstream(originalFetch, send => {
      if (send === 1) {
        return new Response(responseSse(), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(responseSse()));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    saveConfig(runtimeConfig("openai-responses"));
    const server = startServer(0);
    try {
      const incomplete = await sendResponsesRequest(server, true);
      await incomplete.text();
      const cancelled = await sendResponsesRequest(server, true);
      await cancelled.body?.cancel("metrics cancellation test");
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="incomplete"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="aborted"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_ttft_missing_total{protocol="responses",result="incomplete"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_ttft_missing_total{protocol="responses",result="aborted"}')).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("real buffered and streaming flows distinguish missing TTFT from zero", async () => {
    let send = 0;
    installUpstream(originalFetch, () => {
      send += 1;
      return send === 1
        ? new Response(completedResponseJson(), { headers: { "content-type": "application/json" } })
        : new Response(responseSse({ terminal: "completed", output: "instant" }), {
          headers: { "content-type": "text/event-stream" },
        });
    });
    saveConfig(runtimeConfig("openai-responses"));
    const server = startServer(0);
    const realNow = Date.now;
    try {
      const buffered = await sendResponsesRequest(server);
      await buffered.text();
      Date.now = () => 1_900_000_000_000;
      const streamed = await sendResponsesRequest(server, true);
      await streamed.text();
      Date.now = realNow;
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_ttft_missing_total{protocol="responses",result="completed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_ttft_seconds_count{protocol="responses",result="completed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_ttft_seconds_bucket{protocol="responses",result="completed",le="0.05"}')).toBe(1);
    } finally {
      Date.now = realNow;
      await server.stop(true);
    }
  });

  test("disabled live server exposes no metrics owner and returns authenticated 404", async () => {
    saveConfig(runtimeConfig("openai-responses", false));
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/metrics", server.url), {
        headers: { "x-opencodex-api-key": ADMIN_TOKEN },
      });
      expect(response.status).toBe(404);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("not_found");
    } finally {
      await server.stop(true);
    }
  });
});

describe("metricsExport config admission", () => {
  test("absence and false stay disabled while true enables the process-lifetime owner", () => {
    expect(metricsExportEnabled(config())).toBe(false);
    expect(metricsExportEnabled(config({ metricsExport: { enabled: false } }))).toBe(false);
    expect(metricsExportEnabled(config({ metricsExport: { enabled: true } }))).toBe(true);
  });

  test("live writes reject malformed and unknown fields before the degrading schema", () => {
    const base = getDefaultConfig();
    expect(validateConfigCandidate({ ...base, metricsExport: { enabled: "yes" } })).toMatchObject({
      ok: false,
      error: "schema_invalid: metricsExport.enabled: must be a boolean",
    });
    expect(validateConfigCandidate({ ...base, metricsExport: { enabled: true, label: "private" } })).toMatchObject({
      ok: false,
      error: "schema_invalid: metricsExport: contains an unsupported field",
    });
  });

  test("malformed persisted values degrade only metrics export to disabled", () => {
    const base = getDefaultConfig();
    for (const metricsExport of [{ enabled: "yes" }, { enabled: true, label: "private" }]) {
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify({ ...base, metricsExport }));
      expect(diagnostics.config.metricsExport).toBeUndefined();
      expect(diagnostics.config.providers).toEqual(base.providers);
    }
  });
});
