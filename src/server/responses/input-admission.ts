/**
 * Pre-dispatch input admission (#1412).
 *
 * Refuses a turn whose estimated input cannot plausibly fit the model context window,
 * BEFORE auth resolution, circuit admission, or any upstream I/O. #1412 reported ~127k of
 * real context compounding to 1.3M-1.6M tokens and crashing the proxy; the provider would
 * reject such a turn anyway, so paying for the round trip buys nothing.
 *
 * Deliberately narrow. This is not a context manager and not a compaction trigger: it
 * catches the pathological case and stays out of the way otherwise. Every uncertainty
 * resolves toward admitting.
 */
import { nativeOpenAiContextWindow, nativeOpenAiMaxInputTokens, type NativeContextLimitsInput } from "../../codex/catalog/metadata";
import { estimateTokens } from "../../lib/token-estimate";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { modelRecordValue } from "../../reasoning-effort";
import type { OcxContentPart, OcxParsedRequest, OcxProviderConfig } from "../../types";

/**
 * Multiplier applied to the ceiling before refusing.
 *
 * 2.5, not something tighter, because `estimateTokens` can overshoot by 1.6x on its own.
 * `cjkRatio` samples every `stride`-th character, so a payload of fixed-width records whose
 * length aligns with the stride samples as 100% CJK while being ~1.6% CJK, firing the
 * 2.5-chars/token clamp instead of the 4.0 default. Measured on Bun 1.3.14: 126,046 chars,
 * true CJK ratio 0.0161, sampled ratio 1.0, estimate inflated 1.6x. Since 4.0 / 2.5 = 1.6
 * is that branch maximum divergence, a threshold at or under 1.6 would convert the
 * estimator error bar into false 413s.
 *
 * 2.5 sits above it with room for the ~10% model-family ratio spread, and still refuses the
 * #1412 shape (10x) four times over.
 */
export const ADMISSION_TOLERANCE = 2.5;

/**
 * Token cost charged for a remote image URL. The bytes are not in this request — the
 * provider fetches them — so the URL own length is not the cost. A small flat charge
 * acknowledges the tiles the image will occupy without pretending to know its dimensions.
 */
const REMOTE_IMAGE_TOKENS = 850;

/** Decoded image bytes per token. Coarse tile-count proxy, not a provider formula. */
const IMAGE_BYTES_PER_TOKEN = 750;

export interface InputAdmissionResult {
  admitted: boolean;
  estimatedTokens: number;
  /** Resolved ceiling, or null when nothing could be resolved (=> always admitted). */
  ceiling: number | null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Charge a `data:` URL by its DECODED size rather than its character length: base64 inflates
 * by 4/3, so charging the string would overcount by a third. A remote URL is charged flat.
 */
function imageTokens(imageUrl: string): number {
  if (!imageUrl.startsWith("data:")) return REMOTE_IMAGE_TOKENS;
  const comma = imageUrl.indexOf(",");
  if (comma < 0) return REMOTE_IMAGE_TOKENS;
  const payload = imageUrl.length - comma - 1;
  if (payload <= 0) return 0;
  const decoded = Math.floor((payload * 3) / 4);
  return Math.max(1, Math.ceil(decoded / IMAGE_BYTES_PER_TOKEN));
}

function contentPartTokens(part: OcxContentPart, modelId: string): number {
  if (part.type === "image") return imageTokens(part.imageUrl);
  if (part.type === "video") return imageTokens(part.videoUrl);
  return estimateTokens(part.text, modelId);
}

function contentTokens(content: string | readonly OcxContentPart[], modelId: string): number {
  if (typeof content === "string") return estimateTokens(content, modelId);
  let total = 0;
  for (const part of content) total += contentPartTokens(part, modelId);
  return total;
}

/**
 * Estimate the input tokens of a parsed request.
 *
 * Walks the whole `OcxMessage` union rather than user text alone. Assistant turns carry
 * their content as `OcxAssistantContentPart[]` — text, thinking blocks, and tool calls whose
 * JSON arguments are frequently the largest single item in an agent conversation. A walk
 * that counted only `{type:"text"}` would undercount exactly the turns that trigger this
 * gate.
 */
export function estimateInputTokens(parsed: OcxParsedRequest, modelId: string): number {
  const { context } = parsed;
  let total = 0;

  for (const prompt of context.systemPrompt ?? []) total += estimateTokens(prompt, modelId);

  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") total += estimateTokens(part.text, modelId);
        else if (part.type === "thinking") total += estimateTokens(part.thinking, modelId);
        else total += estimateTokens(part.name, modelId) + estimateTokens(JSON.stringify(part.arguments), modelId);
      }
      // Opaque provider blob replayed verbatim upstream, so it costs real input tokens.
      if (message.kiroRedactedReasoning) total += estimateTokens(message.kiroRedactedReasoning, modelId);
      continue;
    }
    total += contentTokens(message.content, modelId);
  }

  // Tool schemas ride every turn: name, description, and the JSON parameter schema all
  // reach the upstream, and a large MCP catalog can dominate a short conversation.
  for (const tool of context.tools ?? []) {
    total += estimateTokens(tool.name, modelId)
      + estimateTokens(tool.description, modelId)
      + estimateTokens(JSON.stringify(tool.parameters), modelId);
  }

  return total;
}

/**
 * Resolve the admission ceiling. Pure: no filesystem, no catalog, no registry scan.
 *
 * `provider` must be the ROUTED config (`route.provider`), which `routedProviderConfig`
 * has already transport-guarded and merged. Re-deriving from `config.providers[name]` would
 * reject a user-defined provider that merely shares a built-in name using limits that
 * belong to a different service.
 */
export function resolveInputCeiling(
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
  // Operator cap for the canonical native provider. Passed in rather than read from a
  // config here so this stays pure: no filesystem, no catalog, no registry scan.
  nativeContextCap?: NativeContextLimitsInput,
): number | null {
  // `modelRecordValue`, not a bare lookup: the catalog resolves these same two maps that
  // way, so a `gpt-oss` entry covers `gpt-oss:120b`. Reading raw here made the gate fall
  // back to the provider-wide window and refuse turns the model can plainly hold.
  const configured = positive(modelRecordValue(provider.modelContextWindows, modelId))
    ?? positive(provider.contextWindow);

  // The canonical `openai` registry entry declares no context fields, so without this the
  // gate would be inert on the default Codex route. All three clauses are load-bearing: a
  // transport-mismatched custom provider named "openai" is preserved verbatim by routing
  // and must not inherit built-in native limits, and a routed `provider/model` id is not a
  // native slug. Static maps only — no catalog read.
  const canonicalNativeBare = providerName === OPENAI_CODEX_PROVIDER_ID
    && isCanonicalOpenAiForwardProvider(provider)
    && !modelId.includes("/");
  const nativeLimits = canonicalNativeBare && configured !== null
    ? {
        ...(typeof nativeContextCap === "number" ? { cap: nativeContextCap } : (nativeContextCap ?? {})),
        modelWindows: { [modelId]: configured },
      }
    : nativeContextCap;
  const native = canonicalNativeBare
    ? positive(nativeOpenAiContextWindow(modelId, nativeLimits))
    : null;
  const nativeMaxInput = canonicalNativeBare ? positive(nativeOpenAiMaxInputTokens(modelId, nativeLimits)) : null;

  const window = canonicalNativeBare ? native : configured;
  // modelMaxInputTokens is an input-only cap, so it can only tighten the window.
  const configuredMaxInput = positive(modelRecordValue(provider.modelMaxInputTokens, modelId));
  const limits = [window, configuredMaxInput, nativeMaxInput].filter((v): v is number => v !== null);
  return limits.length === 0 ? null : Math.min(...limits);
}

/**
 * Fail-open when no ceiling is known; refuse only past `ceiling * ADMISSION_TOLERANCE`.
 *
 * The caller is responsible for skipping compaction turns — see the call site in core.ts.
 */
export function checkInputAdmission(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
  nativeContextCap?: NativeContextLimitsInput,
): InputAdmissionResult {
  const ceiling = resolveInputCeiling(provider, providerName, modelId, nativeContextCap);
  if (ceiling === null) return { admitted: true, estimatedTokens: 0, ceiling: null };
  const estimatedTokens = estimateInputTokens(parsed, modelId);
  return { admitted: estimatedTokens <= ceiling * ADMISSION_TOLERANCE, estimatedTokens, ceiling };
}
