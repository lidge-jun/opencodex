import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createAnthropicAdapter } from "./adapters/anthropic";
import { createAzureAdapter } from "./adapters/azure";
import { createGoogleAdapter } from "./adapters/google";
import { createOpenAIChatAdapter } from "./adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "./adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import {
  buildWarmupCompletionFrames,
  buildWsErrorFrame,
  selectForwardHeaders,
  sendJsonFrame,
  sendResponseToWebSocket,
  sendTextFrame,
  type WsData,
} from "./ws-bridge";
import type { ServerWebSocket } from "bun";
import { DEFAULT_SUBAGENT_MODELS, codexAutoStartEnabled, loadConfig, saveConfig, websocketsEnabled } from "./config";
import { parseRequest } from "./responses/parser";
import { routeModel } from "./router";
import { namespacedToolName } from "./types";
import {
  clearLoginState, getLoginStatus, getValidAccessToken, isOAuthProvider,
  listOAuthProviders, reconcileOAuthProviders, startLoginFlow, upsertOAuthProvider,
} from "./oauth/index";
import type { CatalogModel } from "./codex-catalog";
import { buildWebSearchTool, planWebSearch, runWithWebSearch } from "./web-search";
import { describeImagesInPlace, planVisionSidecar } from "./vision";
import { removeCredential } from "./oauth/store";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "./oauth/key-providers";
import { deriveProviderPresets } from "./providers/derive";
import type { OcxConfig, OcxProviderConfig } from "./types";

// Single source of truth = package.json (../ from src/), so /healthz + the GUI badge match the
// installed npm version instead of a stale hardcode.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

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

const ANTHROPIC_WIRE_MODELS: Record<string, Set<string>> = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3", "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"]),
};

function resolveWireProtocolOverride(providerName: string, modelId: string, providerConfig: OcxProviderConfig): OcxProviderConfig {
  const overrideSet = ANTHROPIC_WIRE_MODELS[providerName];
  if (overrideSet?.has(modelId) && providerConfig.adapter !== "anthropic") {
    return { ...providerConfig, adapter: "anthropic" };
  }
  return providerConfig;
}

export function resolveAdapter(providerConfig: OcxProviderConfig) {
  switch (providerConfig.adapter) {
    case "openai-chat":
      return createOpenAIChatAdapter(providerConfig);
    case "anthropic":
      return createAnthropicAdapter(providerConfig);
    case "openai-responses":
      return createResponsesPassthroughAdapter(providerConfig);
    case "google":
      return createGoogleAdapter(providerConfig);
    case "azure":
    case "azure-openai":
      return createAzureAdapter(providerConfig);
    default:
      throw new Error(`Unknown adapter: ${providerConfig.adapter}`);
  }
}

async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: { model: string; provider: string },
  options: { forceEmptyResponseId?: boolean; abortSignal?: AbortSignal } = {},
): Promise<Response> {
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
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;

  // OAuth providers: swap in a fresh access token (auto-refreshed) as the Bearer key, so the
  // existing openai-chat / anthropic adapters authenticate with no change.
  if (route.provider.authMode === "oauth") {
    try {
      route.provider = { ...route.provider, apiKey: await getValidAccessToken(route.providerName) };
    } catch (err) {
      return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Give it "eyes" —
  // describe each attached image with a gpt vision model via the ChatGPT passthrough and replace it
  // with text BEFORE the main call, so the text-only model can reason about it.
  const visionPlan = planVisionSidecar(config, route.provider, route.modelId, parsed, req.headers);
  if (visionPlan) {
    await describeImagesInPlace(parsed, visionPlan.forwardProvider, req.headers, visionPlan.settings, options.abortSignal);
  }

  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  const adapter = resolveAdapter(adapterProvider);

  if ("passthrough" in adapter && adapter.passthrough) {
    const request = adapter.buildRequest(parsed, { headers: req.headers });
    // Abort the upstream if the client disconnects. A directly-relayed body does not propagate the
    // consumer's cancel to a signalled fetch, so we pass the signal and relay through relayWithAbort,
    // whose cancel() aborts the upstream — preventing leaked connections (RC2, passthrough path).
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);
    const connectMs = config.connectTimeoutMs ?? 30_000;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithHeaderTimeout(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }, upstream.signal, connectMs);
    } catch (err) {
      upstream.abort();
      const msg = err instanceof Error && err.name === "TimeoutError"
        ? `Provider connect timeout after ${connectMs}ms`
        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return formatErrorResponse(502, "upstream_error", msg);
    }
    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
    const isEventStream = headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
    const body = isEventStream
      ? relaySseWithHeartbeat(upstreamResponse.body, upstream)
      : relayWithAbort(upstreamResponse.body, upstream);
    return new Response(body, {
      status: upstreamResponse.status,
      headers,
    });
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  const wsPlan = planWebSearch(config, parsed, false, req.headers, route.provider, route.modelId);
  if (wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    return runWithWebSearch({
      parsed, adapter,
      forwardProvider: wsPlan.forwardProvider,
      hostedTool: wsPlan.hostedTool,
      incomingHeaders: req.headers,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
    });
  }

  const upstream = new AbortController();
  linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 30_000;

  const request = adapter.buildRequest(parsed, { headers: req.headers });
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchWithHeaderTimeout(request.url, {
      method: request.method, headers: request.headers, body: request.body,
    }, upstream.signal, connectMs);
  } catch (err) {
    upstream.abort();
    const msg = err instanceof Error && err.name === "TimeoutError"
      ? `Provider connect timeout after ${connectMs}ms`
      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return formatErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => "unknown error");
    return formatErrorResponse(upstreamResponse.status, "upstream_error", `Provider error ${upstreamResponse.status}: ${errorText.slice(0, 500)}`);
  }

  if (parsed.stream) {
    const eventStream = adapter.parseStream(upstreamResponse);
    const toolNsMap = new Map<string, { namespace: string; name: string }>();
    const freeformToolNames = new Set<string>();
    const toolSearchToolNames = new Set<string>();
    for (const t of parsed.context.tools ?? []) {
      if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
      if (t.freeform) freeformToolNames.add(t.name);
      if (t.toolSearch) toolSearchToolNames.add(t.name);
    }
    const sseStream = bridgeToResponsesSSE(
      eventStream, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
      },
    );
    return new Response(sseStream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (adapter.parseResponse) {
    const events = await adapter.parseResponse(upstreamResponse);
    const toolNsMap = new Map<string, { namespace: string; name: string }>();
    const freeformToolNames = new Set<string>();
    const toolSearchToolNames = new Set<string>();
    for (const t of parsed.context.tools ?? []) {
      if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
      if (t.freeform) freeformToolNames.add(t.name);
      if (t.toolSearch) toolSearchToolNames.add(t.name);
    }
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
    });
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(500, "internal_error", "Non-streaming not supported by this adapter");
}

export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): void {
  if (!signal) return;
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return;
  }
  signal.addEventListener("abort", () => upstream.abort(signal.reason), { once: true });
}

async function fetchWithHeaderTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    if (!timeout.signal.aborted) timeout.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.any([abortSignal, timeout.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
}

const requestLog: { timestamp: number; model: string; provider: string; status: number; durationMs: number }[] = [];
const MAX_LOG_SIZE = 200;

function addRequestLog(entry: typeof requestLog[number]) {
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_SIZE) requestLog.shift();
}

/**
 * Relay an upstream body verbatim while wiring client-cancel -> upstream.abort(). A body returned
 * directly from fetch does NOT propagate the consumer's cancel to a signalled fetch, so a client
 * disconnect would leak the upstream connection. Pumping through this stream (whose cancel() aborts
 * the upstream) fixes the leak with zero byte changes — passthrough fidelity is preserved (RC2).
 */
export function relayWithAbort(
  body: ReadableStream<Uint8Array> | null,
  upstream: AbortController,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      // Client disconnected: abort the upstream fetch and release the reader so we do not leak it.
      upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function relaySseWithHeartbeat(
  body: ReadableStream<Uint8Array> | null,
  upstream: AbortController,
  heartbeatMs = 15_000,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  const heartbeat = new TextEncoder().encode(": opencodex keepalive\n\n");
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const cleanup = () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(heartbeat);
        } catch {
          cleanup();
        }
      }, heartbeatMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        cleanup();
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      cleanup();
      upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Bun's fetch auto-decompresses the response body but leaves the upstream `content-encoding`
 * (and a now-stale `content-length`) on `response.headers`. Relaying those with the already-decoded
 * body makes the caller (Codex) double-decode / truncate → "stream error" on every gpt passthrough.
 * Drop encoding + hop-by-hop headers; relay everything else (content-type, etc.) verbatim.
 */
export function sanitizePassthroughHeaders(upstream: Headers): Headers {
  const DROP = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
  ]);
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!DROP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

let _corsOrigin = "http://localhost:10100";
function setCorsOrigin(port: number): void { _corsOrigin = `http://localhost:${port}`; }
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": _corsOrigin,
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

function isLocalOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return true;
  const localhostOrigin = _corsOrigin;
  const loopbackOrigin = _corsOrigin.replace("localhost", "127.0.0.1");
  return origin === localhostOrigin || origin === loopbackOrigin;
}

async function handleManagementAPI(req: Request, url: URL, config: OcxConfig): Promise<Response | null> {
  if ((req.method === "POST" || req.method === "PUT" || req.method === "DELETE") && !isLocalOrigin(req)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403);
  }
  async function refreshCodexCatalogBestEffort(): Promise<void> {
    try {
      const { refreshCodexModelCatalog } = await import("./codex-refresh");
      await refreshCodexModelCatalog(config);
    } catch {
      /* catalog absent */
    }
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    const safeConfig = JSON.parse(JSON.stringify(config));
    safeConfig.codexAutoStart = codexAutoStartEnabled(config);
    for (const prov of Object.values(safeConfig.providers as Record<string, OcxProviderConfig>)) {
      if (prov.apiKey) prov.apiKey = prov.apiKey.slice(0, 8) + "...";
    }
    return jsonResponse(safeConfig);
  }

  if (url.pathname === "/api/config" && req.method === "PUT") {
    return jsonResponse({ error: "Full config PUT is disabled. Use /api/providers POST for provider changes." }, 405);
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    return jsonResponse({
      codexAutoStart: codexAutoStartEnabled(config),
      port: config.port,
      hostname: config.hostname ?? "127.0.0.1",
    });
  }

  if (url.pathname === "/api/settings" && req.method === "PUT") {
    let body: { codexAutoStart?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (typeof body.codexAutoStart !== "boolean") {
      return jsonResponse({ error: "codexAutoStart boolean is required" }, 400);
    }
    config.codexAutoStart = body.codexAutoStart;
    saveConfig(config);
    return jsonResponse({ ok: true, codexAutoStart: codexAutoStartEnabled(config) });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
    const ws = config.webSearchSidecar ?? {};
    const vs = config.visionSidecar ?? {};
    return jsonResponse({
      webSearch: { model: ws.model ?? "gpt-5.4-mini", reasoning: ws.reasoning ?? "low" },
      vision: { model: vs.model ?? "gpt-5.4-mini" },
    });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "PUT") {
    let body: { webSearch?: { model?: string; reasoning?: string }; vision?: { model?: string } };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.webSearch) {
      config.webSearchSidecar = { ...config.webSearchSidecar };
      if (typeof body.webSearch.model === "string") config.webSearchSidecar.model = body.webSearch.model;
      if (typeof body.webSearch.reasoning === "string") config.webSearchSidecar.reasoning = body.webSearch.reasoning;
    }
    if (body.vision) {
      config.visionSidecar = { ...config.visionSidecar };
      if (typeof body.vision.model === "string") config.visionSidecar.model = body.vision.model;
    }
    saveConfig(config);
    const ws = config.webSearchSidecar ?? {};
    const vs = config.visionSidecar ?? {};
    return jsonResponse({
      ok: true,
      webSearch: { model: ws.model ?? "gpt-5.4-mini", reasoning: ws.reasoning ?? "low" },
      vision: { model: vs.model ?? "gpt-5.4-mini" },
    });
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

  // Add (or overwrite) a single provider. Merges into the live in-memory config and
  // persists — existing providers' real keys are never round-tripped (unlike PUT /api/config,
  // which would re-save the masked keys from GET). Live routing picks it up immediately.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: string; provider?: OcxProviderConfig; setDefault?: boolean };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = body.name?.trim();
    const prov = body.provider;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    enrichProviderFromCatalog(name, prov);
    const { saveConfig: save } = await import("./config");
    config.providers[name] = prov;
    if (body.setDefault) config.defaultProvider = name;
    save(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, name });
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !config.providers[name]) return jsonResponse({ error: "unknown provider" }, 404);
    const { saveConfig: save } = await import("./config");
    delete config.providers[name];
    save(config);
    // Drop its models from Codex's catalog immediately (re-sync + cache bust) so removal is live.
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    return jsonResponse(models.map(m => {
      const namespaced = `${m.provider}/${m.id}`;
      return { ...m, namespaced, disabled: disabled.has(namespaced) };
    }));
  }

  // Enable/disable models: which routed models Codex sees. PUT hides them from the catalog +
  // /v1/models and invalidates Codex's 5-min models cache so it applies on the next turn.
  if (url.pathname === "/api/disabled-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const disabled = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : [];
    config.disabledModels = disabled;
    const { saveConfig: save } = await import("./config");
    save(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, disabled });
  }

  // Which providers support real OAuth login (drives the GUI's "Log in with …" buttons).
  if (url.pathname === "/api/oauth/providers" && req.method === "GET") {
    return jsonResponse({ providers: listOAuthProviders() });
  }

  // API-key "login" providers (open dashboard → paste key). Drives the GUI's key-provider picker.
  if (url.pathname === "/api/key-providers" && req.method === "GET") {
    return jsonResponse({ providers: listKeyLoginProviders() });
  }

  // Complete GUI picker presets, derived from the canonical provider registry. The GUI is a
  // standalone Vite package, so it consumes this runtime view instead of importing repo-root src.
  if (url.pathname === "/api/provider-presets" && req.method === "GET") {
    return jsonResponse({ providers: deriveProviderPresets() });
  }

  // Subagent model picker: which ≤5 routed models Codex's spawn_agent advertises (it shows the
  // first 5 routed catalog entries). PUT reorders the injected catalog so the chosen ones lead.
  if (url.pathname === "/api/subagent-models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    // Native gpt (passthrough) are also valid subagent picks — they're picker-visible models in the
    // catalog, just buried by priority. List them first so the user can feature them over routed.
    const { listCatalogNativeSlugs } = await import("./codex-catalog");
    const available = [
      ...listCatalogNativeSlugs(),
      ...models.map(m => `${m.provider}/${m.id}`),
    ].filter(ns => !disabled.has(ns));
    return jsonResponse({ chosen: config.subagentModels ?? [], available });
  }
  if (url.pathname === "/api/subagent-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const chosen = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string").slice(0, 5) : [];
    config.subagentModels = chosen;
    const { saveConfig: save } = await import("./config");
    save(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, applied: chosen });
  }

  // OAuth login (xai now; anthropic/kimi in cycle 2). Starts the flow and returns the auth URL;
  // the provider's loopback callback server (inside this process) captures the redirect in the
  // background, then the credential is persisted. The GUI opens the URL and polls /api/oauth/status.
  if (url.pathname === "/api/oauth/login" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    try {
      const { url: authUrl, instructions } = await startLoginFlow(provider);
      upsertOAuthProvider(config, provider); // mutate LIVE config — routing sees it without restart
      if (authUrl) {
        // Open the browser server-side (the proxy runs on the user's machine) — the GUI's
        // window.open is popup-blocked because it runs after an await, not a direct click.
        const { openUrl } = await import("./open-url");
        openUrl(authUrl);
      }
      return jsonResponse({ url: authUrl, instructions });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }

  if (url.pathname === "/api/oauth/status" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    return jsonResponse(getLoginStatus(provider));
  }

  if (url.pathname === "/api/oauth/logout" && req.method === "POST") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    removeCredential(provider);
    clearLoginState(provider);
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/stop" && req.method === "POST") {
    const { restoreNativeCodex } = await import("./codex-inject");
    const { stopServiceIfInstalled } = await import("./service");
    stopServiceIfInstalled();
    restoreNativeCodex();
    setTimeout(() => process.exit(0), 200);
    return jsonResponse({ success: true, message: "Proxy stopping, native Codex restored." });
  }

  return null;
}

/**
 * Live routed-provider models for the proxy's /api/* and /v1/models endpoints. Delegates to the
 * canonical, TTL-cached `gatherRoutedModels` (single source of truth) — so the GUI/codex endpoints
 * share the same fetch, the same per-provider cache (dedups Codex's frequent /v1/models polling),
 * and the same stale fallback when a provider blips, instead of a parallel uncached copy.
 */
async function fetchAllModels(config: OcxConfig): Promise<CatalogModel[]> {
  const { gatherRoutedModels } = await import("./codex-catalog");
  return gatherRoutedModels(config);
}

export function startServer(port?: number) {
  const config = loadConfig();
  // Refresh OAuth provider presets (models/noReasoningModels) from the registry so a proxy update
  // adding/dropping models reaches existing configs on start — not just fresh installs.
  reconcileOAuthProviders(config);
  // Seed default featured subagent models on first run only (UNSET → defaults). A user-set list,
  // even [], is left alone so GUI removals persist.
  if (config.subagentModels === undefined) {
    config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
    saveConfig(config);
  }
  const listenPort = port ?? config.port ?? 10100;
  setCorsOrigin(listenPort);

  const server = Bun.serve<WsData>({
    port: listenPort,
    hostname: config.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // Responses WebSocket (phase 120.2). Codex upgrades the same /v1/responses path; auth is
      // handshake-time only, so capture inbound headers and thread them into the pipeline.
      if (url.pathname === "/v1/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!isLocalOrigin(req)) {
          return formatErrorResponse(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin");
        }
        if (server.upgrade(req, { data: { headers: selectForwardHeaders(req.headers) } })) return undefined as unknown as Response;
        return formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed");
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
        const { buildCatalogEntries, loadCatalogTemplate, nativeOpenAiSlugs, orderForSubagents } = await import("./codex-catalog");
        const nativeSlugs = nativeOpenAiSlugs();
        const disabledSet = new Set(config.disabledModels ?? []);
        const goEnabled = goModels.filter(m => !disabledSet.has(`${m.provider}/${m.id}`));
        const goOrdered = orderForSubagents(goEnabled, config.subagentModels);
        if (url.searchParams.has("client_version")) {
          // Codex client → Codex catalog shape: native gpt + namespaced routed models,
          // cloned from a native template so required fields (base_instructions, etc.) are present.
          // Pass the subagent picks so featured models lead by priority (matches the on-disk file).
          return jsonResponse({ models: buildCatalogEntries(loadCatalogTemplate(), nativeSlugs, goOrdered, config.subagentModels, websocketsEnabled(config)) });
        }
        // OpenAI list shape: native gpt bare + routed models namespaced "<provider>/<id>"
        const data = [
          ...nativeSlugs.map(id => ({ id, object: "model", created: 0, owned_by: "openai" })),
          ...goOrdered.map(m => ({ id: `${m.provider}/${m.id}`, object: "model", created: 0, owned_by: m.owned_by ?? m.provider })),
        ];
        return jsonResponse({ object: "list", data });
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
        if (!isLocalOrigin(req)) {
          return formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked");
        }
        const start = Date.now();
        const logCtx = { model: "unknown", provider: "unknown" };
        const response = await handleResponses(req, config, logCtx);
        addRequestLog({
          timestamp: start,
          model: logCtx.model,
          provider: logCtx.provider,
          status: response.status,
          durationMs: Date.now() - start,
        });
        return response;
      }

      const guiFile = serveGuiFile(url.pathname);
      if (guiFile) return guiFile;

      return formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`);
    },
    websocket: {
      // Responses WebSocket data plane (phase 120.2). Re-frames the same SSE pipeline onto the
      // socket: parse response.create → run handleResponses unchanged → pump its SSE body as WS
      // Text frames. response.processed is a no-op ack. close() aborts the upstream (RC2 parity).
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<string, unknown>;
        } catch {
          return; // text-only contract; ignore unparseable frames
        }
        if (frame.type === "response.processed") return; // ack — no-op
        if (frame.type !== "response.create") return;

        ws.data.cancel?.();
        const turnId = (ws.data.turnId ?? 0) + 1;
        ws.data.turnId = turnId;
        const isCurrent = () => ws.data.turnId === turnId;
        const turnAbort = new AbortController();
        const cancelTurn = () => {
          turnAbort.abort("websocket turn superseded or closed");
        };
        ws.data.cancel = cancelTurn;

        if (frame.generate === false) {
          for (const payload of buildWarmupCompletionFrames(frame)) {
            if (!isCurrent()) return;
            sendTextFrame(ws, payload);
          }
          if (ws.data.cancel === cancelTurn) ws.data.cancel = undefined;
          return;
        }

        const payload: Record<string, unknown> = { ...frame };
        delete payload.type;
        void (async () => {
          const logCtx = { model: "unknown", provider: "unknown" };
          const fwd = new Headers({ "content-type": "application/json" });
          ws.data.headers?.forEach((value, key) => fwd.set(key, value));
          const req = new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: fwd,
            body: JSON.stringify({ ...payload, stream: true }),
          });
          try {
            const response = await handleResponses(req, config, logCtx, {
              forceEmptyResponseId: true,
              abortSignal: turnAbort.signal,
            });
            await sendResponseToWebSocket(ws, response, isCurrent);
          } catch (err) {
            if (!isCurrent()) return;
            try {
              sendJsonFrame(ws, buildWsErrorFrame(502, {
                type: "proxy_error",
                message: err instanceof Error ? err.message : String(err),
              }));
            } catch {
              /* socket already gone or send dropped */
            }
          } finally {
            if (ws.data.cancel === cancelTurn) ws.data.cancel = undefined;
          }
        })();
      },
      close(ws: ServerWebSocket<WsData>) {
        ws.data.cancel?.(); // RC2: abort the upstream when the client disconnects
      },
    },
  });

  console.log(`🚀 opencodex proxy running on http://localhost:${listenPort}`);
  console.log(`   POST /v1/responses → provider translation`);
  console.log(`   GET  /healthz      → health check`);
  console.log(`   GET  /api/*        → management API`);
  console.log(`   GET  /             → GUI dashboard`);

  return server;
}
