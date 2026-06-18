import { createAnthropicAdapter } from "./adapters/anthropic";
import { createOpenAIChatAdapter } from "./adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "./adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { loadConfig } from "./config";
import { parseRequest } from "./responses/parser";
import { routeModel } from "./router";
import type { OcxConfig, OcxProviderConfig } from "./types";

const VERSION = "0.0.1";

function resolveAdapter(providerConfig: OcxProviderConfig) {
  switch (providerConfig.adapter) {
    case "openai-chat":
      return createOpenAIChatAdapter(providerConfig);
    case "anthropic":
      return createAnthropicAdapter(providerConfig);
    case "openai-responses":
      return createResponsesPassthroughAdapter(providerConfig);
    default:
      throw new Error(`Unknown adapter: ${providerConfig.adapter}`);
  }
}

async function handleResponses(req: Request, config: OcxConfig): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let parsed;
  try {
    parsed = parseRequest(body);
  } catch (err) {
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  let route;
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  const adapter = resolveAdapter(route.provider);

  if ("passthrough" in adapter && adapter.passthrough) {
    const request = adapter.buildRequest(parsed);
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    } catch (err) {
      return formatErrorResponse(502, "upstream_error", `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  }

  const request = adapter.buildRequest(parsed);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (err) {
    return formatErrorResponse(502, "upstream_error", `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => "unknown error");
    return formatErrorResponse(upstreamResponse.status, "upstream_error", `Provider error ${upstreamResponse.status}: ${errorText.slice(0, 500)}`);
  }

  if (parsed.stream) {
    const eventStream = adapter.parseStream(upstreamResponse);
    const sseStream = bridgeToResponsesSSE(eventStream, parsed.modelId);
    return new Response(sseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (adapter.parseResponse) {
    const events = await adapter.parseResponse(upstreamResponse);
    const json = buildResponseJSON(events, parsed.modelId);
    return new Response(JSON.stringify(json), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return formatErrorResponse(500, "internal_error", "Non-streaming not supported by this adapter");
}

const requestLog: { timestamp: number; model: string; provider: string; status: number; durationMs: number }[] = [];
const MAX_LOG_SIZE = 200;

function addRequestLog(entry: typeof requestLog[number]) {
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_SIZE) requestLog.shift();
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handleManagementAPI(req: Request, url: URL, config: OcxConfig): Promise<Response | null> {
  if (url.pathname === "/api/config" && req.method === "GET") {
    const safeConfig = JSON.parse(JSON.stringify(config));
    for (const prov of Object.values(safeConfig.providers as Record<string, OcxProviderConfig>)) {
      if (prov.apiKey) prov.apiKey = prov.apiKey.slice(0, 8) + "...";
    }
    return jsonResponse(safeConfig);
  }

  if (url.pathname === "/api/config" && req.method === "PUT") {
    const body = await req.json() as OcxConfig;
    const { saveConfig: save } = await import("./config");
    save(body);
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/logs" && req.method === "GET") {
    return jsonResponse(requestLog);
  }

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
      name, adapter: p.adapter, baseUrl: p.baseUrl, defaultModel: p.defaultModel,
      hasApiKey: !!p.apiKey,
    })));
  }

  return null;
}

export function startServer(port?: number) {
  const config = loadConfig();
  const listenPort = port ?? config.port ?? 10100;

  const server = Bun.serve({
    port: listenPort,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        return jsonResponse({ status: "ok", version: VERSION, uptime: process.uptime() });
      }

      if (url.pathname.startsWith("/api/")) {
        const mgmtResponse = await handleManagementAPI(req, url, config);
        if (mgmtResponse) return mgmtResponse;
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
        const start = Date.now();
        const response = await handleResponses(req, config);
        addRequestLog({
          timestamp: start,
          model: "unknown",
          provider: config.defaultProvider,
          status: response.status,
          durationMs: Date.now() - start,
        });
        return response;
      }

      return formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`);
    },
  });

  console.log(`🚀 opencodex proxy running on http://localhost:${listenPort}`);
  console.log(`   POST /v1/responses → provider translation`);
  console.log(`   GET  /healthz      → health check`);
  console.log(`   GET  /api/*        → management API`);

  return server;
}
