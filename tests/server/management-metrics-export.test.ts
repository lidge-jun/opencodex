import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { configDiagnosticsFromRaw, validateConfigCandidate } from "../../src/config/diagnostics";
import { metricsExportEnabled } from "../../src/config/feature-flags";
import { getDefaultConfig } from "../../src/config/proxy-env";
import * as audioUpstream from "../../src/server/audio-upstream";
import { MAX_ACTIVE_SESSION_LANES, tryAdmitTurn } from "../../src/server/lifecycle";
import { handleManagementAPI } from "../../src/server/management-api";
import { requireManagementAuth, type ManagementAuthState } from "../../src/server/management-auth";
import {
  addFinalRequestLog,
  observeRequestLogsForTests,
  type RequestLogContext,
  type RequestLogEntry,
} from "../../src/server/request-log";
import {
  createRequestMetricsOwner,
  REQUEST_DURATION_BUCKETS_SECONDS,
  REQUEST_METRICS_PROTOCOLS,
  REQUEST_METRICS_RECOVERY_CLASSES,
  REQUEST_METRICS_FAILURE_CAUSES,
  REQUEST_METRICS_RESULTS,
  REQUEST_TTFT_BUCKETS_SECONDS,
} from "../../src/server/request-metrics";
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
const OBSERVATION_TIMEOUT = Symbol("observation-timeout");

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

function awaitBounded<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), 5_000);
    void promise.then(value => {
      clearTimeout(timeout);
      resolve(value);
    }, error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function awaitObservation<T>(promise: Promise<T>): Promise<T | typeof OBSERVATION_TIMEOUT> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(OBSERVATION_TIMEOUT), 5_000);
    void promise.then(value => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

async function describeUpgradeRefusal(wsUrl: URL): Promise<string> {
  const httpUrl = new URL(wsUrl);
  httpUrl.protocol = "http:";
  try {
    const response = await fetch(httpUrl, {
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
      },
      signal: AbortSignal.timeout(1_000),
    });
    return `HTTP ${response.status}: ${(await response.text()).slice(0, 512)}`;
  } catch (error) {
    return `HTTP refusal unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function nextFinalRequestLog(
  predicate: (entry: RequestLogEntry) => boolean,
): { promise: Promise<RequestLogEntry>; dispose: () => void } {
  let unsubscribe = () => {};
  const dispose = (): void => { unsubscribe(); };
  const promise = new Promise<RequestLogEntry>(resolve => {
    unsubscribe = observeRequestLogsForTests(entry => {
      if (!predicate(entry)) return;
      dispose();
      resolve(entry);
    });
  });
  return { promise, dispose };
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

function liveMetricsConfig(): OcxConfig {
  const config = runtimeConfig("openai-responses");
  config.apiKeys = [{ id: "metrics-audio", name: "metrics audio", key: DATA_TOKEN, createdAt: "2026-09-19T00:00:00Z" }];
  config.providers["openai-apikey"] = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-metrics-fixture",
    authMode: "key",
  };
  return config;
}

function upgradeRequestHeaders(): Record<string, string> {
  return {
    connection: "upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
  };
}

function startLiveMetricsUpstream(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket"
        && server.upgrade(req, { data: {} })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: { message() {} },
  });
}

function stallAudioAcquisition(started: { resolve(): void }) {
  return spyOn(audioUpstream, "resolveAudioUpstream").mockImplementation(async (_headers, _config, _log, options) => {
    started.resolve();
    await new Promise<void>(resolve => {
      if (options.signal?.aborted) resolve();
      else options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return new Response("acquisition interrupted", { status: 503 });
  });
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

async function sendResponsesRequest(
  server: ReturnType<typeof startServer>,
  stream = false,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/metrics-model", input: "hello", stream }),
    signal,
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

  test("the four refusals an operator responds to differently get four different classes", () => {
    const metrics = createRequestMetricsOwner(123);
    addFinalRequestLog("refusal-classes", Date.now() - 1_000, {
      model: "m", provider: "p", inboundProtocol: "responses", requestMetricsRecorder: metrics,
      attempts: [
        attempt(1, ["opaque-blob-rejection"]),
        { ...attempt(1, ["rate-limit-429"]), ordinal: 2 },
        { ...attempt(1, ["reasoning-effort-downgrade"]), ordinal: 3 },
        { ...attempt(1, ["image-413"]), ordinal: 4 },
        { ...attempt(1, ["anthropic-fast-downgrade"]), ordinal: 5 },
      ],
    } as RequestLogContext, 400, undefined, () => {});

    const output = metrics.snapshot();
    // A rejected opaque blob is a ciphertext refusal, not a payload problem: the payload was fine
    // and the stale encrypted state was not. Counting it as payload alongside an oversize image
    // told an operator to look at the wrong thing.
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="ciphertext"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="payload"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="rate_limit"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="effort_downgrade"}')).toBe(1);
    // Also a rejected parameter, but the remedy is an Anthropic fast-mode entitlement, not an
    // effort change, so it must not inflate effort_downgrade.
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="fast_downgrade"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="quota"}')).toBe(0);
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="policy"}')).toBe(0);
    expect(sampleValue(output, 'opencodex_recoveries_total{protocol="responses",recovery="other"}')).toBe(0);
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

  test("terminal precedence keeps failed and incomplete 101 facts out of completed", () => {
    const metrics = createRequestMetricsOwner(123);
    metrics.recordFinalRequest({ status: 101, durationMs: 1, terminalStatus: "failed" });
    metrics.recordFinalRequest({ status: 101, durationMs: 1, terminalStatus: "incomplete" });
    const output = metrics.snapshot();
    expect(sampleValue(output, 'opencodex_logical_requests_total{protocol="unknown",result="failed"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_logical_requests_total{protocol="unknown",result="incomplete"}')).toBe(1);
    expect(sampleValue(output, 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(0);
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
    const beforeFanOut = metrics.snapshot().split("\n").filter(line => line && !line.startsWith("#")).length;
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
    // The property, stated directly: 64 requests carrying 64 distinct models, providers, keys and
    // account labels add no series at all. A dynamic label map would show up here as growth.
    expect(samples).toHaveLength(beforeFanOut);
    // And the absolute size, derived from the closed vocabularies rather than restated as a
    // literal. The literal was correct and went stale the moment a bounded label value was added,
    // which is the failure mode this repository keeps hitting in merges.
    const perHistogram = (bounds: readonly number[]): number => bounds.length + 1 + 2;
    const cells = REQUEST_METRICS_PROTOCOLS.length * REQUEST_METRICS_RESULTS.length;
    expect(samples).toHaveLength(
      cells
      + REQUEST_METRICS_PROTOCOLS.length
      + REQUEST_METRICS_PROTOCOLS.length * REQUEST_METRICS_RECOVERY_CLASSES.length
      + REQUEST_METRICS_PROTOCOLS.length * REQUEST_METRICS_FAILURE_CAUSES.length
      + cells * perHistogram(REQUEST_DURATION_BUCKETS_SECONDS)
      + cells * perHistogram(REQUEST_TTFT_BUCKETS_SECONDS)
      + cells
      + 1,
    );
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
    // Every metric name the exporter emits, read from the exposition rather than counted by
    // hand: the literal was correct until a metric was added, which is the same staleness the
    // sample arithmetic above avoids.
    const metricNames = new Set(helpLines.map(line => line.split(" ")[2]));
    expect(helpLines).toHaveLength(metricNames.size);
    expect(typeLines).toHaveLength(metricNames.size);
    expect(new Set(typeLines.map(line => line.split(" ")[2]))).toEqual(metricNames);
    // Each name appears exactly once in each group, which is what deterministic grouping means.
    expect(helpLines.length).toBeGreaterThan(REQUEST_METRICS_PROTOCOLS.length);
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
  const liveServers = new Set<ReturnType<typeof startServer>>();

  const startMetricsServer = (
    deps?: Parameters<typeof startServer>[1],
  ): ReturnType<typeof startServer> => {
    const server = startServer(0, deps);
    liveServers.add(server);
    return server;
  };

  const startMetricsServerWithExpectedError = (
    expected: Error,
    observed: unknown[],
    unexpected: unknown[],
  ): ReturnType<typeof startServer> => {
    const nativeServe = Bun.serve.bind(Bun);
    const serveSpy = spyOn(Bun, "serve").mockImplementation(options => nativeServe({
      ...options,
      error(error) {
        if (error === expected) observed.push(error);
        else unexpected.push(error);
        return new Response("expected metrics fixture server error", { status: 500 });
      },
    } as Parameters<typeof Bun.serve>[0]));
    try {
      return startMetricsServer();
    } finally {
      // startServer is synchronous; restore before any request or awaited cleanup.
      serveSpy.mockRestore();
    }
  };

  const startMetricsServerWithLiveRequestControl = (
    control: "abort" | "upgrade-throw" | "upgrade-false",
    deps?: Parameters<typeof startServer>[1],
  ): ReturnType<typeof startServer> => {
    const nativeServe = Bun.serve.bind(Bun);
    const serveSpy = spyOn(Bun, "serve").mockImplementation(options => {
      const fetchHandler = options.fetch;
      if (typeof fetchHandler !== "function") return nativeServe(options);
      return nativeServe({
        ...options,
        fetch(req, requestServer) {
          if (new URL(req.url).pathname !== "/v1/realtime") {
            return Reflect.apply(fetchHandler, requestServer, [req, requestServer]);
          }
          let routedRequest = req;
          if (control === "abort") {
            const abort = new AbortController();
            abort.abort(new Error("metrics pre-upgrade cancellation"));
            routedRequest = new Request(req, { signal: abort.signal });
          }
          const routedServer = control === "abort" ? requestServer : new Proxy(requestServer, {
            get(target, property) {
              if (property === "upgrade") return () => {
                if (control === "upgrade-throw") throw new Error("metrics upgrade fixture failure");
                return false;
              };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return Reflect.apply(fetchHandler, routedServer, [routedRequest, routedServer]);
        },
      } as Parameters<typeof Bun.serve>[0]);
    });
    try {
      return startMetricsServer(deps);
    } finally {
      serveSpy.mockRestore();
    }
  };

  const stopMetricsServer = async (server: ReturnType<typeof startServer>): Promise<void> => {
    try {
      await server.stop(true);
    } finally {
      liveServers.delete(server);
    }
  };

  beforeEach(() => {
    openCodexHome = mkdtempSync(join(tmpdir(), "ocx-metrics-export-"));
    process.env.OPENCODEX_HOME = openCodexHome;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
    isolatedCodexHome = installIsolatedCodexHome("ocx-metrics-export-codex-");
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  afterEach(async () => {
    // The server owns the spend-ledger lease until every listener and active body settles.
    // Release it before changing/removing OPENCODEX_HOME so the next fixture acquires honestly.
    const stops = await Promise.allSettled([...liveServers].map(stopMetricsServer));
    try {
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
    } finally {
      const failure = stops.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
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
    const server = startMetricsServer();
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
      await stopMetricsServer(server);
    }
  });

  test("WebSocket response.create finalizes into the shared metrics owner", async () => {
    const sends = installUpstream(originalFetch, () => new Response(responseSse({
      terminal: "completed",
      output: "socket output",
    }), { headers: { "content-type": "text/event-stream" } }));
    saveConfig(runtimeConfig("openai-responses"));
    const server = startMetricsServer();
    try {
      await runWebSocketTurn(server);
      const metrics = await scrapeServer(server);
      expect(sends()).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_physical_sends_total{protocol="responses"}')).toBe(1);
    } finally {
      await stopMetricsServer(server);
    }
  });

  test("successful live sideband upgrade records HTTP 101 as completed", async () => {
    const upstream = startLiveMetricsUpstream();
    try {
      saveConfig(liveMetricsConfig());
      const upstreamUrl = new URL("/upstream", upstream.url);
      upstreamUrl.protocol = "ws:";
      let factoryCalls = 0;
      let server: ReturnType<typeof startServer> | undefined;
      try {
        server = startMetricsServer({
          liveSidebandWebSocketFactory: () => {
            factoryCalls += 1;
            return new WebSocket(upstreamUrl);
          },
        });
        const finalized = nextFinalRequestLog(entry => entry.status === 101);
        try {
          const url = new URL("/v1/realtime?model=fixture%2Fmetrics-model", server.url);
          url.protocol = "ws:";
          let socket: WebSocket | undefined;
          try {
            const activeSocket = socket = new WebSocket(url);
            await awaitBounded(new Promise<void>((resolve, reject) => {
              activeSocket.addEventListener("open", () => resolve(), { once: true });
              activeSocket.addEventListener("error", () => {
                void describeUpgradeRefusal(url).then(detail => reject(new Error(`live sideband upgrade failed; ${detail}`)));
              }, { once: true });
            }), "live sideband client did not open");
            const observedRow = await awaitObservation(finalized.promise);
            expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
            if (observedRow === OBSERVATION_TIMEOUT) throw new Error("101 upgrade finalization was not observed");
            expect(observedRow.status).toBe(101);
            expect(factoryCalls).toBe(1);
            const metrics = await scrapeServer(server);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(1);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="failed"}')).toBe(0);
          } finally {
            socket?.close();
          }
        } finally {
          finalized.dispose();
        }
      } finally {
        if (server) await stopMetricsServer(server);
      }
    } finally {
      await upstream.stop(true);
    }
  });

  test("pre-upgrade cancellation finalizes exactly one aborted live request", async () => {
    saveConfig(liveMetricsConfig());
    const server = startMetricsServerWithLiveRequestControl("abort", {
      liveSidebandWebSocketFactory: () => { throw new Error("cancelled request reached upstream dial"); },
    });
    const finalized = nextFinalRequestLog(entry => entry.status === 499);
    const rows: RequestLogEntry[] = [];
    const disposeRows = observeRequestLogsForTests(entry => { if (entry.model === "gpt-live") rows.push(entry); });
    try {
      const response = await fetch(new URL("/v1/realtime?model=fixture%2Fmetrics-model", server.url), {
        headers: upgradeRequestHeaders(),
      });
      expect(response.status).toBe(499);
      await response.text();
      const observedRow = await awaitObservation(finalized.promise);
      expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
      if (observedRow === OBSERVATION_TIMEOUT) throw new Error("499 upgrade cancellation was not finalized");
      expect(observedRow.status).toBe(499);
      expect(observedRow.closeReason).toBe("client_cancel");
      expect(rows.map(entry => entry.status)).toEqual([499]);
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="aborted"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="failed"}')).toBe(0);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="incomplete"}')).toBe(0);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(0);
    } finally {
      disposeRows();
      finalized.dispose();
      await stopMetricsServer(server);
    }
  });

  test("client cancellation during acquisition finalizes exactly one aborted live request", async () => {
    saveConfig(liveMetricsConfig());
    const acquisitionStarted = Promise.withResolvers<void>();
    const resolver = stallAudioAcquisition(acquisitionStarted);
    try {
      const server = startMetricsServer({
        liveSidebandWebSocketFactory: () => { throw new Error("cancelled acquisition reached upstream dial"); },
      });
      try {
        const finalized = nextFinalRequestLog(entry => entry.status === 499);
        const rows: RequestLogEntry[] = [];
        const disposeRows = observeRequestLogsForTests(entry => { if (entry.model === "gpt-live") rows.push(entry); });
        try {
          const clientAbort = new AbortController();
          try {
            const clientOutcome = fetch(new URL("/v1/realtime?model=fixture%2Fmetrics-model", server.url), {
              headers: { ...upgradeRequestHeaders(), "x-opencodex-api-key": DATA_TOKEN },
              signal: clientAbort.signal,
            }).catch(error => error);
            await awaitBounded(acquisitionStarted.promise, "audio acquisition did not start");
            clientAbort.abort(new Error("metrics acquisition client cancellation"));
            const observedRow = await awaitObservation(finalized.promise);
            expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
            if (observedRow === OBSERVATION_TIMEOUT) throw new Error("acquisition cancellation was not finalized");
            expect(observedRow.status).toBe(499);
            expect(observedRow.closeReason).toBe("client_cancel");
            expect(rows.map(entry => entry.status)).toEqual([499]);
            await awaitBounded(clientOutcome, "cancelled acquisition client did not settle");
            const metrics = await scrapeServer(server);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="aborted"}')).toBe(1);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="failed"}')).toBe(0);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="incomplete"}')).toBe(0);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(0);
          } finally {
            clientAbort.abort();
          }
        } finally {
          disposeRows();
          finalized.dispose();
        }
      } finally {
        await stopMetricsServer(server);
      }
    } finally {
      resolver.mockRestore();
    }
  });

  test("acquisition deadline finalizes exactly one failed 504 live request", async () => {
    saveConfig(liveMetricsConfig());
    const acquisitionStarted = Promise.withResolvers<void>();
    const resolver = stallAudioAcquisition(acquisitionStarted);
    try {
      const server = startMetricsServer({
        liveSidebandWebSocketFactory: () => { throw new Error("expired acquisition reached upstream dial"); },
      });
      try {
        const schedule = globalThis.setTimeout;
        let expire: (() => void) | undefined;
        const deadlineCaptured = Promise.withResolvers<void>();
        const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          if (delay === 120_000 && !expire) {
            expire = () => callback(...args);
            deadlineCaptured.resolve();
          }
          return schedule(callback, delay, ...args);
        }) as typeof setTimeout);
        try {
          const finalized = nextFinalRequestLog(entry => entry.status === 504);
          const rows: RequestLogEntry[] = [];
          const disposeRows = observeRequestLogsForTests(entry => { if (entry.model === "gpt-live") rows.push(entry); });
          try {
            const pending = fetch(new URL("/v1/realtime?model=fixture%2Fmetrics-model", server.url), {
              headers: { ...upgradeRequestHeaders(), "x-opencodex-api-key": DATA_TOKEN },
            }).then(response => ({ response }), error => ({ error }));
            await awaitBounded(Promise.all([acquisitionStarted.promise, deadlineCaptured.promise]), "acquisition deadline was not armed");
            expire!();
            const outcome = await awaitBounded(pending, "expired acquisition did not return");
            if (!("response" in outcome)) throw outcome.error;
            const { response } = outcome;
            expect(response.status).toBe(504);
            await response.text();
            const observedRow = await awaitObservation(finalized.promise);
            expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
            if (observedRow === OBSERVATION_TIMEOUT) throw new Error("acquisition deadline was not finalized");
            expect(observedRow.status).toBe(504);
            expect(rows.map(entry => entry.status)).toEqual([504]);
            const metrics = await scrapeServer(server);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="failed"}')).toBe(1);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="aborted"}')).toBe(0);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="incomplete"}')).toBe(0);
            expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(0);
          } finally {
            disposeRows();
            finalized.dispose();
          }
        } finally {
          timers.mockRestore();
        }
      } finally {
        await stopMetricsServer(server);
      }
    } finally {
      resolver.mockRestore();
    }
  });

  test("active-turn capacity refusal finalizes exactly one failed 503 live request", async () => {
    saveConfig(liveMetricsConfig());
    const server = startMetricsServer({
      liveSidebandWebSocketFactory: () => { throw new Error("capacity refusal reached upstream dial"); },
    });
    const leases: Array<{ release(): void }> = [];
    const finalized = nextFinalRequestLog(entry => entry.status === 503);
    const rows: RequestLogEntry[] = [];
    const disposeRows = observeRequestLogsForTests(entry => { if (entry.model === "gpt-live") rows.push(entry); });
    try {
      for (let index = 0; index < MAX_ACTIVE_SESSION_LANES; index += 1) {
        const lease = tryAdmitTurn(`metrics-capacity-${index}`);
        if (!lease) throw new Error(`failed to reserve capacity lane ${index}`);
        leases.push(lease);
      }
      const response = await fetch(new URL("/v1/realtime?model=fixture%2Fmetrics-model", server.url), {
        headers: { ...upgradeRequestHeaders(), "session-id": "metrics-capacity-overflow" },
      });
      expect(response.status).toBe(503);
      await response.text();
      const observedRow = await awaitObservation(finalized.promise);
      expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
      if (observedRow === OBSERVATION_TIMEOUT) throw new Error("capacity refusal was not finalized");
      expect(observedRow.status).toBe(503);
      expect(rows.map(entry => entry.status)).toEqual([503]);
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="failed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="aborted"}')).toBe(0);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="incomplete"}')).toBe(0);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(0);
    } finally {
      for (const lease of leases.reverse()) lease.release();
      disposeRows();
      finalized.dispose();
      await stopMetricsServer(server);
    }
  });

  test("acquisition resolver exception finalizes one 500 row before rethrow", async () => {
    saveConfig(liveMetricsConfig());
    const fixtureError = new Error("metrics acquisition resolver failure");
    const resolver = spyOn(audioUpstream, "resolveAudioUpstream").mockImplementation(async () => { throw fixtureError; });
    try {
      const observedErrors: unknown[] = [];
      const unexpectedErrors: unknown[] = [];
      const server = startMetricsServerWithExpectedError(fixtureError, observedErrors, unexpectedErrors);
      try {
        const finalized = nextFinalRequestLog(entry => entry.status === 500);
        const rows: RequestLogEntry[] = [];
        const disposeRows = observeRequestLogsForTests(entry => { if (entry.model === "gpt-live") rows.push(entry); });
        try {
          const response = await fetch(new URL("/v1/realtime?model=fixture%2Fmetrics-model", server.url), {
            headers: { ...upgradeRequestHeaders(), "x-opencodex-api-key": DATA_TOKEN },
          });
          expect(response.status).toBe(500);
          await response.text();
          const observedRow = await awaitObservation(finalized.promise);
          expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
          if (observedRow === OBSERVATION_TIMEOUT) throw new Error("resolver exception was not finalized");
          expect(observedRow.status).toBe(500);
          expect(rows.map(entry => entry.status)).toEqual([500]);
          expect(observedErrors).toEqual([fixtureError]);
          expect(unexpectedErrors).toEqual([]);
          const metrics = await scrapeServer(server);
          expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="failed"}')).toBe(1);
          expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="aborted"}')).toBe(0);
          expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="incomplete"}')).toBe(0);
          expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(0);
        } finally {
          disposeRows();
          finalized.dispose();
        }
      } finally {
        await stopMetricsServer(server);
      }
    } finally {
      resolver.mockRestore();
    }
  });

  test.each([
    ["upgrade-throw", 502],
    ["upgrade-false", 426],
  ] as const)("%s finalizes exactly one failed live request", async (control, expectedStatus) => {
    const upstream = startLiveMetricsUpstream();
    try {
      saveConfig(liveMetricsConfig());
      const upstreamUrl = new URL("/upstream", upstream.url);
      upstreamUrl.protocol = "ws:";
      let factoryCalls = 0;
      const server = startMetricsServerWithLiveRequestControl(control, {
        liveSidebandWebSocketFactory: () => {
          factoryCalls += 1;
          return new WebSocket(upstreamUrl);
        },
      });
      const finalized = nextFinalRequestLog(entry => entry.status === expectedStatus);
      const rows: RequestLogEntry[] = [];
      const disposeRows = observeRequestLogsForTests(entry => { if (entry.model === "gpt-live") rows.push(entry); });
      try {
        const response = await fetch(new URL("/v1/realtime?model=fixture%2Fmetrics-model", server.url), {
          headers: upgradeRequestHeaders(),
        });
        expect(response.status).toBe(expectedStatus);
        await response.text();
        const observedRow = await awaitObservation(finalized.promise);
        expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
        if (observedRow === OBSERVATION_TIMEOUT) throw new Error(`${expectedStatus} upgrade refusal was not finalized`);
        expect(observedRow.status).toBe(expectedStatus);
        expect(rows.map(entry => entry.status)).toEqual([expectedStatus]);
        expect(factoryCalls).toBe(1);
        const metrics = await scrapeServer(server);
        expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="failed"}')).toBe(1);
        expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="completed"}')).toBe(0);
        expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="aborted"}')).toBe(0);
        expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="unknown",result="incomplete"}')).toBe(0);
      } finally {
        disposeRows();
        finalized.dispose();
        await stopMetricsServer(server);
      }
    } finally {
      await upstream.stop(true);
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
    const server = startMetricsServer();
    try {
      const response = await sendResponsesRequest(server);
      expect(response.status).toBe(200);
      await response.text();
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="failed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(0);
    } finally {
      await stopMetricsServer(server);
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
    const server = startMetricsServer();
    try {
      const response = await sendResponsesRequest(server);
      expect(response.status).toBe(200);
      await response.text();
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="incomplete"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(0);
    } finally {
      await stopMetricsServer(server);
    }
  });

  test("buffered read errors stay failed even after terminal-looking partial bytes", async () => {
    const bytes = new TextEncoder().encode(completedResponseJson("partial"));
    const fixtureError = new Error("fixture read failure");
    const observedErrors: unknown[] = [];
    const unexpectedErrors: unknown[] = [];
    installUpstream(originalFetch, () => {
      let delivered = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(bytes);
            return;
          }
          controller.error(fixtureError);
        },
      }), { headers: { "content-type": "application/json" } });
    });
    saveConfig(runtimeConfig("openai-responses"));
    const server = startMetricsServerWithExpectedError(fixtureError, observedErrors, unexpectedErrors);
    const finalized = nextFinalRequestLog(entry => entry.status === 502 && entry.inboundProtocol === "responses");
    try {
      const response = await sendResponsesRequest(server);
      expect(response.status).toBe(500);
      await response.text();
      expect(observedErrors).toEqual([fixtureError]);
      expect(unexpectedErrors).toEqual([]);
      const observedRow = await awaitObservation(finalized.promise);
      expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
      if (observedRow === OBSERVATION_TIMEOUT) throw new Error("read-error finalization was not observed");
      const row = observedRow;
      expect(row).toMatchObject({ status: 502, closeReason: "non_stream" });
      expect(row.firstOutputMs).toBeUndefined();
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="failed"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="completed"}')).toBe(0);
      expect(sampleValue(metrics, 'opencodex_physical_sends_total{protocol="responses"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_ttft_missing_total{protocol="responses",result="failed"}')).toBe(1);
    } finally {
      finalized.dispose();
      await stopMetricsServer(server);
    }
  });

  test("a client abort during buffered JSON read is counted as aborted before rethrow", async () => {
    let signalReadStarted: (() => void) | undefined;
    let signalAbortObserved: (() => void) | undefined;
    const readStarted = new Promise<void>(resolve => { signalReadStarted = resolve; });
    const abortObserved = new Promise<void>(resolve => { signalAbortObserved = resolve; });
    installUpstream(originalFetch, (_send, request) => {
      const signal = request.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => {
            signalAbortObserved?.();
            try { controller.error(signal.reason); } catch { /* stream already settled */ }
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        },
        pull() {
          signalReadStarted?.();
          return new Promise<void>(() => {});
        },
      }), { headers: { "content-type": "application/json" } });
    });
    saveConfig(runtimeConfig("openai-responses"));
    const server = startMetricsServer();
    const clientAbort = new AbortController();
    const finalized = nextFinalRequestLog(entry => entry.status === 499 && entry.closeReason === "client_cancel");
    try {
      const request = sendResponsesRequest(server, false, clientAbort.signal);
      const requestOutcome = request.catch(error => error);
      await awaitBounded(readStarted, "upstream buffer read did not start");
      clientAbort.abort(new DOMException("client cancelled metrics request", "AbortError"));
      await awaitBounded(abortObserved, "outgoing upstream signal did not observe client abort");
      const outcome = await awaitBounded(requestOutcome, "client abort request did not settle");
      expect(outcome).toBeInstanceOf(Error);
      const observedRow = await awaitObservation(finalized.promise);
      expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
      if (observedRow === OBSERVATION_TIMEOUT) throw new Error("buffered-abort finalization was not observed");
      const row = observedRow;
      expect(row).toMatchObject({ status: 499, closeReason: "client_cancel" });
      expect(row.firstOutputMs).toBeUndefined();
      const metrics = await scrapeServer(server);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="aborted"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="failed"}')).toBe(0);
      expect(sampleValue(metrics, 'opencodex_physical_sends_total{protocol="responses"}')).toBe(1);
      expect(sampleValue(metrics, 'opencodex_ttft_missing_total{protocol="responses",result="aborted"}')).toBe(1);
    } finally {
      finalized.dispose();
      await stopMetricsServer(server);
    }
  });

  test("terminal-free SSE EOF and downstream cancellation remain incomplete and aborted", async () => {
    const encoder = new TextEncoder();
    installUpstream(originalFetch, (send, request) => {
      if (send === 1) {
        return new Response(responseSse(), { headers: { "content-type": "text/event-stream" } });
      }
      const signal = request.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => {
            try { controller.error(signal.reason); } catch { /* stream already settled */ }
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          controller.enqueue(encoder.encode(responseSse()));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    saveConfig(runtimeConfig("openai-responses"));
    const server = startMetricsServer();
    try {
      const incomplete = await sendResponsesRequest(server, true);
      await incomplete.text();
      const finalized = nextFinalRequestLog(entry => entry.status === 499 && entry.closeReason === "client_cancel");
      const clientAbort = new AbortController();
      const cancelled = await sendResponsesRequest(server, true, clientAbort.signal);
      const reader = cancelled.body?.getReader();
      try {
        expect(reader).toBeDefined();
        expect((await reader!.read()).done).toBe(false);
        clientAbort.abort(new DOMException("client cancelled streaming metrics request", "AbortError"));
        const observedRow = await awaitObservation(finalized.promise);
        expect(observedRow).not.toBe(OBSERVATION_TIMEOUT);
        if (observedRow === OBSERVATION_TIMEOUT) throw new Error("stream-cancel finalization was not observed");
        const row = observedRow;
        expect(row).toMatchObject({ status: 499, closeReason: "client_cancel" });
        expect(row.firstOutputMs).toBeUndefined();
        const metrics = await scrapeServer(server);
        expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="incomplete"}')).toBe(1);
        expect(sampleValue(metrics, 'opencodex_logical_requests_total{protocol="responses",result="aborted"}')).toBe(1);
        expect(sampleValue(metrics, 'opencodex_ttft_missing_total{protocol="responses",result="incomplete"}')).toBe(1);
        expect(sampleValue(metrics, 'opencodex_ttft_missing_total{protocol="responses",result="aborted"}')).toBe(1);
      } finally {
        await reader?.cancel().catch(() => {});
        finalized.dispose();
      }
    } finally {
      await stopMetricsServer(server);
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
    const server = startMetricsServer();
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
      await stopMetricsServer(server);
    }
  });

  test("disabled live server exposes no metrics owner and returns authenticated 404", async () => {
    saveConfig(runtimeConfig("openai-responses", false));
    const server = startMetricsServer();
    try {
      const response = await fetch(new URL("/api/metrics", server.url), {
        headers: { "x-opencodex-api-key": ADMIN_TOKEN },
      });
      expect(response.status).toBe(404);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("not_found");
    } finally {
      await stopMetricsServer(server);
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
