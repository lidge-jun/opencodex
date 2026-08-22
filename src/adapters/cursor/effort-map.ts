/**
 * Per-model Cursor reasoning-effort mapping.
 *
 * Cursor model ids encode the reasoning effort as a suffix (`claude-4.6-opus-high`), and the available
 * tiers differ per model — `claude-4.6-opus` tops out at `-max`, `claude-opus-4-8` at `-xhigh`,
 * `claude-4.6-sonnet` only has `-medium`, and most `composer`/`gemini` models take no suffix at all.
 * Grok Fast puts its mode marker after the effort (`grok-4.6-xhigh-fast`). A bare id for a model that
 * requires a suffix is rejected `ERROR_BAD_MODEL_NAME` (devlog 350.105).
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
  // Opus Fast tiers from the 260822 GetUsableModels dump (devlog .../300): the wire
  // exposes {base-without-fast}-{effort}-fast only; suffix derivation at the bottom of
  // this file produces those ids. opus-5-fast has no xhigh/max (non-thinking) yet.
  "claude-opus-4-7-fast": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8-fast": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-fast": ["low", "medium", "high"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "glm-5.2": ["high", "max"],
  // 260814 preemptive: glm-5.3 seeded ahead of Cursor's lineup update. Unlike 5.2, Z.AI folds
  // 5.3 efforts into low/high/max (docs.z.ai/devpack/latest-model), so `low` is a real tier.
  "glm-5.3": ["low", "high", "max"],
  // GetUsableModels (2026-07-28) lists kimi-k3 only as effort-suffixed kimi-k3-{low,high,max};
  // the bare id returns not_found. Tiers mirror the native Kimi provider's K3 ladder.
  "kimi-k3": ["low", "high", "max"],
  // Cursor renamed the Grok 4.5 slugs to cursor-grok-4.5-{low,medium,high} and
  // cursor-grok-4.5-{low,medium,high}-fast. The bare Fast id returns not_found.
  "grok-4.5": ["low", "medium", "high"],
  "grok-4.5-fast": ["low", "medium", "high"],
  // Cursor's 260813 lineup exposes Grok 4.6 Extra High in both regular and Fast forms.
  "grok-4.6": ["low", "medium", "high", "xhigh"],
  "grok-4.6-fast": ["low", "medium", "high", "xhigh"],
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
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
};

/** All effort suffixes accepted when matching live Cursor model ids to configured base ids. */
export const CANONICAL_EFFORT_SUFFIXES: ReadonlySet<string> = new Set([
  "none",
  ...Object.values(CURSOR_MODEL_EFFORT_TIERS).flat(),
]);

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

/**
 * Compose Cursor's flattened model id from a Codex-facing base id and effort tier. Discovery uses
 * this for the ids returned by GetUsableModels. Parameterized Grok Fast requests bypass the flat id
 * and send the base model plus requested_model parameters instead.
 */
export function cursorWireModelIdWithEffort(baseModelId: string, effortSuffix: string): string {
  if (baseModelId.endsWith("-fast")) {
    return `${baseModelId.slice(0, -"-fast".length)}-${effortSuffix}-fast`;
  }
  return `${baseModelId}-${effortSuffix}`;
}

/**
 * Compose the exact flattened id sent by AgentService/Run. Discovery normalizes Cursor's optional
 * `cursor-` prefix only for catalog matching, but regular Grok 4.5 requests require that prefix on
 * the wire. Keep this separate from {@link cursorWireModelIdWithEffort} so discovery can continue
 * comparing canonical, prefix-free ids. Grok Fast uses requested_model parameters instead.
 */
export function cursorRequestWireModelIdWithEffort(baseModelId: string, effortSuffix: string): string {
  const flattened = cursorWireModelIdWithEffort(baseModelId, effortSuffix);
  return baseModelId === "grok-4.5" || baseModelId === "grok-4.6" ? `cursor-${flattened}` : flattened;
}
