/**
 * ZCode's current GLM-5.3 family exposes three effective thought levels. `ultra`
 * remains a Codex orchestration tier: codex-rs delegates at `max`, while the
 * official Desktop runtime receives only a real ZCode level.
 */
export const ZCODE_GLM53_REASONING_EFFORTS = ["low", "high", "max"] as const;

export interface ZcodeReasoningContract {
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
}

/** Match the native model component while retaining the Desktop provider prefix. */
export function isZcodeGlm53Model(modelId: string): boolean {
  const native = modelId.trim().toLowerCase().split("/").at(-1);
  return native === "glm-5.3" || native === "glm-5.3[1m]" || native === "glm-5.3-flash";
}

/** Undefined means that ZCode has no audited Codex effort contract for this model. */
export function zcodeReasoningContract(modelId: string): ZcodeReasoningContract | undefined {
  if (!isZcodeGlm53Model(modelId)) return undefined;
  return { reasoningEfforts: [...ZCODE_GLM53_REASONING_EFFORTS], defaultReasoningEffort: "max" };
}

/**
 * Normalize direct/stale client labels to the three values accepted by the
 * official Desktop runtime. The normal Codex path already changes ultra to max;
 * handling it here as well keeps the app-server boundary fail-safe.
 */
export function zcodeThoughtLevel(modelId: string, requested: string | undefined): string | undefined {
  if (!requested || !isZcodeGlm53Model(modelId)) return undefined;
  if (requested === "low" || requested === "minimal") return "low";
  if (requested === "high" || requested === "medium") return "high";
  if (requested === "max" || requested === "xhigh" || requested === "ultra") return "max";
  return undefined;
}
