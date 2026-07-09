/**
 * Per-model Cursor reasoning-effort mapping.
 *
 * Cursor model ids encode the reasoning effort as a suffix (`claude-4.6-opus-high`), and the available
 * tiers differ per model — `claude-4.6-opus` tops out at `-max`, `claude-opus-4-8` at `-xhigh`,
 * `claude-4.6-sonnet` only has `-medium`, and `composer`/`grok`/`gemini` take no suffix at all. A bare
 * id for a model that requires a suffix is rejected `ERROR_BAD_MODEL_NAME` (devlog 350.105).
 *
 * Canonical effort order is always low < medium < high < xhigh < max (max is the top tier, confirmed
 * against Anthropic docs and Cursor's live lineup). Tiers are stored in ascending canonical order.
 *
 * `CURSOR_MODEL_EFFORT_TIERS` is the real catalog (from the Cursor `GetUsableModels` naming, mirrored in
 * jawcode's bundle), each base model -> its available suffixes in ascending order. `cursorEffortSuffix`
 * is literal-first: when the requested effort is one of the model's tiers, the effort you name is the
 * suffix Cursor receives. It only clamps Codex effort ranks for efforts outside that model's tier set.
 */

const CURSOR_MODEL_EFFORT_TIERS: Record<string, readonly string[]> = {
  "claude-4.5-opus": ["high"],
  "claude-4.6-opus": ["high", "max"],
  "claude-4.6-sonnet": ["medium"],
  // max is always the top tier (canonical order: low < medium < high < xhigh < max), confirmed
  // against Anthropic's effort ladder docs and Cursor's live model lineup.
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "glm-5.2": ["high", "max"],
  // GetUsableModels (2026-07-09) lists grok-4.5-{medium,high,xhigh} and grok-4.5-fast-{medium,high,xhigh};
  // the bare "grok-4.5-fast" id was removed upstream and now returns not_found.
  "grok-4.5": ["medium", "high", "xhigh"],
  "grok-4.5-fast": ["medium", "high", "xhigh"],
  "gpt-5.1": ["low", "high"],
  "gpt-5.1-codex-max": ["low", "medium", "high", "xhigh"],
  "gpt-5.1-codex-mini": ["low", "high"],
  "gpt-5.2": ["low", "high", "xhigh"],
  "gpt-5.2-codex": ["low", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high"],
  "gpt-5.5-extra": ["high"],
};

const CANONICAL_CODEX_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

function normalizeRequestedEffort(reasoning: string | undefined): string | undefined {
  const normalized = reasoning?.toLowerCase();
  return normalized === "ultra" ? "max" : normalized;
}

/** Collapse a Codex reasoning-effort label to a low/medium/high rank for clamping onto a model's tiers. */
function codexEffortRank(reasoning: string | undefined): "low" | "medium" | "high" {
  switch (normalizeRequestedEffort(reasoning) ?? "") {
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
 * the model takes no suffix (bare). Literal model tiers pass through; unknown efforts clamp by rank.
 */
export function cursorEffortSuffix(baseModelId: string, reasoning: string | undefined): string | undefined {
  const tiers = CURSOR_MODEL_EFFORT_TIERS[baseModelId];
  if (!tiers || tiers.length === 0) return undefined;
  const requested = normalizeRequestedEffort(reasoning);
  if (requested && tiers.includes(requested)) return requested;
  switch (codexEffortRank(reasoning)) {
    case "low":
      return tiers[0];
    case "high":
      return tiers[tiers.length - 1];
    case "medium":
      return tiers[Math.floor((tiers.length - 1) / 2)];
  }
}

/** The Codex-facing picker ladder for a Cursor model, sorted in canonical Codex effort order. */
export function cursorModelEffortLadder(baseModelId: string): string[] | undefined {
  const tiers = CURSOR_MODEL_EFFORT_TIERS[baseModelId];
  if (!tiers || tiers.length === 0) return undefined;
  const tierSet = new Set(tiers);
  return CANONICAL_CODEX_EFFORT_ORDER.filter(effort => tierSet.has(effort));
}

/** Base models known to carry a reasoning-effort suffix (everything else is sent bare). */
export function cursorModelHasEffortTiers(baseModelId: string): boolean {
  return (CURSOR_MODEL_EFFORT_TIERS[baseModelId]?.length ?? 0) > 0;
}
