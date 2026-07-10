import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { modelInList } from "../types";
import type { SidecarSettings } from "./executor";
import type { CodexAuthContext } from "../codex/auth-context";

export { runWithWebSearch } from "./loop";
export { buildWebSearchTool, extractHostedWebSearch, WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";

const DEFAULT_SIDECAR_MODEL = "gpt-5.6-luna";
// "low" is the lightest effort the ChatGPT backend allows with web_search ("minimal" is rejected:
// "tools cannot be used with reasoning.effort 'minimal'") — keeps the sidecar fast/cheap.
const DEFAULT_SIDECAR_REASONING = "low";
const DEFAULT_MAX_SEARCHES = 3;
const DEFAULT_TIMEOUT_MS = 200_000;
const DEFAULT_ROUTED_MODEL_STALL_TIMEOUT_MS = 200_000;
const MAX_ROUTED_MODEL_STALL_TIMEOUT_MS = 2_147_483_647;
// Mirrors the bridge's stall default (bridge.ts `options?.stallTimeoutSec ?? 90`).
const DEFAULT_STALL_TIMEOUT_SEC = 90;
const STALL_MARGIN_SEC = 30;

/**
 * Resolve the config-file-only routed-model raw-byte inactivity budget. Runtime config loading is
 * deliberately permissive, so malformed values fall back locally without rejecting or rewriting
 * the caller's config object.
 */
export function resolveRoutedModelStallTimeoutMs(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_ROUTED_MODEL_STALL_TIMEOUT_MS
    ? value
    : DEFAULT_ROUTED_MODEL_STALL_TIMEOUT_MS;
}

function finiteCeil(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.ceil(value))
    : fallback;
}

/**
 * Effective bridge stall deadline (seconds) for the web-search loop. The loop's silent work units
 * are individually bounded by the configured bridge stall, response-header connect timeout,
 * routed-model response-body inactivity timeout, or sidecar timeout. The stall deadline must cover
 * the largest unit plus a margin;
 * otherwise a legitimately slow search trips the bridge's 90s default upstream_stall_timeout and
 * kills the whole turn. Stays finite so a genuine hang is still cut off.
 */
export function webSearchStallTimeoutSec(
  configuredSec: number | undefined,
  connectTimeoutMs: number | undefined,
  routedModelStallTimeoutMs: number,
  sidecarTimeoutMs: number = routedModelStallTimeoutMs,
): number {
  const largestUnitSec = Math.max(
    finiteCeil(configuredSec, DEFAULT_STALL_TIMEOUT_SEC),
    finiteCeil(connectTimeoutMs, 0) / 1000,
    finiteCeil(routedModelStallTimeoutMs, 0) / 1000,
    finiteCeil(sidecarTimeoutMs, 0) / 1000,
  );
  return Math.min(Number.MAX_VALUE, Math.ceil(largestUnitSec) + STALL_MARGIN_SEC);
}

/** First configured forward (ChatGPT passthrough) provider — the only path with server-side web_search. */
export function findForwardProvider(config: OcxConfig): OcxProviderConfig | undefined {
  for (const prov of Object.values(config.providers)) {
    if (prov.disabled === true) continue;
    if (prov.authMode === "forward") return prov;
  }
  return undefined;
}

export interface SidecarPlan {
  forwardProvider: OcxProviderConfig;
  hostedTool: Record<string, unknown>;
  settings: SidecarSettings;
  maxSearches: number;
  /** Resolved routed-model response-body raw-byte inactivity deadline (ms). */
  routedModelStallTimeoutMs: number;
  /** Effective bridge stall deadline for the sidecar turn (see webSearchStallTimeoutSec). */
  stallTimeoutSec: number;
}

/**
 * Decide whether the web-search sidecar should handle this request, returning the plan if so. Active
 * when: web_search was requested (`parsed._webSearch`), the route is NOT the passthrough adapter
 * (native gpt already searches server-side), a forward provider exists, the sidecar isn't disabled,
 * and the caller forwarded ChatGPT auth. Returns undefined otherwise (request takes the normal path).
 */
export function planWebSearch(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  isPassthrough: boolean,
  incomingHeaders: Headers,
  provider: OcxProviderConfig,
  modelId: string,
  authContext: CodexAuthContext = { kind: "main", accountId: null },
): SidecarPlan | undefined {
  if (!parsed._webSearch || isPassthrough) return undefined;
  const cfg = config.webSearchSidecar ?? {};
  if (cfg.enabled === false) return undefined;
  if (authContext.kind === "main" && !incomingHeaders.get("authorization")) return undefined; // not logged into ChatGPT → sidecar can't run
  const forwardProvider = findForwardProvider(config);
  if (!forwardProvider) return undefined;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const routedModelStallTimeoutMs = resolveRoutedModelStallTimeoutMs(cfg.routedModelStallTimeoutMs);
  // Same `?? 200_000` default the server applies when threading connectTimeoutMs into the loop.
  const connectTimeoutMs = config.connectTimeoutMs ?? 200_000;
  return {
    forwardProvider,
    hostedTool: parsed._webSearch,
    settings: {
      model: cfg.model ?? DEFAULT_SIDECAR_MODEL,
      reasoning: cfg.reasoning ?? DEFAULT_SIDECAR_REASONING,
      timeoutMs,
      // The routed model is text-only → have the search model verbalize image results.
      describeImages: modelInList(provider.noVisionModels, modelId),
    },
    maxSearches: cfg.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES,
    routedModelStallTimeoutMs,
    stallTimeoutSec: webSearchStallTimeoutSec(
      config.stallTimeoutSec,
      connectTimeoutMs,
      routedModelStallTimeoutMs,
      timeoutMs,
    ),
  };
}
