import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { configDiagnosticsFromRaw, validateConfigCandidate } from "../../src/config/diagnostics";
import { metricsExportEnabled } from "../../src/config/feature-flags";
import { getDefaultConfig } from "../../src/config/proxy-env";
import { handleManagementAPI } from "../../src/server/management-api";
import { requireManagementAuth, type ManagementAuthState } from "../../src/server/management-auth";
import { addFinalRequestLog, type RequestLogContext } from "../../src/server/request-log";
import { createRequestMetricsOwner } from "../../src/server/request-metrics";
import type { OcxConfig } from "../../src/types";
import type { AttemptRecoveryKind } from "../../src/usage/log";
import { ManagementRequest } from "../helpers/management-auth";
import { repoPath } from "../helpers/repo-root";

const ADMIN_TOKEN = "ocx_admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DATA_TOKEN = "ocx_data_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
