import { existsSync, readFileSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { createAnthropicAdapter } from "./adapters/anthropic";
import { createAzureAdapter } from "./adapters/azure";
import { createGoogleAdapter } from "./adapters/google";
import { createKiroAdapter } from "./adapters/kiro";
import { createOpenAIChatAdapter } from "./adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "./adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "./bridge";
import { markActivity } from "./sidecar-tracker";
import {
  buildWarmupCompletionFrames,
  buildWsErrorFrame,
  selectForwardHeaders,
  sendJsonFrame,
  sendResponseToWebSocket,
  sendTextFrame,
  type WsData,
} from "./ws-bridge";
import type { Server, ServerWebSocket } from "bun";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  getConfigPath,
  hasOwnProvider,
  isValidProviderName,
  loadConfig,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfig,
  websocketsEnabled,
} from "./config";
import { parseRequest } from "./responses/parser";
import { routeModel } from "./router";
import { namespacedToolName } from "./types";
import {
  clearLoginState, getLoginStatus, getOAuthCredentialProjectId, getValidAccessToken, isOAuthProvider,
  listOAuthProviders, reconcileOAuthProviders, startLoginFlow, UnsupportedOAuthProviderError, upsertOAuthProvider,
} from "./oauth/index";
import type { CatalogModel } from "./codex-catalog";
import { invalidateCodexModelsCache, readCodexCatalogPath } from "./codex-catalog";
import { CODEX_CONFIG_PATH, readRootTomlString } from "./codex-paths";
import { buildWebSearchTool, planWebSearch, runWithWebSearch } from "./web-search";
import { describeImagesInPlace, planVisionSidecar } from "./vision";
import { removeCredential } from "./oauth/store";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "./oauth/key-providers";
import { deriveProviderPresets } from "./providers/derive";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "./types";
import type { OcxUsage } from "./types";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "./provider-context-cap";
import {
  appendUsageEntry,
  readUsageEntries,
  usageForFinalLog,
  usageStatusForFinalLog,
  usageTotalTokens,
  type UsageStatus,
} from "./usage-log";
import { parseRange, summarizeUsage } from "./usage-summary";
import {
  appendUsageDebug,
  isUsageDebugEnabled,
  truncateForDebug,
  USAGE_DEBUG_BODY_SAMPLE_BYTES,
  type UsageDebugBodyKind,
} from "./usage-debug";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  stripCodexRuntimeProviderFields,
  type CodexAuthContext,
} from "./codex-auth-context";
export {
  clearThreadAccountMap,
  formatCodexProviderForLog,
  resolveCodexAccountForThread,
} from "./codex-routing";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "./codex-routing";
import { registerCodexWebSocket, unregisterCodexWebSocket, updateCodexWebSocketAuthContext } from "./codex-websocket-registry";

// ---------------------------------------------------------------------------
// Active turn tracking + graceful shutdown drain
// ---------------------------------------------------------------------------

const activeTurns = new Set<AbortController>();
let draining = false;
const MAX_WS_FRAME_BYTES = 50 * 1024 * 1024;
const WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0;
const nativePassthroughSseResponses = new WeakSet<Response>();

export interface RequestLogContext {
  model: string;
  provider: string;
  requestedModel?: string;
  requestedEffort?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  resolvedModel?: string;
  usage?: OcxUsage;
  usageLogInputTokens?: number;
  usageDebugBodyKind?: UsageDebugBodyKind;
  usageDebugBodySample?: string;
  usageDebugContentType?: string;
}

export function registerTurn(ac: AbortController): void { activeTurns.add(ac); }
export function unregisterTurn(ac: AbortController): void { activeTurns.delete(ac); }
export function isDraining(): boolean { return draining; }
export function getActiveTurnCount(): number { return activeTurns.size; }

export function trackStreamLifetime(
  body: ReadableStream<Uint8Array>,
  ac: AbortController,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  registerTurn(ac);
  const reader = body.getReader();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    unregisterTurn(ac);
    onDone?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        finish();
        try { controller.error(err); } catch { /* already closed */ }
      }
    },
    cancel(reason) {
      finish();
      ac.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

let _serverRef: ReturnType<typeof Bun.serve> | undefined;

export async function drainAndShutdown(
  server: ReturnType<typeof Bun.serve> | undefined,
  timeoutMs: number,
): Promise<void> {
  const s = server ?? _serverRef;
  draining = true;
  const deadline = Date.now() + timeoutMs;
  while (activeTurns.size > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  if (activeTurns.size > 0) {
    console.log(`⚠️  Aborting ${activeTurns.size} in-flight turn(s) after ${timeoutMs}ms deadline`);
    for (const ac of activeTurns) {
      ac.abort(new Error("server shutdown"));
    }
    activeTurns.clear();
  }
  s?.stop(true);
  draining = false;
}

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

export function resolveGuiFilePath(guiDist: string, pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const relativePath = decodedPath === "/" || decodedPath === ""
    ? "index.html"
    : decodedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = resolve(guiDist);
  const filePath = resolve(root, relativePath);
  const rel = relative(root, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return filePath;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function serveGuiFile(pathname: string): Response | null {
  const guiDist = findGuiDist();
  if (!guiDist) return null;
  const filePath = resolveGuiFilePath(guiDist, pathname);
  if (!filePath) return null;

  if (!isFile(filePath)) {
    if (!extname(pathname)) {
      const indexPath = join(guiDist, "index.html");
      if (isFile(indexPath)) {
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

export function rootFallbackPayload() {
  return {
    status: "ok",
    service: "opencodex",
    version: VERSION,
    dashboard: {
      available: false,
      reason: "GUI build not found. Run `bun run build:gui` from the opencodex repo, or use `ocx gui` from a packaged install.",
    },
    endpoints: {
      health: "/healthz",
      models: "/v1/models",
      responses: "/v1/responses",
      management: "/api/*",
    },
  };
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
    case "kiro":
      return createKiroAdapter(providerConfig);
    case "azure":
    case "azure-openai":
      return createAzureAdapter(providerConfig);
    default:
      throw new Error(`Unknown adapter: ${providerConfig.adapter}`);
  }
}

function sidecarOutcomeRecorder(config: OcxConfig, authCtx: CodexAuthContext): ((outcome: CodexUpstreamOutcome) => void) | undefined {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? outcome => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome)
    : undefined;
}

/** Account id to attribute log labels / upstream outcomes to (pool + rotation-injected main). */
function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}

function usesCodexForwardPoolAuth(
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): authCtx is Extract<CodexAuthContext, { kind: "pool" | "main-pool" }> {
  return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
    && provider.authMode === "forward" && provider.adapter === "openai-responses";
}

function codexForwardTerminalOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): ((status: ResponsesTerminalStatus) => void) | undefined {
  if (!usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
  return status => recordCodexUpstreamOutcome(config, authCtx.accountId, status === "completed" ? 200 : 502);
}

async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: {
    forceEmptyResponseId?: boolean;
    abortSignal?: AbortSignal;
    authContext?: CodexAuthContext;
    selectedForwardHeaders?: Headers;
    recordTerminalOutcomes?: boolean;
    setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus) => void) | undefined) => void;
    onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
    onNativePassthroughCancel?: () => void;
  } = {},
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
  logCtx.requestedModel = parsed.modelId;
  logCtx.requestedEffort = parsed.options.reasoning;
  logCtx.requestedServiceTier = parsed.options.serviceTier;
  logCtx.requestedSpeedLabel = requestLogSpeedLabel(parsed.options.serviceTier);
  logCtx.configuredServiceTier = readConfiguredCodexServiceTier();
  logCtx.configuredSpeedLabel = requestLogSpeedLabel(logCtx.configuredServiceTier);

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
  logCtx.modelSupportsServiceTier = catalogModelSupportsServiceTier(
    route.modelId,
    logCtx.requestedServiceTier ?? logCtx.configuredServiceTier,
  );

  let authCtx: CodexAuthContext;
  let selectedForwardHeaders: Headers;
  try {
    authCtx = options.authContext ?? await resolveCodexAuthContext(req.headers, config);
    selectedForwardHeaders = options.selectedForwardHeaders ?? headersForCodexAuthContext(req.headers, authCtx);
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) {
      return formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
    }
    if (err instanceof CodexThreadAffinityExpiredError) {
      return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = formatCodexProviderForLog(route.providerName, err.accountId, config);
      console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
      return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
    }
    throw err;
  }
  if (!isCodexAuthContextUsable(authCtx, config)) {
    return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
  }
  route.provider = applyCodexAuthContextToProvider(route.provider, authCtx);
  logCtx.provider = formatCodexProviderForLog(route.providerName, codexLogAccountId(authCtx), config);

  // OAuth providers: swap in a fresh access token (auto-refreshed) as the Bearer key, so the
  // existing openai-chat / anthropic adapters authenticate with no change.
  if (route.provider.authMode === "oauth") {
    try {
      route.provider = { ...route.provider, apiKey: await getValidAccessToken(route.providerName) };
      // Antigravity (cloud-code-assist) needs the discovered Cloud Code Assist project id in the
      // CCA envelope; the server injects only the bare token, so pull project from the credential.
      if (route.provider.googleMode === "cloud-code-assist" && !route.provider.project) {
        const projectId = getOAuthCredentialProjectId(route.providerName);
        if (projectId) route.provider = { ...route.provider, project: projectId };
      }
    } catch (err) {
      if (err instanceof UnsupportedOAuthProviderError) {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `${err.message}. Remove or reconfigure provider '${route.providerName}' in ${getConfigPath()}.`,
        );
      }
      return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Give it "eyes" —
  // describe each attached image with a gpt vision model via the ChatGPT passthrough and replace it
  // with text BEFORE the main call, so the text-only model can reason about it.
  const visionPlan = planVisionSidecar(config, route.provider, route.modelId, parsed, selectedForwardHeaders, authCtx);
  const recordSidecarOutcome = sidecarOutcomeRecorder(config, authCtx);
  if (visionPlan) {
    await describeImagesInPlace(parsed, visionPlan.forwardProvider, selectedForwardHeaders, visionPlan.settings, options.abortSignal, recordSidecarOutcome);
  }

  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  const adapter = resolveAdapter(adapterProvider);
  const recordTerminalOutcomes = options.recordTerminalOutcomes !== false;

  if ("passthrough" in adapter && adapter.passthrough) {
    const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
    // Abort the upstream if the client disconnects. A directly-relayed body does not propagate the
    // consumer's cancel to a signalled fetch, so we pass the signal and relay through relayWithAbort,
    // whose cancel() aborts the upstream — preventing leaked connections (RC2, passthrough path).
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);
    const connectMs = config.connectTimeoutMs ?? 100_000;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchWithHeaderTimeout(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }, upstream.signal, connectMs);
    } catch (err) {
      upstream.abort();
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
      if (usesCodexForwardPoolAuth(authCtx, route.provider)) recordCodexUpstreamOutcome(config, authCtx.accountId, outcome);
      const msg = outcome === "timeout"
        ? `Provider connect timeout after ${connectMs}ms`
        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return formatErrorResponse(502, "upstream_error", msg);
    }
    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
    const resolvedModel = headers.get("openai-model")?.trim();
    if (resolvedModel) logCtx.resolvedModel = resolvedModel;
    if (isUsageDebugEnabled()) {
      const upstreamContentType = upstreamResponse.headers.get("content-type");
      if (upstreamContentType) logCtx.usageDebugContentType = upstreamContentType;
    }
    // The chatgpt backend may omit Content-Type on SSE responses. Fall back to
    // treating a successful body as SSE when the caller requested streaming.
    const passthroughCt = headers.get("content-type")?.toLowerCase();
    const isEventStream = passthroughCt?.includes("text/event-stream")
      || (upstreamResponse.ok && !!upstreamResponse.body && !passthroughCt && parsed.stream);
    const terminalRecorder = codexForwardTerminalOutcomeRecorder(config, authCtx, route.provider);
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
    if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      const weeklyRaw = upstreamResponse.headers.get("x-codex-secondary-used-percent");
      const fiveHourRaw = upstreamResponse.headers.get("x-codex-primary-used-percent");
      const monthlyRaw = upstreamResponse.headers.get("x-codex-tertiary-used-percent");
      const weeklyResetRaw = upstreamResponse.headers.get("x-codex-secondary-reset-at");
      const fiveHourResetRaw = upstreamResponse.headers.get("x-codex-primary-reset-at");
      const monthlyResetRaw = upstreamResponse.headers.get("x-codex-tertiary-reset-at");
      const retryAfterRaw = upstreamResponse.headers.get("retry-after");
      if (weeklyRaw || fiveHourRaw || monthlyRaw) {
        const { updateAccountQuota } = await import("./codex-auth-api");
        updateAccountQuota(
          authCtx.accountId,
          weeklyRaw,
          fiveHourRaw,
          weeklyResetRaw,
          fiveHourResetRaw,
          monthlyRaw,
          monthlyResetRaw,
        );
      }
      if (terminalBodyWillRecord) {
        options.setTerminalOutcomeRecorder?.(status => {
          terminalRecorder(status);
          options.onNativePassthroughTerminal?.(status);
        });
      } else {
        recordCodexUpstreamOutcome(config, authCtx.accountId, upstreamResponse.status, {
          retryAfter: retryAfterRaw,
          resetAt: [fiveHourResetRaw, weeklyResetRaw, monthlyResetRaw],
        });
      }
    }

    // Bun#32111 workaround: passthrough SSE uses tee()+native relay to avoid the
    // async-pull segfault on Windows. Branch[0] goes directly to the Response (Bun
    // native relay, never enters JS Sink.write); branch[1] is consumed in the
    // background for terminal-outcome/quota inspection only.
    if (isEventStream && upstreamResponse.body) {
      const [nativeBody, inspectBody] = upstreamResponse.body.tee();
      const turnAc = new AbortController();
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc);
      if (recordTerminalOutcomes) {
        const reportNativeTerminal = (status: ResponsesTerminalStatus) => {
          if (options.abortSignal?.aborted) {
            options.onNativePassthroughCancel?.();
            return;
          }
          terminalRecorder?.(status);
          options.onNativePassthroughTerminal?.(status);
        };
        consumeForInspection(inspectBody, reportNativeTerminal, turnAc.signal, () => unregisterTurn(turnAc), logCtx);
      } else {
        consumeForResponseLogMetadata(inspectBody, logCtx, turnAc.signal, () => unregisterTurn(turnAc));
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      return markNativePassthroughSseResponse(new Response(nativeBody, {
        status: upstreamResponse.status,
        headers,
      }));
    }
    if (headers.get("content-type")?.toLowerCase().includes("application/json")) {
      const text = await upstreamResponse.text();
      inspectResponseLogJson(logCtx, text);
      return new Response(text, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    const tracked = body ? trackStreamLifetime(body, turnAc) : null;
    return new Response(tracked, {
      status: upstreamResponse.status,
      headers,
    });
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  const wsPlan = planWebSearch(config, parsed, false, selectedForwardHeaders, route.provider, route.modelId, authCtx);
  if (wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    return runWithWebSearch({
      parsed, adapter,
      forwardProvider: wsPlan.forwardProvider,
      hostedTool: wsPlan.hostedTool,
      selectedForwardHeaders,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
      recordSidecarOutcome,
    });
  }

  const upstream = new AbortController();
  const cleanupUpstreamAbort = linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 100_000;

  const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
  if (typeof request.usageLog?.inputTokens === "number") {
    logCtx.usageLogInputTokens = request.usageLog.inputTokens;
  }
  let upstreamResponse: Response;
  try {
    upstreamResponse = adapter.fetchResponse
      ? await adapter.fetchResponse(request, { abortSignal: upstream.signal, timeoutMs: connectMs })
      : await fetchWithHeaderTimeout(request.url, {
          method: request.method, headers: request.headers, body: request.body,
        }, upstream.signal, connectMs);
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    const msg = err instanceof Error && err.name === "TimeoutError"
      ? `Provider connect timeout after ${connectMs}ms`
      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return formatErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => "unknown error");
    cleanupUpstreamAbort();
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
    const bridgeTurnAc = new AbortController();
    const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, cleanupUpstreamAbort);
    return new Response(trackedSse, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (adapter.parseResponse) {
    let events: AdapterEvent[];
    try {
      events = await adapter.parseResponse(upstreamResponse);
    } finally {
      cleanupUpstreamAbort();
    }
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

export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => upstream.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export function disableResponsesRequestTimeout(req: Request, server: Pick<Server<WsData>, "timeout"> | undefined): boolean {
  if (!server) return false;
  try {
    server.timeout(req, 0);
    return true;
  } catch {
    return false;
  }
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

export interface RequestLogEntry {
  requestId: string;
  timestamp: number;
  model: string;
  provider: string;
  requestedModel?: string;
  requestedEffort?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  resolvedModel?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  terminalStatus?: ResponsesTerminalStatus;
  closeReason?: "terminal" | "client_cancel" | "non_stream";
  usageStatus: UsageStatus;
  usage?: OcxUsage;
  totalTokens?: number;
}

const requestLog: RequestLogEntry[] = [];
const MAX_LOG_SIZE = 200;
let requestLogSeq = 0;

function addRequestLog(entry: RequestLogEntry) {
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_SIZE) requestLog.shift();
  try {
    appendUsageEntry({
      requestId: entry.requestId,
      timestamp: entry.timestamp,
      provider: entry.provider,
      model: entry.model,
      ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
      status: entry.status,
      durationMs: entry.durationMs,
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    });
  } catch {
    /* request logging must never fail a user request */
  }
}

export function nextRequestLogId(timestamp = Date.now()): string {
  requestLogSeq = (requestLogSeq % 1_000_000) + 1;
  return `ocx-${timestamp.toString(36)}-${requestLogSeq.toString(36)}`;
}

export function requestLogErrorCode(status: number): string | undefined {
  if (status >= 200 && status < 400) return undefined;
  if (status === 400 || status === 409) return "invalid_request_error";
  if (status === 401 || status === 403) return "invalid_api_key";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 499) return "client_closed_request";
  if (status === 503) return "server_is_overloaded";
  if (status >= 500) return "upstream_server_error";
  return `http_${status}`;
}

export function requestLogSpeedLabel(serviceTier: string | undefined): string | undefined {
  const normalized = serviceTier?.trim().toLowerCase();
  if (normalized === "priority" || normalized === "fast") return "fast";
  return undefined;
}

function readConfiguredCodexServiceTier(): string | undefined {
  try {
    if (!existsSync(CODEX_CONFIG_PATH)) return undefined;
    return readRootTomlString(readFileSync(CODEX_CONFIG_PATH, "utf-8"), "service_tier") ?? undefined;
  } catch {
    return undefined;
  }
}

function catalogModelSupportsServiceTier(modelId: string, serviceTier: string | undefined): boolean | undefined {
  if (!serviceTier) return undefined;
  const requestTier = serviceTier.trim().toLowerCase() === "fast" ? "priority" : serviceTier.trim();
  try {
    const catalogPath = readCodexCatalogPath();
    if (!existsSync(catalogPath)) return undefined;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as { models?: unknown };
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const entry = models.find(model => {
      if (!model || typeof model !== "object") return false;
      return (model as { slug?: unknown; id?: unknown }).slug === modelId
        || (model as { slug?: unknown; id?: unknown }).id === modelId;
    });
    if (!entry || typeof entry !== "object") return undefined;
    const tiers = (entry as { service_tiers?: unknown }).service_tiers;
    return Array.isArray(tiers) && tiers.some(tier => (
      tier && typeof tier === "object" && (tier as { id?: unknown }).id === requestTier
    ));
  } catch {
    return undefined;
  }
}

function applyResponseLogMetadata(logCtx: RequestLogContext, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const source = "response" in payload && typeof (payload as { response?: unknown }).response === "object"
    ? (payload as { response?: unknown }).response
    : payload;
  if (!source || typeof source !== "object") return;
  const model = (source as { model?: unknown }).model;
  if (typeof model === "string" && model.trim()) logCtx.resolvedModel = model;
  const serviceTier = (source as { service_tier?: unknown }).service_tier;
  if (typeof serviceTier === "string" && serviceTier.trim()) logCtx.responseServiceTier = serviceTier;
  const usage = usageFromResponsesPayload((source as { usage?: unknown }).usage);
  if (usage) logCtx.usage = usage;
}

export function usageFromResponsesPayload(usage: unknown): OcxUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
    total_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  if (typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number") {
    return {
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.input_tokens_details?.cached_tokens === "number"
        ? { cachedInputTokens: raw.input_tokens_details.cached_tokens }
        : {}),
      ...(typeof raw.output_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.output_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  if (typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number") {
    return {
      inputTokens: raw.prompt_tokens,
      outputTokens: raw.completion_tokens,
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.prompt_tokens_details?.cached_tokens === "number"
        ? { cachedInputTokens: raw.prompt_tokens_details.cached_tokens }
        : {}),
      ...(typeof raw.completion_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.completion_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  return undefined;
}

function inspectResponseLogJson(logCtx: RequestLogContext, text: string): void {
  try {
    applyResponseLogMetadata(logCtx, JSON.parse(text));
  } catch {
    /* body may not be JSON; request log metadata is best-effort only */
  }
  if (isUsageDebugEnabled() && logCtx.usageDebugBodyKind === undefined) {
    logCtx.usageDebugBodyKind = "json";
    logCtx.usageDebugBodySample = truncateForDebug(text);
  }
}

function inspectResponseLogSsePayload(logCtx: RequestLogContext, payload: string | null): void {
  if (!payload || payload.trim() === "[DONE]") return;
  const debugEnabled = isUsageDebugEnabled();
  const sseAlreadyMarked = logCtx.usageDebugBodyKind === "sse";
  try {
    applyResponseLogMetadata(logCtx, JSON.parse(payload));
  } catch {
    /* SSE block payload may not be JSON; metadata inspection is best-effort */
  }
  if (debugEnabled) {
    if (!sseAlreadyMarked) {
      logCtx.usageDebugBodyKind = "sse";
      logCtx.usageDebugBodySample = truncateForDebug(payload);
    } else if (typeof logCtx.usageDebugBodySample === "string"
      && logCtx.usageDebugBodySample.length < USAGE_DEBUG_BODY_SAMPLE_BYTES) {
      const combined = `${logCtx.usageDebugBodySample}\n${payload}`;
      logCtx.usageDebugBodySample = truncateForDebug(combined);
    }
  }
}

function httpStatusForTerminalStatus(status: ResponsesTerminalStatus): number {
  return status === "completed" ? 200 : 502;
}

function addFinalRequestLog(
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  status: number,
  meta?: Pick<RequestLogEntry, "terminalStatus" | "closeReason">,
  addLog: (entry: RequestLogEntry) => void = addRequestLog,
): void {
  const errorCode = requestLogErrorCode(status);
  const finalUsage = usageForFinalLog(logCtx.provider, logCtx.usage);
  const usageFallback = !finalUsage && typeof logCtx.usageLogInputTokens === "number"
    ? { inputTokens: logCtx.usageLogInputTokens, outputTokens: 0, estimated: true }
    : undefined;
  const loggedUsage = finalUsage && typeof logCtx.usageLogInputTokens === "number"
    ? { ...finalUsage, inputTokens: Math.max(finalUsage.inputTokens, logCtx.usageLogInputTokens) }
    : (finalUsage ?? usageFallback);
  const usageStatus = usageStatusForFinalLog(loggedUsage);
  const totalTokens = usageTotalTokens(loggedUsage);
  addLog({
    requestId,
    timestamp: start,
    model: logCtx.model,
    provider: logCtx.provider,
    ...(logCtx.requestedModel ? { requestedModel: logCtx.requestedModel } : {}),
    ...(logCtx.requestedEffort ? { requestedEffort: logCtx.requestedEffort } : {}),
    ...(logCtx.requestedServiceTier ? { requestedServiceTier: logCtx.requestedServiceTier } : {}),
    ...(logCtx.requestedSpeedLabel ? { requestedSpeedLabel: logCtx.requestedSpeedLabel } : {}),
    ...(logCtx.configuredServiceTier ? { configuredServiceTier: logCtx.configuredServiceTier } : {}),
    ...(logCtx.configuredSpeedLabel ? { configuredSpeedLabel: logCtx.configuredSpeedLabel } : {}),
    ...(logCtx.modelSupportsServiceTier !== undefined ? { modelSupportsServiceTier: logCtx.modelSupportsServiceTier } : {}),
    ...(logCtx.responseServiceTier ? { responseServiceTier: logCtx.responseServiceTier } : {}),
    ...(logCtx.resolvedModel ? { resolvedModel: logCtx.resolvedModel } : {}),
    status,
    durationMs: Date.now() - start,
    ...(errorCode ? { errorCode } : {}),
    ...(meta?.terminalStatus ? { terminalStatus: meta.terminalStatus } : {}),
    ...(meta?.closeReason ? { closeReason: meta.closeReason } : {}),
    usageStatus,
    ...(loggedUsage ? { usage: loggedUsage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  });
  if (isUsageDebugEnabled()) {
    appendUsageDebug({
      ts: Date.now(),
      requestId,
      provider: logCtx.provider,
      model: logCtx.model,
      upstreamContentType: logCtx.usageDebugContentType ?? null,
      upstreamStatus: status,
      bodyKind: logCtx.usageDebugBodyKind ?? "none",
      bodySample: logCtx.usageDebugBodySample ?? "",
      extractedUsage: loggedUsage ?? null,
    });
  }
}

export function filterRequestLogs(logs: RequestLogEntry[], params: URLSearchParams): RequestLogEntry[] {
  let filtered = logs;
  const provider = params.get("provider")?.trim();
  if (provider) filtered = filtered.filter(entry => entry.provider === provider);
  const status = params.get("status")?.trim().toLowerCase();
  if (status) {
    filtered = /^[1-5]xx$/.test(status)
      ? filtered.filter(entry => Math.floor(entry.status / 100) === Number(status[0]))
      : filtered.filter(entry => String(entry.status) === status);
  }
  const tailRaw = params.get("tail")?.trim();
  if (tailRaw) {
    const tail = Number.parseInt(tailRaw, 10);
    if (Number.isFinite(tail) && tail > 0) filtered = filtered.slice(-Math.min(tail, MAX_LOG_SIZE));
  }
  return filtered;
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

function nextSseBlock(buffer: string): { block: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  return {
    block: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  };
}

function sseDataPayload(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length > 0 ? data.join("\n") : null;
}

function terminalStatusFromSsePayload(payload: string): ResponsesTerminalStatus | null {
  if (payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload) as { type?: unknown };
    switch (json.type) {
      case "response.completed":
        return "completed";
      case "response.failed":
        return "failed";
      case "response.incomplete":
        return "incomplete";
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function trackSseForRequestLog(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus) => void,
  onCancel: () => void,
  logCtx?: RequestLogContext,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalReported = false;

  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported) return;
    terminalReported = true;
    onTerminal(status);
  };

  const inspectPayload = (payload: string | null) => {
    if (!payload) return;
    if (logCtx) inspectResponseLogSsePayload(logCtx, payload);
    const status = terminalStatusFromSsePayload(payload);
    if (status) reportTerminal(status);
  };

  const inspectChunk = (value: Uint8Array) => {
    buffer += decoder.decode(value, { stream: true });
    let next: { block: string; rest: string } | null;
    while ((next = nextSseBlock(buffer))) {
      buffer = next.rest;
      inspectPayload(sseDataPayload(next.block));
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) inspectPayload(sseDataPayload(buffer));
          if (!terminalReported) reportTerminal("incomplete");
          controller.close();
          return;
        }
        inspectChunk(value);
        controller.enqueue(value);
      } catch (err) {
        if (!terminalReported) reportTerminal("incomplete");
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      onCancel();
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function responseWithDeferredRequestLog(
  response: Response,
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  addLog: (entry: RequestLogEntry) => void = addRequestLog,
): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (isUsageDebugEnabled() && !logCtx.usageDebugContentType && contentType) {
    logCtx.usageDebugContentType = contentType;
  }
  if (isNativePassthroughSseResponse(response)) {
    return response;
  }
  if (!response.body || !contentType.includes("text/event-stream")) {
    if (response.body && contentType.includes("application/json")) {
      const finalizeJsonLog = async () => {
        const text = await response.text();
        inspectResponseLogJson(logCtx, text);
        addFinalRequestLog(requestId, start, logCtx, response.status, { closeReason: "non_stream" }, addLog);
        return text;
      };
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(new TextEncoder().encode(await finalizeJsonLog()));
            controller.close();
          } catch (err) {
            addFinalRequestLog(requestId, start, logCtx, 502, { closeReason: "non_stream" }, addLog);
            try { controller.error(err); } catch { /* already torn down */ }
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    if (isUsageDebugEnabled() && logCtx.usageDebugBodyKind === undefined) {
      logCtx.usageDebugBodyKind = response.body ? "other" : "none";
    }
    addFinalRequestLog(requestId, start, logCtx, response.status, { closeReason: "non_stream" }, addLog);
    return response;
  }

  let logged = false;
  const body = trackSseForRequestLog(
    response.body,
    status => {
      if (logged) return;
      logged = true;
      addFinalRequestLog(requestId, start, logCtx, httpStatusForTerminalStatus(status), {
        terminalStatus: status,
        closeReason: "terminal",
      }, addLog);
    },
    () => {
      if (logged) return;
      logged = true;
      addFinalRequestLog(requestId, start, logCtx, 499, { closeReason: "client_cancel" }, addLog);
    },
    logCtx,
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function markNativePassthroughSseResponse(response: Response): Response {
  nativePassthroughSseResponses.add(response);
  return response;
}

function isNativePassthroughSseResponse(response: Response): boolean {
  return nativePassthroughSseResponses.has(response);
}

export function relaySseWithHeartbeat(
  body: ReadableStream<Uint8Array> | null,
  upstream: AbortController,
  heartbeatMs = 15_000,
  onTerminal?: (status: ResponsesTerminalStatus) => void,
  options?: { onStart?: () => void; onDone?: () => void },
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const heartbeat = new TextEncoder().encode(": opencodex keepalive\n\n");
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let clientCancelled = false;
  let terminalReported = false;
  let buffer = "";

  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported || clientCancelled || closed) return;
    terminalReported = true;
    onTerminal?.(status);
  };

  const inspectPayload = (payload: string | null) => {
    if (!payload) return;
    const status = terminalStatusFromSsePayload(payload);
    if (status) reportTerminal(status);
  };

  const inspectChunk = (value: Uint8Array) => {
    buffer += decoder.decode(value, { stream: true });
    let next: { block: string; rest: string } | null;
    while ((next = nextSseBlock(buffer))) {
      buffer = next.rest;
      inspectPayload(sseDataPayload(next.block));
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    options?.onDone?.();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      options?.onStart?.();
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
          buffer += decoder.decode();
          if (buffer.trim()) inspectPayload(sseDataPayload(buffer));
          if (!terminalReported && !clientCancelled) reportTerminal("incomplete");
          cleanup();
          controller.close();
          return;
        }
        inspectChunk(value);
        controller.enqueue(value);
      } catch (err) {
        if (!clientCancelled) reportTerminal("incomplete");
        cleanup();
        try { controller.error(err); } catch { /* already torn down */ }
      }
    },
    cancel(reason) {
      clientCancelled = true;
      cleanup();
      upstream.abort(reason);
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Background-consume an SSE stream purely for terminal-outcome inspection (quota tracking).
 * Does not produce output; safe to ignore errors (the client-facing stream is separate).
 */
function consumeForInspection(
  body: ReadableStream<Uint8Array>,
  onTerminal: (status: ResponsesTerminalStatus) => void,
  signal?: AbortSignal,
  onDone?: () => void,
  logCtx?: RequestLogContext,
): void {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reported = false;
  let cancelled = false;
  if (signal) {
    if (signal.aborted) {
      cancelled = true;
      reader.cancel(signal.reason).catch(() => {});
      return;
    }
    signal.addEventListener("abort", () => {
      cancelled = true;
      reader.cancel(signal.reason).catch(() => {});
    }, { once: true });
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim() && !reported) {
            const payload = sseDataPayload(buffer);
            if (logCtx) inspectResponseLogSsePayload(logCtx, payload);
            if (payload) {
              const status = terminalStatusFromSsePayload(payload);
              if (status) { reported = true; onTerminal(status); }
            }
          }
          if (!reported && !cancelled) onTerminal("incomplete");
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let next: { block: string; rest: string } | null;
        while ((next = nextSseBlock(buffer))) {
          buffer = next.rest;
          if (!reported) {
            const payload = sseDataPayload(next.block);
            if (logCtx) inspectResponseLogSsePayload(logCtx, payload);
            if (payload) {
              const status = terminalStatusFromSsePayload(payload);
              if (status) { reported = true; onTerminal(status); }
            }
          }
        }
      }
    } catch {
      if (!reported && !cancelled) onTerminal("incomplete");
    } finally {
      onDone?.();
    }
  };
  pump();
}

function consumeForResponseLogMetadata(
  body: ReadableStream<Uint8Array>,
  logCtx: RequestLogContext,
  signal?: AbortSignal,
  onDone?: () => void,
): void {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  if (signal) {
    if (signal.aborted) {
      reader.cancel(signal.reason).catch(() => {});
      onDone?.();
      return;
    }
    signal.addEventListener("abort", () => {
      reader.cancel(signal.reason).catch(() => {});
    }, { once: true });
  }
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) inspectResponseLogSsePayload(logCtx, sseDataPayload(buffer));
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let next: { block: string; rest: string } | null;
        while ((next = nextSseBlock(buffer))) {
          buffer = next.rest;
          inspectResponseLogSsePayload(logCtx, sseDataPayload(next.block));
        }
      }
    } catch {
      /* metadata inspection must not affect the client-facing stream */
    } finally {
      onDone?.();
    }
  };
  pump();
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
    "set-cookie",
    "set-cookie2",
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
function configuredPort(): string {
  try { return new URL(_corsOrigin).port; } catch { return "10100"; }
}

function parseHttpHost(value: string | null): { hostname: string; port: string } | null {
  if (!value) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return null;
  }
}

function isLoopbackRequestHost(value: string | null): boolean {
  const parsed = parseHttpHost(value);
  if (!parsed) return true;
  if (!isLoopbackHostname(parsed.hostname)) return false;
  return parsed.port === "" || parsed.port === configuredPort();
}

function isLoopbackOriginValue(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") return false;
    if (!isLoopbackHostname(parsed.hostname)) return false;
    return parsed.port === configuredPort();
  } catch {
    return false;
  }
}

function isSameOriginAsRequest(req: Request, origin: string): boolean {
  try {
    return origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

function isAllowedRequestOrigin(req: Request, config: OcxConfig): boolean {
  const origin = req.headers.get("Origin");
  if (!isApiAuthRequired(config)) {
    if (!isLoopbackRequestHost(req.headers.get("Host"))) return false;
    return !origin || isLoopbackOriginValue(origin);
  }
  return !origin || isLoopbackOriginValue(origin) || isSameOriginAsRequest(req, origin);
}

export function corsHeaders(req?: Request, config?: OcxConfig): Record<string, string> {
  const origin = req?.headers.get("Origin");
  const allowOrigin = origin && req && config && isAllowedRequestOrigin(req, config) ? origin : _corsOrigin;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-OpenCodex-API-Key",
    "Vary": "Origin",
  };
}

function withCors(response: Response, req: Request, config: OcxConfig): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(req, config))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data: unknown, status = 200, req?: Request, config?: OcxConfig): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req, config) },
  });
}

function configuredApiAuthToken(_config: OcxConfig): string | undefined {
  const token = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  return token || undefined;
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function isApiAuthRequired(config: OcxConfig): boolean {
  return !isLoopbackHostname(config.hostname);
}

export function assertServerAuthConfig(config: OcxConfig): void {
  if (isApiAuthRequired(config) && !configuredApiAuthToken(config)) {
    throw new Error("OPENCODEX_API_AUTH_TOKEN is required when binding opencodex to a non-loopback hostname");
  }
}

export function hasValidApiAuth(req: Request, config: OcxConfig): boolean {
  if (!isApiAuthRequired(config)) return true;
  const expected = configuredApiAuthToken(config);
  const actual = req.headers.get("x-opencodex-api-key")?.trim();
  if (!expected || !actual) return false;
  const enc = new TextEncoder();
  const expectedBytes = enc.encode(expected);
  const actualBytes = enc.encode(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requireApiAuth(req: Request, config: OcxConfig, kind: "management" | "data-plane"): Response | null {
  if (hasValidApiAuth(req, config)) return null;
  if (kind === "management") return jsonResponse({ error: "opencodex API key required" }, 401);
  return formatErrorResponse(401, "authentication_error", "opencodex API key required");
}

function providerManagementConfigError(name: string, provider: OcxProviderConfig): string | null {
  const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
  if (baseUrlError) return `provider ${name} ${baseUrlError}`;
  const headersError = providerHeadersConfigError(provider.headers);
  if (headersError) return `provider ${name} ${headersError}`;
  if (provider.authMode === "forward") {
    const normalizedName = name.trim().toLowerCase();
    const base = provider.baseUrl.replace(/\/+$/, "");
    const isBuiltInChatGptForward = (normalizedName === "openai" || normalizedName === "chatgpt")
      && provider.adapter === "openai-responses"
      && base === "https://chatgpt.com/backend-api/codex";
    if (isBuiltInChatGptForward) return null;
    return `provider ${name} uses reserved authMode "forward"; configure ChatGPT passthrough via the built-in provider`;
  }
  return null;
}

function publicProviderBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "(invalid URL)";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, baseUrl.endsWith("/") ? "/" : "");
  } catch {
    return "(invalid URL)";
  }
}

function copyIfDefined<K extends keyof OcxProviderConfig>(
  out: Record<string, unknown>,
  provider: OcxProviderConfig,
  key: K,
): void {
  const value = provider[key];
  if (value !== undefined) out[key as string] = value as unknown;
}

export function safeConfigDTO(config: OcxConfig): unknown {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [name, provider] of Object.entries(config.providers)) {
    const dto: Record<string, unknown> = {
      adapter: provider.adapter,
      baseUrl: publicProviderBaseUrl(provider.baseUrl),
      hasApiKey: !!provider.apiKey,
      hasHeaders: !!provider.headers && Object.keys(provider.headers).length > 0,
    };
    for (const key of [
      "defaultModel",
      "disabled",
      "authMode",
      "liveModels",
      "models",
      "contextWindow",
      "modelContextWindows",
      "reasoningEfforts",
      "modelReasoningEfforts",
      "noVisionModels",
      "noReasoningModels",
      "noTemperatureModels",
      "noTopPModels",
      "noPenaltyModels",
      "autoToolChoiceOnlyModels",
      "preserveReasoningContentModels",
      "escapeBuiltinToolNames",
    ] as const) {
      copyIfDefined(dto, provider, key);
    }
    providers[name] = dto;
  }
  return {
    port: config.port,
    hostname: config.hostname ?? "127.0.0.1",
    defaultProvider: config.defaultProvider,
    codexAutoStart: codexAutoStartEnabled(config),
    websockets: config.websockets,
    providers,
  };
}

async function handleManagementAPI(req: Request, url: URL, config: OcxConfig): Promise<Response | null> {
  if (!isAllowedRequestOrigin(req, config)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403, req, config);
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
    return jsonResponse(safeConfigDTO(config));
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
    return jsonResponse(filterRequestLogs(requestLog, url.searchParams));
  }

  if (url.pathname === "/api/usage" && req.method === "GET") {
    const range = parseRange(url.searchParams.get("range"));
    const now = Date.now();
    try {
      return jsonResponse(summarizeUsage(readUsageEntries(), range, now));
    } catch {
      return jsonResponse({
        range,
        since: null,
        generatedAt: now,
        summary: {
          requests: 0,
          reportedRequests: 0,
          unreportedRequests: 0,
          unsupportedRequests: 0,
          estimatedRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          coverageRatio: 0,
        },
        days: [],
        models: [],
        providers: [],
        error: "read_failed",
      });
    }
  }

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
      name, adapter: p.adapter, baseUrl: publicProviderBaseUrl(p.baseUrl), defaultModel: p.defaultModel,
      hasApiKey: !!p.apiKey,
      disabled: p.disabled === true,
    })));
  }

  // Add (or overwrite) a single provider. Merges into the live in-memory config and
  // persists — existing providers' real keys are never round-tripped (unlike PUT /api/config,
  // which would re-save the masked keys from GET). Live routing picks it up immediately.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: string; provider?: OcxProviderConfig; setDefault?: boolean };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = body.name?.trim();
    const prov = body.provider ? stripCodexRuntimeProviderFields(body.provider) : undefined;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    if (!isValidProviderName(name)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    const providerError = providerManagementConfigError(name, prov);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    enrichProviderFromCatalog(name, prov);
    const { saveConfig: save } = await import("./config");
    config.providers[name] = prov;
    if (body.setDefault) config.defaultProvider = name;
    save(config);
    const { clearModelCache } = await import("./model-cache");
    clearModelCache(name);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, name });
  }

  if (url.pathname === "/api/providers" && req.method === "PATCH") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    let body: { disabled?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (typeof body.disabled !== "boolean") return jsonResponse({ error: "disabled boolean is required" }, 400);
    if (body.disabled && name === config.defaultProvider) {
      return jsonResponse({ error: "cannot disable the default provider; set another default first" }, 400);
    }
    const { saveConfig: save } = await import("./config");
    config.providers[name] = { ...config.providers[name], disabled: body.disabled };
    save(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, name, disabled: body.disabled });
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (name === config.defaultProvider) return jsonResponse({ error: "cannot delete the default provider; set another default first" }, 400);
    const { saveConfig: save } = await import("./config");
    delete config.providers[name];
    setProviderContextCap(config, name, false);
    save(config);
    const { clearModelCache: clearCache } = await import("./model-cache");
    clearCache(name);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    return jsonResponse(models.map(m => {
      const namespaced = `${m.provider}/${m.id}`;
      const contextCap = providerContextCap(config, m.provider);
      return {
        ...m,
        namespaced,
        disabled: disabled.has(namespaced),
        ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
      };
    }));
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
    return jsonResponse({ cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config) });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "PUT") {
    let body: { provider?: unknown; enabled?: unknown; value?: unknown; setAll?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { saveConfig: save } = await import("./config");
    const { clearModelCache } = await import("./model-cache");
    const respond = () => jsonResponse({ ok: true, cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config) });

    // Branch 1: set the global cap value and re-point every enabled provider to it.
    if (body.value !== undefined) {
      if (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value <= 0) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      const affected = Object.keys(providerContextCaps(config));
      setGlobalContextCapValue(config, body.value);
      save(config);
      for (const provider of affected) clearModelCache(provider);
      await refreshCodexCatalogBestEffort();
      return respond();
    }

    // Branch 2: enable/clear the cap for every provider at once.
    if (body.setAll !== undefined) {
      if (typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const before = Object.keys(providerContextCaps(config));
      const names = Object.keys(config.providers);
      setAllProviderContextCaps(config, names, body.setAll);
      save(config);
      for (const provider of new Set([...before, ...names])) clearModelCache(provider);
      await refreshCodexCatalogBestEffort();
      return respond();
    }

    // Branch 3: existing per-provider toggle (enable writes the current global value).
    if (typeof body.provider !== "string" || typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "provider string and enabled boolean are required" }, 400);
    }
    const provider = body.provider.trim();
    if (!isValidProviderName(provider)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    if (!hasOwnProvider(config.providers, provider)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    setProviderContextCap(config, provider, body.enabled);
    save(config);
    clearModelCache(provider);
    await refreshCodexCatalogBestEffort();
    return respond();
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
    setTimeout(async () => {
      await drainAndShutdown(undefined, config.shutdownTimeoutMs ?? 5000);
      process.exit(0);
    }, 200);
    return jsonResponse({ success: true, message: "Proxy stopping, native Codex restored." });
  }

  if (url.pathname.startsWith("/api/codex-auth/")) {
    const { handleCodexAuthAPI } = await import("./codex-auth-api");
    return handleCodexAuthAPI(req, url, config);
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
  assertServerAuthConfig(config);
  // Refresh OAuth provider presets (models/noReasoningModels) from the registry so a proxy update
  // adding/dropping models reaches existing configs on start — not just fresh installs.
  reconcileOAuthProviders(config);
  // Ensure the ChatGPT passthrough provider exists so gpt-* models route correctly.
  if (!config.providers["chatgpt"]) {
    upsertOAuthProvider(config, "chatgpt");
    saveConfig(config);
  }
  // Seed default featured subagent models on first run only (UNSET → defaults). A user-set list,
  // even [], is left alone so GUI removals persist.
  if (config.subagentModels === undefined) {
    config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
    saveConfig(config);
  }
  invalidateCodexModelsCache();

  const listenPort = port ?? config.port ?? 10100;
  setCorsOrigin(listenPort);

  const server: Server<WsData> = Bun.serve<WsData>({
    port: listenPort,
    hostname: config.hostname ?? "127.0.0.1",
    idleTimeout: 255,
    async fetch(req, requestServer): Promise<Response> {
      const url = new URL(req.url);
      markActivity(`${req.method} ${url.pathname}`);

      if (req.method === "OPTIONS") {
        if (!isAllowedRequestOrigin(req, config)) {
          return new Response(null, { status: 403, headers: corsHeaders() });
        }
        return new Response(null, { status: 204, headers: corsHeaders(req, config) });
      }

      // Responses WebSocket (phase 120.2). Codex upgrades the same /v1/responses path; auth is
      // handshake-time only, so capture inbound headers and thread them into the pipeline.
      if (url.pathname === "/v1/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (draining) {
          return new Response("Service shutting down", { status: 503, headers: { ...corsHeaders(req, config), "Retry-After": "5" } });
        }
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin"), req, config);
        }
        let authCtx: CodexAuthContext;
        try {
          authCtx = await resolveCodexAuthContext(req.headers, config);
        } catch (err) {
          if (err instanceof CodexAccountCooldownError) {
            return withCors(formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down"), req, config);
          }
          if (err instanceof CodexThreadAffinityExpiredError) {
            return withCors(formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session"), req, config);
          }
          if (err instanceof CodexAuthContextError) {
            const safeAccountLabel = formatCodexProviderForLog("chatgpt", err.accountId, config);
            console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed during websocket upgrade; reauthentication required`);
            return withCors(formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"), req, config);
          }
          throw err;
        }
        if (server.upgrade(req, {
          data: {
            headers: selectForwardHeaders(req.headers),
            authContext: authCtx,
          },
        })) return undefined as unknown as Response;
        return withCors(formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed"), req, config);
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        return jsonResponse({ status: "ok", version: VERSION, uptime: process.uptime() }, 200, req, config);
      }

      if (url.pathname.startsWith("/api/")) {
        const apiAuthError = requireApiAuth(req, config, "management");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        const mgmtResponse = await handleManagementAPI(req, url, config);
        if (mgmtResponse) return withCors(mgmtResponse, req, config);
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, config);
        }
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
          return jsonResponse({ models: buildCatalogEntries(loadCatalogTemplate(), nativeSlugs, goOrdered, config.subagentModels, websocketsEnabled(config)) }, 200, req, config);
        }
        // OpenAI list shape: native gpt bare + routed models namespaced "<provider>/<id>"
        const data = [
          ...nativeSlugs.map(id => ({ id, object: "model", created: 0, owned_by: "openai" })),
          ...goOrdered.map(m => ({ id: `${m.provider}/${m.id}`, object: "model", created: 0, owned_by: m.owned_by ?? m.provider })),
        ];
        return jsonResponse({ object: "list", data }, 200, req, config);
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
        disableResponsesRequestTimeout(req, requestServer);
        if (draining) {
          return new Response("Service shutting down", { status: 503, headers: { ...corsHeaders(req, config), "Retry-After": "5" } });
        }
        const apiAuthError = requireApiAuth(req, config, "data-plane");
        if (apiAuthError) return withCors(apiAuthError, req, config);
        if (!isAllowedRequestOrigin(req, config)) {
          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, config);
        }
        const start = Date.now();
        const requestId = nextRequestLogId(start);
        const logCtx = { model: "unknown", provider: "unknown" };
        let logged = false;
        const finalizeNativePassthroughLog = (
          status: number,
          meta: { terminalStatus?: ResponsesTerminalStatus; closeReason: "terminal" | "client_cancel" },
        ) => {
          if (logged) return;
          logged = true;
          addFinalRequestLog(requestId, start, logCtx, status, meta);
        };
        const response = await handleResponses(req, config, logCtx, {
          abortSignal: req.signal,
          onNativePassthroughTerminal: status => {
            finalizeNativePassthroughLog(httpStatusForTerminalStatus(status), {
              terminalStatus: status,
              closeReason: "terminal",
            });
          },
          onNativePassthroughCancel: () => {
            finalizeNativePassthroughLog(499, { closeReason: "client_cancel" });
          },
        });
        return withCors(responseWithDeferredRequestLog(response, requestId, start, logCtx), req, config);
      }

      const guiFile = serveGuiFile(url.pathname);
      if (guiFile) return guiFile;
      if (url.pathname === "/" && req.method === "GET") {
        return jsonResponse(rootFallbackPayload());
      }

      return withCors(formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`), req, config);
    },
    websocket: {
      idleTimeout: WEBSOCKET_IDLE_TIMEOUT_SECONDS,
      // Responses WebSocket data plane (phase 120.2). Re-frames the same SSE pipeline onto the
      // socket: parse response.create → run handleResponses unchanged → pump its SSE body as WS
      // Text frames. response.processed is a no-op ack. close() aborts the upstream (RC2 parity).
      open(ws: ServerWebSocket<WsData>) {
        registerCodexWebSocket(ws);
      },
      message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        const rawBytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
        if (rawBytes > MAX_WS_FRAME_BYTES) {
          sendJsonFrame(ws, buildWsErrorFrame(413, {
            type: "invalid_request_error",
            message: "WebSocket response.create frame is too large",
          }));
          ws.close(1009, "message too large");
          return;
        }
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<string, unknown>;
        } catch {
          return; // text-only contract; ignore unparseable frames
        }
        if (frame.type === "response.processed") return; // ack — no-op
        if (frame.type !== "response.create") return;
        markActivity("ws response.create");

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
        registerTurn(turnAbort);
        void (async () => {
          const start = Date.now();
          const requestId = nextRequestLogId(start);
          const logCtx = { model: "unknown", provider: "unknown" };
          let logged = false;
          const finalizeLog = (status: number) => {
            if (logged) return;
            logged = true;
            addFinalRequestLog(requestId, start, logCtx, status);
          };
          const baseHeaders = ws.data.headers ?? new Headers();
          let authCtx: CodexAuthContext;
          let selectedForwardHeaders: Headers;
          try {
            authCtx = await resolveCodexAuthContext(baseHeaders, config);
            selectedForwardHeaders = headersForCodexAuthContext(baseHeaders, authCtx);
            updateCodexWebSocketAuthContext(ws, authCtx);
          } catch (err) {
            if (!isCurrent()) return;
            if (err instanceof CodexAccountCooldownError) {
              finalizeLog(429);
              sendJsonFrame(ws, buildWsErrorFrame(429, {
                type: "rate_limit_error",
                message: "Selected Codex account is cooling down",
              }));
              return;
            }
            if (err instanceof CodexThreadAffinityExpiredError) {
              finalizeLog(409);
              sendJsonFrame(ws, buildWsErrorFrame(409, {
                type: "invalid_request_error",
                message: "Codex thread account affinity expired; start a new session",
              }));
              return;
            }
            if (err instanceof CodexAuthContextError) {
              const safeAccountLabel = formatCodexProviderForLog("chatgpt", err.accountId, config);
              console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed during websocket turn; reauthentication required`);
              finalizeLog(401);
              sendJsonFrame(ws, buildWsErrorFrame(401, {
                type: "authentication_error",
                message: "Selected Codex account needs reauthentication",
              }));
              return;
            }
            finalizeLog(502);
            sendJsonFrame(ws, buildWsErrorFrame(502, {
              type: "proxy_error",
              message: err instanceof Error ? err.message : String(err),
            }));
            return;
          }
          const fwd = new Headers({ "content-type": "application/json" });
          selectedForwardHeaders.forEach((value, key) => fwd.set(key, value));
          const req = new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: fwd,
            body: JSON.stringify({ ...payload, stream: true }),
          });
          try {
            let terminalRecorder: ((status: ResponsesTerminalStatus) => void) | undefined;
            const response = await handleResponses(req, config, logCtx, {
              forceEmptyResponseId: true,
              abortSignal: turnAbort.signal,
              authContext: authCtx,
              selectedForwardHeaders,
              recordTerminalOutcomes: false,
              setTerminalOutcomeRecorder: recorder => {
                terminalRecorder = recorder;
              },
            });
            await sendResponseToWebSocket(ws, response, isCurrent, {
              onTerminal: status => {
                terminalRecorder?.(status);
                finalizeLog(httpStatusForTerminalStatus(status));
              },
            });
            if (!logged) finalizeLog(turnAbort.signal.aborted ? 499 : response.status);
          } catch (err) {
            if (!isCurrent()) return;
            try {
              if (err instanceof CodexAccountCooldownError) {
                finalizeLog(429);
                sendJsonFrame(ws, buildWsErrorFrame(429, {
                  type: "rate_limit_error",
                  message: "Selected Codex account is cooling down",
                }));
                return;
              }
              finalizeLog(502);
              sendJsonFrame(ws, buildWsErrorFrame(502, {
                type: "proxy_error",
                message: err instanceof Error ? err.message : String(err),
              }));
            } catch {
              /* socket already gone or send dropped */
            }
          } finally {
            unregisterTurn(turnAbort);
            if (!logged && turnAbort.signal.aborted) finalizeLog(499);
            if (ws.data.cancel === cancelTurn) ws.data.cancel = undefined;
          }
        })();
      },
      close(ws: ServerWebSocket<WsData>) {
        unregisterCodexWebSocket(ws);
        ws.data.cancel?.(); // RC2: abort the upstream when the client disconnects
      },
    },
  });

  _serverRef = server;
  const actualPort = server.port ?? listenPort;
  setCorsOrigin(actualPort);

  console.log(`🚀 opencodex proxy running on http://localhost:${actualPort}`);
  console.log(`   POST /v1/responses → provider translation`);
  console.log(`   GET  /healthz      → health check`);
  console.log(`   GET  /api/*        → management API`);
  console.log(`   GET  /             → GUI dashboard`);

  return server;
}
