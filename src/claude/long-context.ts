/**
 * Long-context thresholds shared by every Claude surface
 * (devlog/_plan/261009_claude_1m_default/020_long_context_eligibility.md).
 *
 * A leaf module: desktop-3p.ts and desktop-profile.ts need the predicate, and context-windows.ts
 * already imports desktop-3p.ts, so the predicate cannot live there.
 */
import { isAnthropicInstanceId } from "../providers/anthropic-instance-id";

export const ONE_MILLION = 1_000_000;

/** A window at or below this is Claude Code's own default accounting; widening it gains nothing. */
export const AUTO_CONTEXT_FLOOR = 200_000;

/**
 * Auto-context defaults (devlog 260712 020, user-approved).
 *
 * The compact window is the token count at which Claude Code starts compacting, and it is
 * also the floor `shouldMarkOneMillion` uses — a model may only carry the marker if it can
 * host this window. 350,000 was chosen when the widest native row advertised 372,000.
 *
 * It now matches the auto-compaction limit the Codex catalog ships for the same models
 * (`nativeAutoCompactLimit`: 829,800 against the 922,000 native window). Leaving the two
 * apart meant one model compacting at 350k under Claude Code and at 829,800 under Codex.
 * The value stays clear of the measured 922,000 ceiling by ~92k, so compaction still has
 * room to run before the upstream refuses.
 */
export const AUTO_COMPACT_WINDOW_DEFAULT = 829_800;

/**
 * Whether a window earns the 1M selection on a surface whose Claude Code runner may not inherit
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW (Desktop pickers, discovery, Desktop 3P, generated subagents).
 * A window >= 1M always does. A smaller one does when it can host the default compact window, so
 * a runner that has the variable compacts in time, and one that lacks it overflows into the
 * `prompt is too long` envelope (anthropicErrorBody) and compacts reactively. The floor is fixed
 * on purpose: a custom compact window must not re-admit a 372k route (#854).
 */
export function isLongContextWindow(window: number | undefined): boolean {
  if (typeof window !== "number" || window <= 0) return false;
  return window >= ONE_MILLION || (window > AUTO_CONTEXT_FLOOR && window >= AUTO_COMPACT_WINDOW_DEFAULT);
}

/**
 * Desktop 3P / dashboard 1M eligibility. Real Anthropic routes (either pool) ride the native
 * passthrough and need a genuine 1M window; everything else follows isLongContextWindow.
 */
export function claudeSurfaceSupportsOneMillion(provider: string, window: number | undefined): boolean {
  if (isAnthropicInstanceId(provider)) return typeof window === "number" && window >= ONE_MILLION;
  return isLongContextWindow(window);
}
