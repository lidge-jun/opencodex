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
import {
  nativeOpenAiContextWindow,
  nativeOpenAiMaxInputTokens,
  nativeOpenAiMaxOutputTokens,
  type NativeContextLimitsInput,
} from "../../codex/catalog/metadata";
import { getModelMetadata } from "../../generated/model-metadata";
import { estimateTokens } from "../../lib/token-estimate";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { modelRecordValue } from "../../reasoning-effort";
import type { OcxContentPart, OcxParsedRequest, OcxProviderConfig } from "../../types";

/**
 * Multiplier applied to the ceiling before refusing.
 *
 * 2.5, not something tighter, because the estimate is a heuristic and the cost of being wrong
 * is asymmetric: a false refusal fails a turn the provider would have answered, while an
 * over-admission merely pays for one round trip the provider then rejects itself.
 *
 * The original margin was sized against a sampling artifact — `cjkRatio` read every stride-th
 * character, so a payload of fixed-width records could sample as 100% CJK while being 1.6% CJK
 * and inflate the estimate by 4.0/2.5 = 1.6x. That sampler is gone: CJK characters are now
 * counted exactly, so that particular 1.6x divergence cannot occur and the headroom it bought is
 * no longer spent on it.
 *
 * The margin is still 2.5 because the estimator it guards got LARGER, not smaller. Counting the
 * two scripts separately raises a pure-Latin estimate by 1.25x and a Korean one by up to 1.67x
 * against the previous model, which consumes real headroom: measured against the old estimator's
 * scale, 2.5 now behaves like roughly 2.0x for Latin and 1.5x for Korean-dominant input. That is
 * the intended direction — the estimates are closer to what providers actually charge, so the
 * same multiplier is a tighter and more honest bound — and it still refuses the #1412 shape
 * (10x compounding) several times over.
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
  /** Output space reserved by the combo preflight; absent on the loose direct gate. */
  requiredOutputHeadroom?: number;
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
interface ResolvedContextLimits {
  /** The target's total context window: input and output share it. */
  window: number | null;
  /** Largest admissible input, which input-only caps may tighten below the window. */
  ceiling: number | null;
}

function resolveContextLimits(
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
  nativeContextCap?: NativeContextLimitsInput,
): ResolvedContextLimits {
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

  const window = canonicalNativeBare ? (native ?? generatedNativeWindow(modelId, configured, nativeContextCap)) : configured;
  // modelMaxInputTokens is an input-only cap, so it can only tighten the window.
  const configuredMaxInput = positive(modelRecordValue(provider.modelMaxInputTokens, modelId));
  const limits = [window, configuredMaxInput, nativeMaxInput].filter((v): v is number => v !== null);
  return { window, ceiling: limits.length === 0 ? null : Math.min(...limits) };
}

/**
 * Generated-catalog keys, not routing provider names. `OPENAI_CODEX_PROVIDER_ID` is the string
 * `"openai"` -- the canonical Codex forward route -- so using it to index the generated bundle
 * would silently skip the native Codex rows and read the public API rows instead.
 */
const NATIVE_METADATA_CATALOGS = ["openai-codex", "openai"] as const;

/**
 * Static in-tree metadata for a canonical native slug the narrower override and pinned-native
 * tables do not carry. Falling through to null made input admission completely blind for
 * exactly those models, which is how a 128k target accepted a turn it could not finish.
 *
 * This deliberately covers slugs that are no longer offered in the picker: a retired slug is
 * still dispatchable when an operator names it explicitly in a combo target, and that is the
 * configuration where the gate was inert. This is a generated bundle compiled into the binary,
 * not a live catalog read, so it adds no I/O. Explicit provider and operator caps may only
 * narrow the result, never widen it.
 */
function generatedNativeWindow(
  modelId: string,
  configured: number | null,
  nativeContextCap: NativeContextLimitsInput | undefined,
): number | null {
  let generated: number | null = null;
  for (const catalog of NATIVE_METADATA_CATALOGS) {
    generated = positive(getModelMetadata(catalog, modelId)?.contextWindow);
    if (generated !== null) break;
  }
  if (generated === null) return null;
  const cap = typeof nativeContextCap === "number"
    ? positive(nativeContextCap)
    : positive(nativeContextCap?.cap);
  return Math.min(generated, configured ?? generated, cap ?? generated);
}

export function resolveInputCeiling(
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
  // Operator cap for the canonical native provider. Passed in rather than read from a
  // config here so this stays pure: no filesystem, no catalog, no registry scan.
  nativeContextCap?: NativeContextLimitsInput,
): number | null {
  return resolveContextLimits(provider, providerName, modelId, nativeContextCap).ceiling;
}

/**
 * Largest output the concrete target can emit. Used only to avoid reserving MORE than the
 * target could ever produce when a client asks for a bigger allowance than the model has.
 * Unknown stays unknown rather than inventing a capability.
 */
export function resolveOutputCeiling(
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
): number | null {
  const configured = positive(modelRecordValue(provider.modelMaxOutputTokens, modelId))
    ?? positive(provider.defaultMaxOutputTokens);
  const canonicalNativeBare = providerName === OPENAI_CODEX_PROVIDER_ID
    && isCanonicalOpenAiForwardProvider(provider)
    && !modelId.includes("/");
  const native = canonicalNativeBare ? positive(nativeOpenAiMaxOutputTokens(modelId)) : null;
  const limits = [configured, native].filter((v): v is number => v !== null);
  return limits.length === 0 ? null : Math.min(...limits);
}

/**
 * Combo-only admission. A fallback must be able to satisfy the caller's declared output
 * allowance inside its OWN context window. Otherwise it returns 200, emits a few hundred
 * tokens, and terminates on `finish_reason: length` — which the Anthropic surface renders as
 * "response exceeded the output token maximum" even though the real cause was the total
 * window. By then the next target cannot be tried, because output has already committed.
 *
 * Two budgets are checked separately so the reserve is counted exactly once. `ceiling` is an
 * input-only budget once `modelMaxInputTokens` tightens it below the window, so the output
 * reserve belongs against `window`, not against `ceiling`.
 *
 * Direct and single-target requests keep the deliberately loose 2.5x pathological-input gate.
 * This stricter rule applies only to synthetic combo children, where skipping one known-small
 * target is safe and the ladder continues before any upstream bytes are sent. Unknown context
 * stays fail-open, and a caller that declared no output allowance is unaffected.
 */
export function checkComboTargetInputAdmission(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
  nativeContextCap?: NativeContextLimitsInput,
): InputAdmissionResult {
  const { window, ceiling } = resolveContextLimits(provider, providerName, modelId, nativeContextCap);
  const requestedOutput = positive(parsed.options.maxOutputTokens);
  if (window === null || ceiling === null || requestedOutput === null) {
    return checkInputAdmission(parsed, provider, providerName, modelId, nativeContextCap);
  }
  const targetOutput = resolveOutputCeiling(provider, providerName, modelId);
  const requiredOutputHeadroom = targetOutput === null
    ? requestedOutput
    : Math.min(requestedOutput, targetOutput);
  const estimatedTokens = estimateInputTokens(parsed, modelId);
  return {
    admitted: estimatedTokens <= ceiling && estimatedTokens + requiredOutputHeadroom <= window,
    estimatedTokens,
    ceiling,
    requiredOutputHeadroom,
  };
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
