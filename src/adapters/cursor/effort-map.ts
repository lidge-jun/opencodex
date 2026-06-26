/**
 * Per-model Cursor reasoning-effort mapping.
 *
 * Cursor model ids encode the reasoning effort as a suffix (`claude-4.6-opus-high`), and the available
 * tiers differ per model — `claude-4.6-opus` tops out at `-max`, `claude-opus-4-8` at `-xhigh`,
 * `claude-4.6-sonnet` only has `-medium`, and `composer`/`grok`/`gemini` take no suffix at all. A bare
 * id for a model that requires a suffix is rejected `ERROR_BAD_MODEL_NAME` (devlog 350.105).
 *
 * `CURSOR_MODEL_EFFORT_TIERS` is the real catalog (from the Cursor `GetUsableModels` naming, mirrored in
 * jawcode's bundle), each base model -> its available suffixes in ascending order. `cursorEffortSuffix`
 * clamps a Codex reasoning effort onto that model's tiers so Codex's TOP effort maps to the model's TOP
 * tier (a `-max` model -> max, an `-xhigh` model -> xhigh), per the requested behavior.
 */

const CURSOR_MODEL_EFFORT_TIERS: Record<string, readonly string[]> = {
  "claude-4.5-opus": ["high"],
  "claude-4.6-opus": ["high", "max"],
  "claude-4.6-sonnet": ["medium"],
  "claude-fable-5": ["low", "medium", "high", "max", "xhigh"],
  "claude-opus-4-7": ["low", "medium", "high", "max", "xhigh"],
  "claude-opus-4-8": ["low", "medium", "high", "max", "xhigh"],
  "gpt-5.1": ["low", "high"],
  "gpt-5.1-codex": ["max"],
  "gpt-5.2": ["low", "high", "xhigh"],
  "gpt-5.2-codex": ["low", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high"],
  "gpt-5.5-extra": ["high"],
};

/** Collapse a Codex reasoning-effort label to a low/medium/high rank for clamping onto a model's tiers. */
function codexEffortRank(reasoning: string | undefined): "low" | "medium" | "high" {
  switch ((reasoning ?? "").toLowerCase()) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "max":
    case "xhigh":
      return "high";
    default:
      // No explicit effort: a bare reasoning-model id is invalid, so pick the model's top tier.
      return "high";
  }
}

/**
 * The Cursor effort suffix to use for `baseModelId` given a Codex reasoning effort, or `undefined` when
 * the model takes no suffix (bare). Codex's top effort maps to the model's top tier (max / xhigh).
 */
export function cursorEffortSuffix(baseModelId: string, reasoning: string | undefined): string | undefined {
  const tiers = CURSOR_MODEL_EFFORT_TIERS[baseModelId];
  if (!tiers || tiers.length === 0) return undefined;
  switch (codexEffortRank(reasoning)) {
    case "low":
      return tiers[0];
    case "high":
      return tiers[tiers.length - 1];
    case "medium":
      return tiers[Math.floor((tiers.length - 1) / 2)];
  }
}

/** Base models known to carry a reasoning-effort suffix (everything else is sent bare). */
export function cursorModelHasEffortTiers(baseModelId: string): boolean {
  return (CURSOR_MODEL_EFFORT_TIERS[baseModelId]?.length ?? 0) > 0;
}
