import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createAnthropicAdapter } from "./adapters/anthropic";
import { createAzureAdapter } from "./adapters/azure";
import { createGoogleAdapter } from "./adapters/google";
import { createOpenAIChatAdapter } from "./adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "./adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { loadConfig, resolveEnvValue } from "./config";
import { parseRequest } from "./responses/parser";
import { routeModel } from "./router";
import type { OcxConfig, OcxProviderConfig } from "./types";

const VERSION = "0.0.1";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon",
};

function findGuiDist(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "gui", "dist"),
    join(import.meta.dir, "..", "..", "gui", "dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

const GUI_DIST = findGuiDist();

function serveGuiFile(pathname: string): Response | null {
  if (!GUI_DIST) return null;
  const filePath = pathname === "/" || pathname === ""
    ? join(GUI_DIST, "index.html")
    : join(GUI_DIST, pathname);

  if (!existsSync(filePath)) {
    if (!extname(pathname)) {
      const indexPath = join(GUI_DIST, "index.html");
      if (existsSync(indexPath)) {
        return new Response(Bun.file(indexPath), {
          headers: { "Content-Type": "text/html" },
        });
      }
    }
    return null;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": contentType },
  });
}

function resolveAdapter(providerConfig: OcxProviderConfig) {
  switch (providerConfig.adapter) {
    case "openai-chat":
      return createOpenAIChatAdapter(providerConfig);
    case "anthropic":
      return createAnthropicAdapter(providerConfig);
    case "openai-responses":
      return createResponsesPassthroughAdapter(providerConfig);
    case "google":
      return createGoogleAdapter(providerConfig);
    case "azure-openai":
      return createAzureAdapter(providerConfig);
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

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace
  // (e.g. "opencode-go/deepseek-v4-pro" → "deepseek-v4-pro"). Adapters read parsed.modelId,
  // and the passthrough adapter serializes _rawBody, so rewrite both.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }

  const adapter = resolveAdapter(route.provider);

  if ("passthrough" in adapter && adapter.passthrough) {
    const request = adapter.buildRequest(parsed, { headers: req.headers });
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

  const request = adapter.buildRequest(parsed, { headers: req.headers });

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

  if (url.pathname === "/api/models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    return jsonResponse(models.map(m => ({ ...m, namespaced: `${m.provider}/${m.id}` })));
  }

  return null;
}

async function fetchAllModels(config: OcxConfig) {
  const results: { id: string; provider: string; owned_by?: string }[] = [];
  const fetches = Object.entries(config.providers).map(async ([name, prov]) => {
    if (prov.authMode === "forward") return; // ChatGPT backend has no /models; gpt listed statically
    const apiKey = resolveEnvValue(prov.apiKey);
    const headers: Record<string, string> = { ...(prov.headers ?? {}) };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    try {
      const res = await fetch(`${prov.baseUrl}/models`, { headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const json = await res.json() as { data?: { id: string; owned_by?: string }[] };
      if (json.data && Array.isArray(json.data)) {
        for (const m of json.data) {
          results.push({ id: m.id, provider: name, owned_by: m.owned_by });
        }
      }
    } catch { /* provider unreachable, skip */ }
  });
  await Promise.all(fetches);
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
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

      if (url.pathname === "/v1/models" && req.method === "GET") {
        const goModels = await fetchAllModels(config);
        const { buildCatalogEntries, loadCatalogTemplate, NATIVE_OPENAI_MODELS } = await import("./codex-catalog");
        if (url.searchParams.has("client_version")) {
          // Codex client → Codex catalog shape: native gpt + namespaced routed models,
          // cloned from a native template so required fields (base_instructions, etc.) are present.
          return jsonResponse({ models: buildCatalogEntries(loadCatalogTemplate(), NATIVE_OPENAI_MODELS, goModels) });
        }
        // OpenAI list shape: native gpt bare + routed models namespaced "<provider>/<id>"
        const data = [
          ...NATIVE_OPENAI_MODELS.map(id => ({ id, object: "model", created: 0, owned_by: "openai" })),
          ...goModels.map(m => ({ id: `${m.provider}/${m.id}`, object: "model", created: 0, owned_by: m.owned_by ?? m.provider })),
        ];
        return jsonResponse({ object: "list", data });
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

      const guiFile = serveGuiFile(url.pathname);
      if (guiFile) return guiFile;

      return formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`);
    },
  });

  console.log(`🚀 opencodex proxy running on http://localhost:${listenPort}`);
  console.log(`   POST /v1/responses → provider translation`);
  console.log(`   GET  /healthz      → health check`);
  console.log(`   GET  /api/*        → management API`);
  console.log(`   GET  /             → GUI dashboard`);

  return server;
}
