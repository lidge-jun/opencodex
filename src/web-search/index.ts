import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { modelInList } from "../types";
import type { SidecarSettings } from "./executor";
import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import { getAccountSet } from "../oauth/store";
import { DEFAULT_STALL_TIMEOUT_SEC } from "../stall-timeout";

export { runWithWebSearch } from "./loop";
export { buildWebSearchTool, extractHostedWebSearch, WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";
export { runAnthropicWebSearch, parseAnthropicSidecarSSE } from "./anthropic-executor";

const DEFAULT_SIDECAR_MODEL = "gpt-5.6-luna";
// Default Claude model for the anthropic-backed sidecar (used when cfg.model is unset).
const DEFAULT_ANTHROPIC_SIDECAR_MODEL = "claude-sonnet-5";
// "low" is the lightest effort the ChatGPT backend allows with web_search ("minimal" is rejected:
// "tools cannot be used with reasoning.effort 'minimal'") — keeps the sidecar fast/cheap.
const DEFAULT_SIDECAR_REASONING = "low";
const DEFAULT_MAX_SEARCHES = 3;
const DEFAULT_TIMEOUT_MS = 200_000;
const DEFAULT_ROUTED_MODEL_STALL_TIMEOUT_MS = 200_000;
const MAX_ROUTED_MODEL_STALL_TIMEOUT_MS = 2_147_483_647;
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
 * otherwise a legitimately slow search trips the bridge's default upstream_stall_timeout and
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

/** A configured anthropic-adapter OAuth provider whose ACTIVE stored account is usable (not needs-reauth). */
export interface AnthropicSidecarProvider {
  providerName: string;
  provider: OcxProviderConfig;
}

/**
 * First enabled anthropic-adapter OAuth provider whose ACTIVE account holds a usable credential — the
 * only path that can run web_search_20250305 without a ChatGPT forward provider. Presence is decided by
 * getAccountSet + the active account's `needsReauth` marker (audit F1: getCredential alone can pick a
 * terminally-invalid account); token refresh happens later at executor time.
 */
export function findAnthropicSidecarProvider(config: OcxConfig): AnthropicSidecarProvider | undefined {
  for (const [name, prov] of Object.entries(config.providers)) {
    if (prov.disabled === true) continue;
    if (prov.adapter !== "anthropic" || prov.authMode !== "oauth") continue;
    const set = getAccountSet(name);
    const active = set?.accounts.find(a => a.id === set.activeAccountId);
    if (active && active.needsReauth !== true) return { providerName: name, provider: prov };
  }
  return undefined;
}

/**
 * Precedence: explicit config wins; unset defaults to "openai" (ChatGPT forward path). The
 * anthropic backend (web_search_20250305) is only used when explicitly configured — auto-selecting
 * it from credential availability caused the sidecar to send incompatible models (e.g. gpt-5.6-luna)
 * to the Anthropic API.
 */
export function resolveSidecarBackend(
  explicit: "openai" | "anthropic" | undefined,
): "openai" | "anthropic" {
  return explicit === "anthropic" ? "anthropic" : "openai";
}

export interface SidecarPlan {
  /** Which executor runs the search. Anthropic does not require a forward provider. */
  backend: "openai" | "anthropic";
  /** Present for the openai backend (ChatGPT forward path); undefined for anthropic. */
  forwardSidecar?: ResolvedOpenAiForwardSidecar;
  /** Present for the anthropic backend (stored-OAuth /v1/messages path); undefined for openai. */
  anthropicSidecar?: AnthropicSidecarProvider;
  hostedTool: Record<string, unknown>;
  settings: SidecarSettings;
  maxSearches: number;
  /** Resolved routed-model response-body raw-byte inactivity deadline (ms). */
  routedModelStallTimeoutMs: number;
  /** Effective bridge stall deadline for the sidecar turn (see webSearchStallTimeoutSec). */
  stallTimeoutSec: number;
}

export function shouldResolveOpenAiWebSearchSidecar(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  isPassthrough: boolean,
): boolean {
  if (!parsed._webSearch || isPassthrough) return false;
  const cfg = config.webSearchSidecar ?? {};
  return cfg.enabled !== false && resolveSidecarBackend(cfg.backend) === "openai";
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
  provider: OcxProviderConfig,
  modelId: string,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
): SidecarPlan | undefined {
  if (!parsed._webSearch || isPassthrough) return undefined;
  const cfg = config.webSearchSidecar ?? {};
  if (cfg.enabled === false) return undefined;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const routedModelStallTimeoutMs = resolveRoutedModelStallTimeoutMs(cfg.routedModelStallTimeoutMs);
  // Same `?? 200_000` default the server applies when threading connectTimeoutMs into the loop.
  const connectTimeoutMs = config.connectTimeoutMs ?? 200_000;
  const anthropicSidecar = findAnthropicSidecarProvider(config);
  const backend = resolveSidecarBackend(cfg.backend);
  const maxSearches = cfg.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES;
  const stallTimeoutSec = webSearchStallTimeoutSec(
    config.stallTimeoutSec,
    connectTimeoutMs,
    routedModelStallTimeoutMs,
    timeoutMs,
  );
  // The routed model being text-only means the search model must verbalize image results (either backend).
  const describeImages = modelInList(provider.noVisionModels, modelId);
  const reasoning = cfg.reasoning ?? DEFAULT_SIDECAR_REASONING;

  // Anthropic backend authenticates with the STORED credential — no forward provider or ChatGPT login gate.
  // resolveSidecarBackend only returns "anthropic" when it was explicitly configured OR a usable credential
  // exists; an EXPLICIT anthropic choice with no usable credential FAILS CLOSED (no plan) rather than
  // silently borrowing ChatGPT credentials (audit round-2 F1).
  if (backend === "anthropic") {
    if (!anthropicSidecar) return undefined;
    return {
      backend: "anthropic",
      anthropicSidecar,
      hostedTool: parsed._webSearch,
      settings: { model: cfg.model ?? DEFAULT_ANTHROPIC_SIDECAR_MODEL, reasoning, timeoutMs, describeImages },
      maxSearches,
      routedModelStallTimeoutMs,
      stallTimeoutSec,
    };
  }

  // OpenAI backend: needs a ChatGPT login (main) and a forward provider to reach server-side web_search.
  if (!openAiSidecar) return undefined;
  return {
    backend: "openai",
    forwardSidecar: openAiSidecar,
    hostedTool: parsed._webSearch,
    settings: { model: cfg.model ?? DEFAULT_SIDECAR_MODEL, reasoning, timeoutMs, describeImages },
    maxSearches,
    routedModelStallTimeoutMs,
    stallTimeoutSec,
  };
}
