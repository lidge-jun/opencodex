import { nativeOpenAiContextTier, nativeOpenAiContextWindow, nativeOpenAiMaxInputTokens, type NativeContextLimitsInput } from "./metadata";
import {
  isNativeLargeContextVariant, isNativeContextVariantBase, stripCodexLargeContextAlias,
} from "./native-models";

/**
 * Explicit opt-in alias for native Codex models. Its suffix does not guarantee
 * exactly 900,000 tokens; route-specific metadata remains the limit authority.
 */
export interface NativeContextVariantEvidence {
  contextWindow: number;
  maxContextWindow: number;
  maxInputTokens: number;
}


export interface ResolvedNativeContextVariant {
  requestedModel: string;
  wireModel: string;
  mode: "standard" | "large";
  contextWindow: number;
  maxInputTokens: number;
}

export interface NativeContextVariantLimits {
  /** Existing operator/provider context setting, treated as a hard ceiling for this request. */
  hardContextCap?: number;
}

export { isNativeLargeContextVariant, isNativeContextVariantBase, stripCodexLargeContextAlias } from "./native-models";
export const LARGE_CONTEXT_ALIAS_SUFFIX = "-900k";
const LARGE_CONTEXT_SUFFIX = LARGE_CONTEXT_ALIAS_SUFFIX;

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Pure resolver. Caller must first establish the canonical native Codex route. */
export function resolveNativeContextVariant(
  requestedModel: string,
  evidence?: NativeContextVariantEvidence,
  limits: NativeContextVariantLimits = {},
): ResolvedNativeContextVariant | null {
  const isLarge = requestedModel.endsWith(LARGE_CONTEXT_SUFFIX);
  const wireModel = isLarge ? requestedModel.slice(0, -LARGE_CONTEXT_SUFFIX.length) : requestedModel;
  if (!isNativeContextVariantBase(wireModel)) return null;
  if (!evidence
    || !positiveSafeInteger(evidence.contextWindow)
    || !positiveSafeInteger(evidence.maxContextWindow)
    || !positiveSafeInteger(evidence.maxInputTokens)
    || evidence.maxContextWindow <= evidence.contextWindow) return null;
  if (isLarge && (requestedModel.endsWith(`${LARGE_CONTEXT_SUFFIX}${LARGE_CONTEXT_SUFFIX}`)
    || wireModel.includes("--")
    || wireModel.endsWith("-pro"))) return null;

  const hardCap = positiveSafeInteger(limits.hardContextCap) ? limits.hardContextCap : undefined;
  const baseWindow = Math.min(evidence.contextWindow, hardCap ?? evidence.contextWindow);
  const largeWindow = Math.min(evidence.maxContextWindow, hardCap ?? evidence.maxContextWindow);
  const inputCeiling = Math.min(evidence.maxInputTokens, hardCap ?? evidence.maxInputTokens);
  if (isLarge && (largeWindow <= baseWindow || (hardCap !== undefined && hardCap <= baseWindow))) return null;
  return {
    requestedModel,
    wireModel,
    mode: isLarge ? "large" : "standard",
    contextWindow: isLarge ? largeWindow : baseWindow,
    maxInputTokens: isLarge ? Math.min(inputCeiling, largeWindow) : Math.min(evidence.maxInputTokens, baseWindow),
  };
}

export function nativeLargeContextLimits(model: string, limits?: NativeContextLimitsInput): { window: number; ceiling: number } | null {
  if (!isNativeLargeContextVariant(model)) return null;
  const base = stripCodexLargeContextAlias(model);
  const tier = nativeOpenAiContextTier(base);
  const longWindow = tier?.longWindow ?? 872_000;
  const configured = typeof limits === "number" ? { cap: limits } : (limits ?? {});
  const levers = [longWindow, configured.cap, configured.providerWindow,
    configured.modelWindows?.[base], configured.modelWindows?.[model]]
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  const chosen = Math.min(...levers);
  const window = chosen;
  const inputs = [window,
    configured.modelMaxInputTokens?.[base], configured.modelMaxInputTokens?.[model]]
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  return { window, ceiling: Math.min(...inputs) };
}

