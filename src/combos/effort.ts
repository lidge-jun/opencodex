import type { OcxConfig, OcxParsedRequest } from "../types";
import { isCodexReasoningEffort } from "../reasoning-effort";
import { COMBO_DEFAULT_EFFORT, getCombo } from "./types";

/**
 * When a combo request omits `reasoning.effort`, fill in the combo's `defaultEffort`
 * (default medium). Client-sent effort is never overridden.
 */
export function applyComboDefaultEffort(
  parsed: OcxParsedRequest,
  config: OcxConfig,
  comboId: string,
): string | null {
  if (parsed.options.reasoning) return null;
  const combo = getCombo(config, comboId);
  const effort = combo?.defaultEffort ?? COMBO_DEFAULT_EFFORT;
  if (!isCodexReasoningEffort(effort)) return null;
  parsed.options.reasoning = effort;
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    const body = parsed._rawBody as { reasoning?: { effort?: string } & Record<string, unknown> };
    const prev = body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {};
    body.reasoning = { ...prev, effort };
  }
  return effort;
}
