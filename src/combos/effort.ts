import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { isCodexReasoningEffort } from "../reasoning-effort";
import { resolveCappedEffort, supportedLadderFor } from "../server/effort-policy";
import { COMBO_DEFAULT_EFFORT, getCombo } from "./types";

/**
 * When a combo request omits `reasoning.effort`, fill in the combo's `defaultEffort`
 * (default medium) **only if the resolved target exposes a reasoning ladder**.
 *
 * - Client-sent effort is never overridden.
 * - Empty ladder (`noReasoningModels` / no effort control) → leave unset.
 * - Unknown ladder (`supportedLadderFor` → undefined) → leave unset (don't invent).
 * - Known ladder → apply default, clamped to the highest supported rung at/below it.
 */
export function applyComboDefaultEffort(
  parsed: OcxParsedRequest,
  config: OcxConfig,
  comboId: string,
  route: { provider: OcxProviderConfig; modelId: string },
): string | null {
  if (parsed.options.reasoning) return null;
  const supported = supportedLadderFor(route);
  if (!supported || supported.length === 0) return null;

  const combo = getCombo(config, comboId);
  const desired = combo?.defaultEffort ?? COMBO_DEFAULT_EFFORT;
  if (!isCodexReasoningEffort(desired)) return null;

  const effort = resolveCappedEffort(desired, supported);
  if (!effort || !isCodexReasoningEffort(effort)) return null;

  parsed.options.reasoning = effort;
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    const body = parsed._rawBody as { reasoning?: { effort?: string } & Record<string, unknown> };
    const prev = body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {};
    body.reasoning = { ...prev, effort };
  }
  return effort;
}
