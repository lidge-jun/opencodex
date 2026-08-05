/**
 * Quota-aware policy scoring (RI-07).
 *
 * Evidence reuses the existing privacy-safe quota sources: the Codex pool
 * account quota cache (usage percents only - no emails, tokens, or raw
 * responses) and the provider per-account quota cache (Anthropic). Unknown
 * quota stays unknown; no raw quota response ever reaches a trace.
 *
 * Boundary: policy profiles select provider/model TARGETS. Exact account
 * selectors and Codex pool strategies remain authoritative inside their
 * existing scope; account-level quota evidence is consumed when a candidate
 * carries an account reference (dry-run/evaluate), never invented.
 */

import { codexQuotaWindowForPlan, getAccountQuota, isCodexQuotaExhausted } from "../codex/quota";
import { getCachedProviderAccountQuota } from "../providers/quota";
import type { RouteQuotaEvidence } from "./trace";

export interface QuotaEvidenceInput {
  provider: string;
  model: string;
  /** Opaque account reference for per-account quota sources. */
  accountRef?: string;
  /** Codex pool account id (provider "openai"). */
  codexAccountId?: string;
  /** The account's plan (provider "openai"); selects the governing quota window. */
  codexAccountPlan?: string;
}

/**
 * Assemble quota evidence from canonical local caches only (no network).
 * Unknown dimensions stay unknown - never zero.
 */
export function quotaEvidenceForCandidate(input: QuotaEvidenceInput): RouteQuotaEvidence {
  if (input.provider === "openai" && input.codexAccountId) {
    const quota = getAccountQuota(input.codexAccountId);
    if (quota) {
      // Go/Free accounts report a 30-day window only; weekly windows gate
      // everything else. `codexQuotaWindowForPlan` is the single shared rule
      // (parser, exhaustion, recovery), so select the plan-specific bars here
      // too instead of always combining weekly + monthly.
      const monthly = codexQuotaWindowForPlan(input.codexAccountPlan) === "monthly";
      const percents = [
        ...(monthly ? [] : [quota.weeklyPercent]),
        quota.monthlyPercent,
      ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const maxPercent = percents.length > 0 ? Math.max(...percents) : undefined;
      const resets = [
        ...(monthly ? [] : [quota.weeklyResetAt]),
        quota.monthlyResetAt,
      ].filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .filter(value => value > Date.now());
      return {
        known: true,
        ...(maxPercent !== undefined
          ? { headroom: Math.max(0, Math.min(1, 1 - maxPercent / 100)) }
          : {}),
        exhausted: isCodexQuotaExhausted(quota, input.codexAccountPlan),
        ...(resets.length > 0 ? { resetAtMs: Math.min(...resets) } : {}),
        source: "codex-pool",
      };
    }
  }

  if (input.provider === "anthropic" && input.accountRef) {
    const quota = getCachedProviderAccountQuota("anthropic", input.accountRef);
    if (quota) {
      // Anthropic per-family buckets (e.g. Opus / Sonnet) are stricter than the
      // broad account windows: fold the candidate model's matching bucket into
      // headroom and exhaustion so a model-specific overage is not hidden by
      // a healthy aggregate window.
      const family = anthropicFamilyWindow(input.model, quota.customWindows ?? []);
      const percents = [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent, family?.percent]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const maxPercent = percents.length > 0 ? Math.max(...percents) : undefined;
      const resets = [quota.fiveHourResetAt, quota.weeklyResetAt, quota.monthlyResetAt, family?.resetAt]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .filter(value => value > Date.now());
      return {
        known: true,
        ...(maxPercent !== undefined
          ? { headroom: Math.max(0, Math.min(1, 1 - maxPercent / 100)) }
          : {}),
        exhausted: maxPercent !== undefined && maxPercent >= 100,
        ...(resets.length > 0 ? { resetAtMs: Math.min(...resets) } : {}),
        source: "provider-report",
      };
    }
  }

  return { known: false };
}

/**
 * Match the candidate model to an Anthropic per-family quota window. Window
 * labels from the provider probe are "Opus" / "Sonnet"; model ids carry the
 * family as a segment (e.g. `claude-opus-...`, `claude-sonnet-...`). Returns
 * undefined when no family window is cached or no label matches.
 */
function anthropicFamilyWindow(
  model: string,
  windows: Array<{ label: string; percent?: number; resetAt?: number }>,
): { percent?: number; resetAt?: number } | undefined {
  const normalized = model.toLowerCase();
  for (const window of windows) {
    const family = window.label.trim().toLowerCase();
    if (family && normalized.includes(family)) {
      return window;
    }
  }
  return undefined;
}

/**
 * Deterministic quota score in [0,1]: larger available headroom scores
 * higher; exhausted evidence scores 0. Unknown evidence returns null so the
 * caller can apply the profile's unknownEvidence policy.
 */
export function quotaScore(evidence: RouteQuotaEvidence | undefined): number | null {
  if (!evidence || !evidence.known) return null;
  if (evidence.exhausted === true) return 0;
  if (typeof evidence.headroom === "number") return Math.max(0, Math.min(1, evidence.headroom));
  return null;
}
