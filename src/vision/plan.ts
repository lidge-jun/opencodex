import type { OcxConfig, OcxContentPart, OcxParsedRequest, OcxProviderConfig } from "../types";
import { modelRecordValue, type VisionReasoningEffort } from "../reasoning-effort";
import type { VisionSettings } from "./describe";
import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import type { CodexAuthPolicyConfig } from "../codex/auth-context";
import { isCodexReserveRequestEligible } from "../codex/loopback-target";
import type { DataPlaneAdmission } from "../server/auth-cors";
import {
  customRowInputModalities,
  isModelVisionSidecarConsumer as isModelTextOnly,
  modelAcceptsImageInput,
} from "./eligibility";
import { normalizeVisionReasoningForModel } from "./reasoning";
import { resolveSidecarAuth } from "../sidecar/auth";
import { DEFAULT_VISION_TIMEOUT_MS, MAX_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS } from "./timeout-bounds";
import { carriesImages } from "./image-rewrite";

const DEFAULT_VISION_MODEL = "gpt-5.6-luna";
const DEFAULT_ANTHROPIC_VISION_MODEL = "claude-sonnet-5";
const DEFAULT_REASONING: VisionReasoningEffort = "low";
export const DEFAULT_MAX_DESCRIPTIONS_PER_TURN = 8;

/** Runtime config is permissive: zero is intentional; malformed values fall back to the bounded default. */
export function resolveMaxDescriptionsPerTurn(value: unknown): number {
  if (value === 0) return 0;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_DESCRIPTIONS_PER_TURN;
}

export function isValidVisionTimeoutMs(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_VISION_TIMEOUT_MS
    && value <= MAX_VISION_TIMEOUT_MS;
}

/** Runtime config is permissive: malformed or out-of-range values fall back to the default. */
export function resolveVisionTimeoutMs(value: unknown): number {
  return isValidVisionTimeoutMs(value) ? value : DEFAULT_VISION_TIMEOUT_MS;
}

export interface AnthropicVisionProvider {
  providerName: string;
  provider: OcxProviderConfig;
}

/**
 * First enabled Anthropic OAuth provider whose active stored account is not marked for reauth.
 * Delegates to the shared sidecar auth module (#2188) — same predicate as web-search.
 */
export function findAnthropicVisionProvider(config: OcxConfig): AnthropicVisionProvider | undefined {
  const auth = resolveSidecarAuth(config);
  if (!auth.isAnthropicAuth || !auth.anthropicProviderName || !auth.anthropicProvider) return undefined;
  return { providerName: auth.anthropicProviderName, provider: auth.anthropicProvider };
}

export function resolveVisionBackend(
  explicit: "openai" | "anthropic" | "routed" | undefined,
  anthropicSidecar: AnthropicVisionProvider | undefined,
): "openai" | "anthropic" {
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  // "routed" collapses to the legacy default order until its describe executor
  // lands (roadmap 170 → 180 revised): a persisted routed backend without a
  // dispatchable arm degrades exactly like unset rather than crashing. wp3
  // replaces this collapse with the real routed arm in planVisionSidecar.
  return anthropicSidecar ? "anthropic" : "openai";
}

/** Native model used by the OpenAI vision helper, including its bounded default. */
export function resolveOpenAiVisionModel(config: Pick<OcxConfig, "visionSidecar">): string {
  const configured = config.visionSidecar?.model;
  // Namespaced routed ids never reach the forward executor (see
  // resolveEffectiveVisionModel).
  return configured && !configured.includes("/") ? configured : DEFAULT_VISION_MODEL;
}

/** Effective describer model for the backend `planVisionSidecar` selected. */
export function resolveEffectiveVisionModel(
  config: Pick<OcxConfig, "visionSidecar">,
  backend: "openai" | "anthropic",
): string {
  const configured = config.visionSidecar?.model;
  // A namespaced "provider/model" id belongs to the routed backend only; the
  // forward/OAuth executors POST the model string verbatim, so it falls back
  // to the side's default here (PUT coherence rejects new writes of this
  // shape, but a legacy or hand-edited config must not break the executor).
  const usable = configured && !configured.includes("/") ? configured : undefined;
  return backend === "anthropic"
    ? usable || DEFAULT_ANTHROPIC_VISION_MODEL
    : usable || DEFAULT_VISION_MODEL;
}

function messagesHaveImage(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(m =>
    carriesImages(m.role) && Array.isArray(m.content) && (m.content as OcxContentPart[]).some(p => p.type === "image"));
}

/**
 * Direct-image admission for a routed target. Returns true when capability evidence proves the
 * target cannot accept image input, so the caller must describe or strip the image first.
 * Evidence is consulted highest-first: `modelCapabilities` (the dedicated per-model capability
 * axis), an explicit custom row for the same routed identity, `noVisionModels`, an explicit
 * per-model modality list without `image`, and finally proven-negative registry/vendor metadata.
 * Any of them can require the vision preprocessor. A genuinely unknown custom model is NOT
 * guessed blind: it keeps the established pass-through behaviour. The provider-only fallback
 * keeps legacy unit callers stable; production dispatch always supplies providerName so the
 * complete capability chain is consulted.
 */
export function requiresVisionPreprocessing(
  config: Pick<OcxConfig, "providers"> & { customModels?: OcxConfig["customModels"] },
  provider: Pick<OcxProviderConfig, "noVisionModels" | "modelInputModalities" | "modelCapabilities">,
  modelId: string,
  providerName?: string,
): boolean {
  const runtimeDeclared = Object.hasOwn(provider.modelCapabilities ?? {}, modelId)
    ? provider.modelCapabilities?.[modelId]?.inputModalities
    : undefined;
  // `modelCapabilities` is the dedicated per-model capability axis, so it outranks everything
  // below — including an explicit custom row that disagrees. The CLI `--text-only` flag writes it.
  if (runtimeDeclared !== undefined) return !runtimeDeclared.includes("image");
  // An explicit custom row outranks the provider-level hints below, mirroring the catalog overlay
  // in `src/codex/catalog/routed-gather.ts` that already copies this same declaration onto the
  // advertised row. Without it the dashboard advertised "text, image" from the operator's own row
  // while this predicate stripped the image before dispatch.
  const customDeclared = providerName === undefined
    ? undefined
    : customRowInputModalities(config, providerName, modelId);
  // Same rule as the `modelCapabilities` branch above: the declaration answers "can this model
  // take an image", not "is it a text model". A row that lists only `audio` or `video` excludes
  // image input just as `["text"]` does, and `modelAcceptsImageInput` already answers "no image"
  // for it; the narrower `includes("text")` test here made the two predicates disagree and sent
  // the attachment to a model that cannot read it.
  if (customDeclared !== undefined) return !customDeclared.includes("image");
  if (isModelTextOnly(provider, modelId)) return true;
  const runtimeModalities = modelRecordValue(provider.modelInputModalities, modelId);
  if (Array.isArray(runtimeModalities) && runtimeModalities.length > 0) {
    return !runtimeModalities.includes("image");
  }
  if (!providerName) return false;
  return modelAcceptsImageInput(config, { provider: providerName, id: modelId }) === false;
}

/** Shared by auth admission and planning so a routed describer never borrows OpenAI auth. */
function usableRoutedVisionModel(config: OcxConfig): string | undefined {
  const cfg = config.visionSidecar;
  if (cfg?.backend !== "routed") return undefined;
  const routedModel = cfg.model;
  const sep = routedModel ? routedModel.indexOf("/") : -1;
  if (!routedModel || sep <= 0) return undefined;
  const targetProvider = routedModel.slice(0, sep);
  const targetId = routedModel.slice(sep + 1);
  // `modelAcceptsImageInput` is the one predicate here: it resolves the whole capability chain,
  // custom row included. The provider-only `isModelTextOnly` that used to be ANDed in could only
  // subtract — it never saw a custom row, so a describer the operator had declared image-capable
  // was refused for a provider hint that same row overrides.
  return modelAcceptsImageInput(config, { provider: targetProvider, id: targetId }) !== false
    ? routedModel : undefined;
}

export function shouldResolveOpenAiVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
  modelId: string,
  parsed: OcxParsedRequest,
  providerName?: string,
): boolean {
  if (!requiresVisionPreprocessing(config, provider, modelId, providerName) || !messagesHaveImage(parsed)) return false;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return false;
  if (usableRoutedVisionModel(config)) return false;
  return resolveVisionBackend(cfg.backend, findAnthropicVisionProvider(config)) === "openai";
}

export interface VisionPlan {
  backend: "openai" | "anthropic" | "routed";
  forwardSidecar?: ResolvedOpenAiForwardSidecar;
  anthropicSidecar?: AnthropicVisionProvider;
  /** Namespaced "provider/model" describer for the routed backend (roadmap 180). */
  routedModel?: string;
  /** Loopback dispatch inputs for the routed backend (the listener decides WHICH local port). */
  routedConfig?: Pick<OcxConfig, "port" | "hostname" | "apiKeys" | "unauthenticatedLoopbackListener">;
  settings: VisionSettings;
  maxDescriptionsPerTurn: number;
}

/**
 * Decide whether the vision sidecar should pre-describe images for this request. Raw image
 * delivery is capability-driven: targets proven text-only are preprocessed, targets proven
 * image-capable bypass this planner, and genuinely unknown custom targets retain legacy behavior.
 * The request must
 * carry an image, the sidecar must be enabled, and the selected backend must be dispatchable.
 * Returns undefined otherwise; the caller strips images before any unverified upstream send.
 */
export function planVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
  modelId: string,
  parsed: OcxParsedRequest,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
  options: {
    admission?: Pick<DataPlaneAdmission, "source">;
    codexAuthPolicy?: CodexAuthPolicyConfig;
    providerName?: string;
  } = {},
): VisionPlan | undefined {
  if (!requiresVisionPreprocessing(config, provider, modelId, options.providerName)) return undefined;
  if (!messagesHaveImage(parsed)) return undefined;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return undefined;

  // Routed arm (roadmap 180 revised): explicit backend + NAMESPACED explicit
  // model only — never inferred from credential availability. Plan-time
  // fence: the target must not be provably blind, and must not itself be a
  // model this planner would re-enter for (belt; the terminal marker on the
  // loopback request is the braces).
  const routedModel = usableRoutedVisionModel(config);
  if (routedModel) {
    return {
      backend: "routed",
      routedModel,
      routedConfig: {
        port: config.port,
        ...(config.apiKeys ? { apiKeys: config.apiKeys } : {}),
        // The self-fetch has to honor the unauthenticated loopback listener AND, with no
        // listener, the bind address — so BOTH fields the destination resolver reads have to
        // survive the narrowing or it silently resolves to the wrong local socket (#4236).
        ...(config.hostname ? { hostname: config.hostname } : {}),
        ...(config.unauthenticatedLoopbackListener
          ? { unauthenticatedLoopbackListener: config.unauthenticatedLoopbackListener }
          : {}),
      },
      settings: {
        model: routedModel,
        reasoning: DEFAULT_REASONING,
        timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
      },
      maxDescriptionsPerTurn: resolveMaxDescriptionsPerTurn(cfg.maxDescriptionsPerTurn),
    };
  }
  // A non-dispatchable routed configuration keeps the legacy backend fallback below.

  const anthropicSidecar = findAnthropicVisionProvider(config);
  const backend = resolveVisionBackend(cfg.backend, anthropicSidecar);
  // A namespaced routed model must never reach the forward/OAuth executors
  // (they POST the string verbatim); the effective-model resolver falls back
  // to each side's default in that case.
  const model = resolveEffectiveVisionModel(config, backend);
  const maxDescriptionsPerTurn = resolveMaxDescriptionsPerTurn(cfg.maxDescriptionsPerTurn);

  if (backend === "anthropic") {
    if (!anthropicSidecar) return undefined;
    return {
      backend,
      anthropicSidecar,
      settings: {
        model,
        reasoning: normalizeVisionReasoningForModel(model, cfg.reasoning) ?? DEFAULT_REASONING,
        timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
      },
      maxDescriptionsPerTurn,
    };
  }

  if (!openAiSidecar) return undefined;
  return {
    backend,
    forwardSidecar: openAiSidecar,
    settings: {
      ...(isCodexReserveRequestEligible(options.codexAuthPolicy ?? config, options.admission) ? { reserveCompatibility: true } : {}),
      model,
      reasoning: normalizeVisionReasoningForModel(model, cfg.reasoning) ?? DEFAULT_REASONING,
        timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
    },
    maxDescriptionsPerTurn,
  };
}
