import { NATIVE_OPENAI_MODELS, nativeReasoningEfforts } from "../codex/catalog/metadata";
import {
  VISION_REASONING_EFFORTS,
  sanitizeVisionReasoning,
  type VisionReasoningEffort,
} from "../reasoning-effort";

/** Keep the public config type aligned without replacing the heavily-changed shared types file. */
declare module "../types" {
  interface OcxVisionSidecarConfig {
    /** OpenAI Responses reasoning effort used by the vision describer. Default: low. */
    reasoning?: VisionReasoningEffort;
  }
}

const NATIVE_VISION_MODELS = new Set(NATIVE_OPENAI_MODELS);

/**
 * Return the known vision reasoning ladder for a native OpenAI model.
 * Unknown/custom models deliberately return undefined so callers stay permissive when reliable
 * capability metadata is unavailable.
 */
export function nativeVisionReasoningEfforts(modelId: string): VisionReasoningEffort[] | undefined {
  if (!NATIVE_VISION_MODELS.has(modelId)) return undefined;
  const advertised = new Set(nativeReasoningEfforts(modelId));
  const supported = VISION_REASONING_EFFORTS.filter(effort => advertised.has(effort));
  return supported.length > 0 ? [...supported] : undefined;
}

/**
 * Normalize one configured effort against a model's known ladder. Invalid enum values degrade to
 * undefined; valid values on unknown/custom models are preserved. A known native model clamps to
 * the highest supported rung at or below the requested value.
 */
export function normalizeVisionReasoningForModel(
  modelId: string,
  value: unknown,
): VisionReasoningEffort | undefined {
  const requested = sanitizeVisionReasoning(value);
  if (!requested) return undefined;
  const supported = nativeVisionReasoningEfforts(modelId);
  if (!supported || supported.includes(requested)) return requested;

  const requestedRank = VISION_REASONING_EFFORTS.indexOf(requested);
  let best = supported[0];
  let bestRank = VISION_REASONING_EFFORTS.indexOf(best);
  for (const effort of supported) {
    const rank = VISION_REASONING_EFFORTS.indexOf(effort);
    if (rank <= requestedRank && rank >= bestRank) {
      best = effort;
      bestRank = rank;
    }
  }
  return best;
}
