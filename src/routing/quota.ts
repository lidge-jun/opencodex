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

import {
  codexQuotaWindowForPlan,
  getAccountQuota,
  isCodexQuotaExhausted,
  listAccountQuotas,
} from "../codex/quota";
import { getCachedProviderAccountQuota } from "../providers/quota";
import type { RouteQuotaEvidence } from "./trace";

export interface QuotaEvidenceInput {
  provider: string;
  model: string;
  accountRef?: string;
  codexAccountId?: string;
  codexAccountPlan?: string;
}

export interface CodexPoolQuotaAccount {
  accountId: string;
  plan?: string;
}

function codexAccountQuotaEvidence(accountId: string, plan?: string): RouteQuotaEvidence {
  const quota = getAccountQuota(accountId);
  if (!quota) return { known: false };
  const monthly = codexQuotaWindowForPlan(plan) === "monthly";
  const percents = [
    ...(monthly ? [] : [quota.weeklyPercent]),
    quota.monthlyPercent,
    // The burst window is upstream-enforced independently of the governing window, so an
    // account at 97% here has 3% headroom whatever its weekly figure says. This was invisible
    // while the header parser misfiled 5h readings into weeklyPercent - routing saw the burst
    // by accident. Once that is fixed, omitting it here reports 88% headroom for an account
    // that is one request away from a 429. computeCodexUsageScore already folds it in.
    quota.shortPercent,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const maxPercent = percents.length > 0 ? Math.max(...percents) : undefined;
  // Credits-only snapshots prove neither usage nor exhaustion. Unknown must not
  // become healthy capacity merely because a cache row exists.
  if (maxPercent === undefined) return { known: false };
  const resets = [
    ...(monthly ? [] : [quota.weeklyResetAt]),
    quota.monthlyResetAt,
    // Pair the reset with the window that can actually gate the next request: a burst-limited
    // account recovers in hours, and reporting a distant weekly reset would defer a retry that
    // is already safe.
    quota.shortResetAt,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .filter(value => value > Date.now());
  return {
    known: true,
    headroom: Math.max(0, Math.min(1, 1 - maxPercent / 100)),
    exhausted: isCodexQuotaExhausted(quota, plan),
    ...(resets.length > 0 ? { resetAtMs: Math.min(...resets) } : {}),
    source: "codex-pool",
  };
}

export function codexPoolQuotaEvidence(accounts: readonly CodexPoolQuotaAccount[]): RouteQuotaEvidence {
  if (accounts.length === 0) return { known: false };
  const evidence = accounts.map(account => codexAccountQuotaEvidence(account.accountId, account.plan));
  const known = evidence.filter(item => item.known);
  if (known.length === 0) return { known: false };
  const usable = known.filter(item => item.exhausted !== true);
  if (usable.length > 0) {
    const headrooms = usable.map(item => item.headroom)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return {
      known: true,
      exhausted: false,
      ...(headrooms.length > 0 ? { headroom: Math.max(...headrooms) } : {}),
      source: "codex-pool",
    };
  }
  if (known.length < evidence.length) return { known: false };
  const resets = known.map(item => item.resetAtMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    known: true,
    exhausted: true,
    headroom: 0,
    ...(resets.length > 0 ? { resetAtMs: Math.min(...resets) } : {}),
    source: "codex-pool",
  };
}

export function quotaEvidenceForCandidate(input: QuotaEvidenceInput): RouteQuotaEvidence {
  if (input.provider === "openai" && input.codexAccountId) {
    // listAccountQuotas() is the reconciled quota snapshot: config-generation
    // reconciliation prunes removed accounts. Other eligibility dimensions
    // (pause/reauth/cooldown/soft-avoid) remain health/pool-selector concerns.
    if (input.codexAccountPlan !== undefined) {
      const pool = [...listAccountQuotas()].map(([accountId]) => ({
        accountId,
        ...(accountId === input.codexAccountId ? { plan: input.codexAccountPlan } : {}),
      }));
      if (pool.length > 1) return codexPoolQuotaEvidence(pool);
    }
    return codexAccountQuotaEvidence(input.codexAccountId, input.codexAccountPlan);
  }

  if (input.provider === "anthropic" && input.accountRef) {
    const quota = getCachedProviderAccountQuota("anthropic", input.accountRef);
    if (quota) {
      const family = anthropicFamilyWindow(input.model, quota.customWindows ?? []);
      const percents = [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent, family?.percent]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const maxPercent = percents.length > 0 ? Math.max(...percents) : undefined;
      const resets = [quota.fiveHourResetAt, quota.weeklyResetAt, quota.monthlyResetAt, family?.resetAt]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .filter(value => value > Date.now());
      return {
        known: true,
        ...(maxPercent !== undefined ? { headroom: Math.max(0, Math.min(1, 1 - maxPercent / 100)) } : {}),
        exhausted: maxPercent !== undefined && maxPercent >= 100,
        ...(resets.length > 0 ? { resetAtMs: Math.min(...resets) } : {}),
        source: "provider-report",
      };
    }
  }
  return { known: false };
}

function anthropicFamilyWindow(
  model: string,
  windows: Array<{ label: string; percent?: number; resetAt?: number }>,
): { percent?: number; resetAt?: number } | undefined {
  const normalized = model.toLowerCase();
  for (const window of windows) {
    const family = window.label.trim().toLowerCase();
    if (family && normalized.includes(family)) return window;
  }
  return undefined;
}

export function quotaScore(evidence: RouteQuotaEvidence | undefined): number | null {
  if (!evidence || !evidence.known) return null;
  if (evidence.exhausted === true) return 0;
  if (typeof evidence.headroom === "number") return Math.max(0, Math.min(1, evidence.headroom));
  return null;
}
