import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { modelInList, toolChoiceToolPredicate } from "../types";
import { isModelTextOnly } from "../vision";
import type { SidecarSettings } from "./executor";
import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import { resolveSidecarAuth } from "../sidecar/auth";
import { getAccountSet } from "../oauth/store";
import { validateXaiSearchOptions, type XaiSearchOptions } from "./xai-executor";
import type { OcxWebSearchSidecarConfig } from "../types";
import { DEFAULT_STALL_TIMEOUT_SEC } from "../stall-timeout";
import { buildWebSearchTool, extractHostedWebSearch, WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";

export { runWithWebSearch } from "./loop";
export { buildWebSearchTool, extractHostedWebSearch, WEB_SEARCH_TOOL_NAME };
export { runAnthropicWebSearch, parseAnthropicSidecarSSE } from "./anthropic-executor";
export { runXaiWebSearch, parseXaiResponsesSSE, validateXaiSearchOptions, type XaiSearchOptions } from "./xai-executor";
export { runGeminiWebSearch, mapCcaGroundedResponse } from "./gemini-executor";
export { runExaWebSearch, mapExaSearchResponse } from "./exa-executor";

const DEFAULT_SIDECAR_MODEL = "gpt-5.6-luna";
// Default Claude model for the anthropic-backed sidecar (used when cfg.model is unset).
const DEFAULT_ANTHROPIC_SIDECAR_MODEL = "claude-sonnet-5";
// Default Grok model for the xai-backed sidecar (probe-verified with hosted tools, devlog 003).
const DEFAULT_XAI_SIDECAR_MODEL = "grok-4.6";
// Default Gemini model for the gemini-backed sidecar (CCA grounding probe, devlog 002).
const DEFAULT_GEMINI_SIDECAR_MODEL = "gemini-3.7-flash";
// "low" is the lightest effort the ChatGPT backend allows with web_search ("minimal" is rejected:
// "tools cannot be used with reasoning.effort 'minimal'") — keeps the sidecar fast/cheap.
const DEFAULT_SIDECAR_REASONING = "low";
const DEFAULT_MAX_SEARCHES = 3;
// Per-search sidecar deadline. Lowered from 200_000 to 60_000 (#398): a hung
// hosted web_search used to run the full 200s, so the client cancelled first
// (turn 499) or the forced-answer routed iteration failed (502). Hosted-search
// p90 is ~43s, so 60s bounds hangs while leaving tail margin. `cfg.timeoutMs`
// still overrides. Distinct from DEFAULT_ROUTED_MODEL_STALL_TIMEOUT_MS below,
// which is the routed-model body-inactivity budget (unchanged).
const DEFAULT_TIMEOUT_MS = 60_000;
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
 * Delegates to the shared sidecar auth module (#2188) so web-search and vision
 * cannot drift on what "Anthropic auth present" means.
 */
export function findAnthropicSidecarProvider(config: OcxConfig): AnthropicSidecarProvider | undefined {
  const auth = resolveSidecarAuth(config);
  if (!auth.isAnthropicAuth || !auth.anthropicProviderName || !auth.anthropicProvider) return undefined;
  return { providerName: auth.anthropicProviderName, provider: auth.anthropicProvider };
}

/**
 * First enabled provider whose stored Grok OAuth account is active and not marked for
 * reauth — the only credential the xai web-search executor may spend. Same account-set
 * predicate the shared sidecar auth module applies to Anthropic.
 */
export function findXaiSidecarProvider(config: OcxConfig): { providerName: string; provider: OcxProviderConfig } | undefined {
  // The stored Grok credential lives under the provider named "xai" (registry id);
  // OAuth account sets are keyed by provider name, so the name IS the credential key.
  const provider = config.providers["xai"];
  if (!provider || provider.disabled === true || provider.authMode !== "oauth") return undefined;
  const set = getAccountSet("xai");
  const active = set?.accounts.find(account => account.id === set.activeAccountId);
  if (active && active.needsReauth !== true) return { providerName: "xai", provider };
  return undefined;
}

/**
 * First usable Antigravity credential holder: the "google-antigravity" provider
 * (registry id = OAuth store key, same narrowing as findXaiSidecarProvider) whose
 * active stored account is healthy AND carries a discovered CCA projectId — the
 * executor cannot form the envelope without it.
 */
export function findGeminiSidecarProvider(config: OcxConfig): { providerName: string; provider: OcxProviderConfig } | undefined {
  const provider = config.providers["google-antigravity"];
  if (!provider || provider.disabled === true || provider.authMode !== "oauth") return undefined;
  const set = getAccountSet("google-antigravity");
  const active = set?.accounts.find(account => account.id === set.activeAccountId);
  if (!active || active.needsReauth === true) return undefined;
  const projectId = (active.credential as { projectId?: string } | undefined)?.projectId;
  if (!projectId) return undefined;
  return { providerName: "google-antigravity", provider };
}

/** Lift the persisted xSearch config block into executor options (absent block = web_search only). */
export function xaiSearchOptionsFromConfig(cfg: Pick<OcxWebSearchSidecarConfig, "xSearch">): XaiSearchOptions {
  const x = cfg.xSearch;
  if (!x || x.enabled !== true) return {};
  return {
    xSearch: true,
    ...(x.allowedXHandles ? { allowedXHandles: x.allowedXHandles } : {}),
    ...(x.excludedXHandles ? { excludedXHandles: x.excludedXHandles } : {}),
    ...(x.fromDate ? { fromDate: x.fromDate } : {}),
    ...(x.toDate ? { toDate: x.toDate } : {}),
  };
}

/** Every backend id the config union admits. New ids are explicit-only and inert until their executor ships. */
export type WebSearchBackendId = "openai" | "anthropic" | "xai" | "gemini" | "exa";

/**
 * Precedence: explicit config wins; unset defaults to "openai" (ChatGPT forward path). The
 * anthropic backend (web_search_20250305) is only used when explicitly configured — auto-selecting
 * it from credential availability caused the sidecar to send incompatible models (e.g. gpt-5.6-luna)
 * to the Anthropic API.
 * The 2188 follow-up ids (xai/gemini/exa) resolve to themselves the same explicit-only way; their
 * planWebSearch arms stay fail-closed until each executor layer lands.
 */
export function resolveSidecarBackend(
  explicit: WebSearchBackendId | undefined,
): WebSearchBackendId {
  if (explicit === "anthropic" || explicit === "xai" || explicit === "gemini" || explicit === "exa") return explicit;
  return "openai";
}

export interface SidecarPlan {
  /** Which executor runs the search. Anthropic does not require a forward provider. */
  backend: WebSearchBackendId;
  /** Present for the openai backend (ChatGPT forward path); undefined for anthropic. */
  forwardSidecar?: ResolvedOpenAiForwardSidecar;
  /** Present for the anthropic backend (stored-OAuth /v1/messages path); undefined for openai. */
  anthropicSidecar?: AnthropicSidecarProvider;
  /** Present for the xai backend (stored Grok OAuth /v1/responses path). */
  xaiSidecar?: { providerName: string; provider: OcxProviderConfig };
  /** Present for the gemini backend (Antigravity CCA grounding path). */
  geminiSidecar?: { providerName: string; provider: OcxProviderConfig };
  /** Opt-in x_search options for the xai backend (validated at the management layer and again in the executor). */
  xaiSearchOptions?: XaiSearchOptions;
  /** Presence marker for the exa backend — the API key itself never rides the plan. */
  exaConfigured?: true;
  hostedTool: Record<string, unknown>;
  settings: SidecarSettings;
  maxSearches: number;
  /** Resolved routed-model response-body raw-byte inactivity deadline (ms). */
  routedModelStallTimeoutMs: number;
  /** Effective bridge stall deadline for the sidecar turn (see webSearchStallTimeoutSec). */
  stallTimeoutSec: number;
  /** Stream leading routed-model output live until the first tool-call boundary (opt-in). */
  streamRoutedModelOutput: boolean;
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
  if (!toolChoiceToolPredicate(parsed.options.toolChoice)(buildWebSearchTool())) return undefined;
  const cfg = config.webSearchSidecar ?? {};
  if (cfg.enabled === false) return undefined;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const routedModelStallTimeoutMs = resolveRoutedModelStallTimeoutMs(cfg.routedModelStallTimeoutMs);
  // Same `?? 200_000` default the server applies when threading connectTimeoutMs into the loop.
  const connectTimeoutMs = config.connectTimeoutMs ?? 200_000;
  // Shared auth state (#2188): presence only — backend PREFERENCE stays with
  // resolveSidecarBackend's explicit-or-openai contract.
  const auth = resolveSidecarAuth(config);
  const anthropicSidecar = auth.isAnthropicAuth && auth.anthropicProviderName && auth.anthropicProvider
    ? { providerName: auth.anthropicProviderName, provider: auth.anthropicProvider }
    : undefined;
  const backend = resolveSidecarBackend(cfg.backend);
  const maxSearches = cfg.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES;
  const stallTimeoutSec = webSearchStallTimeoutSec(
    config.stallTimeoutSec,
    connectTimeoutMs,
    routedModelStallTimeoutMs,
    timeoutMs,
  );
  // The routed model being text-only means the search model must verbalize image results (either backend).
  const describeImages = isModelTextOnly(provider, modelId);
  const reasoning = cfg.reasoning ?? DEFAULT_SIDECAR_REASONING;
  const streamRoutedModelOutput = cfg.streamRoutedModelOutput === true;

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
      streamRoutedModelOutput,
    };
  }

  // xAI backend (L7): explicit-only, authenticated by the STORED Grok OAuth credential.
  // Same fail-closed stance as anthropic — an explicit choice with no usable credential
  // produces no plan instead of borrowing another login.
  if (backend === "xai") {
    const xaiSidecar = findXaiSidecarProvider(config);
    if (!xaiSidecar) return undefined;
    const xaiOptions = xaiSearchOptionsFromConfig(cfg);
    if (validateXaiSearchOptions(xaiOptions)) return undefined;
    return {
      backend: "xai",
      xaiSidecar,
      xaiSearchOptions: xaiOptions,
      hostedTool: parsed._webSearch,
      settings: { model: cfg.model ?? DEFAULT_XAI_SIDECAR_MODEL, reasoning, timeoutMs, describeImages },
      maxSearches,
      routedModelStallTimeoutMs,
      stallTimeoutSec,
      streamRoutedModelOutput,
    };
  }

  // Gemini backend (L8): explicit-only, authenticated by the stored Antigravity CCA
  // OAuth credential; requires the discovered projectId. Fail-closed like the others.
  if (backend === "gemini") {
    const geminiSidecar = findGeminiSidecarProvider(config);
    if (!geminiSidecar) return undefined;
    return {
      backend: "gemini",
      geminiSidecar,
      hostedTool: parsed._webSearch,
      settings: { model: cfg.model ?? DEFAULT_GEMINI_SIDECAR_MODEL, reasoning, timeoutMs, describeImages },
      maxSearches,
      routedModelStallTimeoutMs,
      stallTimeoutSec,
      streamRoutedModelOutput,
    };
  }

  // exa (L9): explicit-only, keyed by the operator-supplied exaApiKey. The KEY never
  // rides the plan object — core.ts reads it from config at unpack time; the plan
  // carries only a presence marker. Fail-closed without a key.
  if (backend === "exa") {
    if (!cfg.exaApiKey) return undefined;
    return {
      backend: "exa",
      exaConfigured: true,
      hostedTool: parsed._webSearch,
      settings: { model: cfg.model ?? DEFAULT_SIDECAR_MODEL, reasoning, timeoutMs, describeImages },
      maxSearches,
      routedModelStallTimeoutMs,
      stallTimeoutSec,
      streamRoutedModelOutput,
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
    streamRoutedModelOutput,
  };
}
