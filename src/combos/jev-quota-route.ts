import { jevQuotaDecisionSummary, jevQuotaSignalForTarget } from "./jev-quota";
import { JEV_QUOTA_DEFAULT_TIERS, normalizeJevQuotaTiers } from "./jev-quota-config";
import type { JevCandidate, JevDecision, ResolveJevDecisionOptions } from "./jev";
/** Attach a loaded-only quota signal to each candidate when the combo opted in; otherwise return the candidates unchanged. */
export function jevQuotaCandidates(options: ResolveJevDecisionOptions): readonly JevCandidate[] {
  if (options.decisionQuotaSignals !== true) return options.candidates;
  const tiers = normalizeJevQuotaTiers(options.decisionQuotaTiers) ?? JEV_QUOTA_DEFAULT_TIERS;
  const now = (options.now ?? Date.now)();
  return options.candidates.map(candidate => ({ ...candidate,
    quota: jevQuotaSignalForTarget(options.config, candidate.provider, candidate.model, now, tiers) }));
}
/** Attach the per-tier quota summary to a decision when any candidate carried quota evidence. */
export function withJevQuotaSummary(decision: JevDecision, candidates: readonly JevCandidate[]): JevDecision {
  const quota = jevQuotaDecisionSummary(candidates, decision.targetKey);
  return quota ? { ...decision, quota } : decision;
}
/** Retries serialization without quota, never truncates ordinary evidence or the allowlist. */
export function boundedJevQuotaPayload(candidates: readonly JevCandidate[], build: (rows: readonly JevCandidate[]) => string, limit: number): { body: string; candidates: readonly JevCandidate[] } {
  let rows = candidates;
  let body = build(rows);
  if (new TextEncoder().encode(body).byteLength > limit && rows.some(row => row.quota)) {
    rows = rows.map(({ quota: _quota, ...row }) => row);
    body = build(rows);
  }
  return { body, candidates: rows };
}
