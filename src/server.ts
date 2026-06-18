import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createAnthropicAdapter } from "./adapters/anthropic";
import { createAzureAdapter } from "./adapters/azure";
import { createGoogleAdapter } from "./adapters/google";
import { createOpenAIChatAdapter } from "./adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "./adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { DEFAULT_SUBAGENT_MODELS, loadConfig, saveConfig } from "./config";
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

async function handleResponses(req: Request, config: OcxConfig, logCtx: { model: string; provider: string }): Promise<Response> {
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
    await describeImagesInPlace(parsed, visionPlan.forwardProvider, req.headers, visionPlan.settings);
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
      headers: sanitizePassthroughHeaders(upstreamResponse.headers),
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
    // Map flattened MCP tool names back to {namespace, name} so the bridge can restore the
    // namespace field Codex needs to route the call to the right MCP server.
    const toolNsMap = new Map<string, { namespace: string; name: string }>();
    const freeformToolNames = new Set<string>();
    const toolSearchToolNames = new Set<string>();
    for (const t of parsed.context.tools ?? []) {
      if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
      if (t.freeform) freeformToolNames.add(t.name);
      if (t.toolSearch) toolSearchToolNames.add(t.name);
    }
    const sseStream = bridgeToResponsesSSE(eventStream, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames);
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

/**
 * Bun's fetch auto-decompresses the response body but leaves the upstream `content-encoding`
 * (and a now-stale `content-length`) on `response.headers`. Relaying those with the already-decoded
 * body makes the caller (Codex) double-decode / truncate → "stream error" on every gpt passthrough.
 * Drop encoding + hop-by-hop headers; relay everything else (content-type, etc.) verbatim.
 */
export function sanitizePassthroughHeaders(upstream: Headers): Headers {
  const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!DROP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
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
    return jsonResponse({ success: true, name });
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !config.providers[name]) return jsonResponse({ error: "unknown provider" }, 404);
    const { saveConfig: save } = await import("./config");
    delete config.providers[name];
    save(config);
    // Drop its models from Codex's catalog immediately (re-sync + cache bust) so removal is live.
    try {
      const { syncCatalogModels, invalidateCodexModelsCache } = await import("./codex-catalog");
      await syncCatalogModels(config);
      invalidateCodexModelsCache();
    } catch { /* catalog absent */ }
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
    try {
      const { syncCatalogModels, invalidateCodexModelsCache } = await import("./codex-catalog");
      await syncCatalogModels(config);
      invalidateCodexModelsCache();
    } catch { /* catalog absent */ }
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
    try {
      const { syncCatalogModels, invalidateCodexModelsCache } = await import("./codex-catalog");
      await syncCatalogModels(config);
      invalidateCodexModelsCache();
    } catch { /* catalog absent */ }
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
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
        (await import("node:child_process")).exec(`${cmd} "${authUrl}"`, () => {});
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
        const { buildCatalogEntries, loadCatalogTemplate, nativeOpenAiSlugs, orderForSubagents } = await import("./codex-catalog");
        const nativeSlugs = nativeOpenAiSlugs();
        const disabledSet = new Set(config.disabledModels ?? []);
        const goEnabled = goModels.filter(m => !disabledSet.has(`${m.provider}/${m.id}`));
        const goOrdered = orderForSubagents(goEnabled, config.subagentModels);
        if (url.searchParams.has("client_version")) {
          // Codex client → Codex catalog shape: native gpt + namespaced routed models,
          // cloned from a native template so required fields (base_instructions, etc.) are present.
          // Pass the subagent picks so featured models lead by priority (matches the on-disk file).
          return jsonResponse({ models: buildCatalogEntries(loadCatalogTemplate(), nativeSlugs, goOrdered, config.subagentModels) });
        }
        // OpenAI list shape: native gpt bare + routed models namespaced "<provider>/<id>"
        const data = [
          ...nativeSlugs.map(id => ({ id, object: "model", created: 0, owned_by: "openai" })),
          ...goOrdered.map(m => ({ id: `${m.provider}/${m.id}`, object: "model", created: 0, owned_by: m.owned_by ?? m.provider })),
        ];
        return jsonResponse({ object: "list", data });
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
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
  });

  console.log(`🚀 opencodex proxy running on http://localhost:${listenPort}`);
  console.log(`   POST /v1/responses → provider translation`);
  console.log(`   GET  /healthz      → health check`);
  console.log(`   GET  /api/*        → management API`);
  console.log(`   GET  /             → GUI dashboard`);

  return server;
}
