import type { OcxConfig, OcxContentPart, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { VisionReasoningEffort } from "../reasoning-effort";
import type { VisionSettings } from "./describe";
import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import type { CodexAuthPolicyConfig } from "../codex/auth-context";
import { isCodexReserveRequestEligible } from "../codex/loopback-target";
import type { DataPlaneAdmission } from "../server/auth-cors";
import { isModelVisionSidecarConsumer as isModelTextOnly, modelAcceptsImageInput } from "./eligibility";
import { normalizeVisionReasoningForModel } from "./reasoning";
import { resolveSidecarAuth } from "../sidecar/auth";
import { DEFAULT_VISION_TIMEOUT_MS, MAX_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS } from "./timeout-bounds";
import { carriesImages } from "./image-rewrite";

const DEFAULT_VISION_MODEL = "gpt-5.4-mini";
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

export function shouldResolveOpenAiVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
 modelId: string,
 parsed: OcxParsedRequest,
): boolean {
  if (!isModelTextOnly(provider, modelId) || !messagesHaveImage(parsed)) return false;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return false;
  return resolveVisionBackend(cfg.backend, findAnthropicVisionProvider(config)) === "openai";
}

export interface VisionPlan {
  backend: "openai" | "anthropic" | "routed";
  forwardSidecar?: ResolvedOpenAiForwardSidecar;
  anthropicSidecar?: AnthropicVisionProvider;
  /** Namespaced "provider/model" describer for the routed backend (roadmap 180). */
  routedModel?: string;
  /** Loopback dispatch inputs for the routed backend. */
  routedConfig?: Pick<OcxConfig, "port" | "apiKeys">;
  settings: VisionSettings;
  maxDescriptionsPerTurn: number;
}

/**
 * Decide whether the vision sidecar should pre-describe images for this request, returning the plan
 * if so. Active when: the routed model is in `provider.noVisionModels`, the request actually carries
 * an image, the sidecar isn't disabled, and the selected backend has usable auth. Returns undefined
 * otherwise (the caller strips images before sending to a text-only model).
 */
export function planVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
  modelId: string,
  parsed: OcxParsedRequest,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
  options: { admission?: Pick<DataPlaneAdmission, "source">; codexAuthPolicy?: CodexAuthPolicyConfig } = {},
): VisionPlan | undefined {
  if (!isModelTextOnly(provider, modelId)) return undefined;
  if (!messagesHaveImage(parsed)) return undefined;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return undefined;

  // Routed arm (roadmap 180 revised): explicit backend + NAMESPACED explicit
  // model only — never inferred from credential availability. Plan-time
  // fence: the target must not be provably blind, and must not itself be a
  // model this planner would re-enter for (belt; the terminal marker on the
  // loopback request is the braces).
  if (cfg.backend === "routed") {
    const routedModel = cfg.model;
    const sep = routedModel ? routedModel.indexOf("/") : -1;
    if (routedModel && sep > 0) {
      const targetProvider = routedModel.slice(0, sep);
      const targetId = routedModel.slice(sep + 1);
      const targetProviderConfig = config.providers?.[targetProvider];
      const targetVisible = modelAcceptsImageInput(config, { provider: targetProvider, id: targetId }) !== false
        && !(targetProviderConfig && isModelTextOnly(targetProviderConfig, targetId));
      if (targetVisible) {
        return {
          backend: "routed",
          routedModel,
          routedConfig: { port: config.port, ...(config.apiKeys ? { apiKeys: config.apiKeys } : {}) },
          settings: {
            model: routedModel,
            reasoning: DEFAULT_REASONING,
            timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
          },
          maxDescriptionsPerTurn: resolveMaxDescriptionsPerTurn(cfg.maxDescriptionsPerTurn),
        };
      }
    }
    // Misconfigured routed backend (bare id, unknown provider, or provably
    // blind target): fall through to the legacy default order below rather
    // than dispatching a describe that cannot work.
  }

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
