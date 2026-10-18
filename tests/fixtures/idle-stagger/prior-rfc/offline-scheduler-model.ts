/**
 * Deterministic, pure, OFFLINE reference model for OpenCodex issue #7206.
 * NOT production code. It performs no network I/O, no writes, and no warmups.
 * Provider classifications and permission decisions are explicit inputs.
 * Run tests: node --experimental-strip-types --test offline-scheduler-model.rfc-spec.ts
 */
export const FIVE_HOURS_MS = 300 * 60_000;
export const MINUTE_MS = 60_000;

export type WindowState =
  | 'UNKNOWN' | 'UNSTARTED_CANDIDATE' | 'ACTIVE_ANCHORED'
  | 'EXHAUSTED' | 'RESTART_ELIGIBLE' | 'VERIFYING' | 'BLOCKED';
export interface OfflineAccount {
  id: string;
  plan: 'plus' | 'other' | 'unknown';
  windowKind: 'five-hour' | 'weekly-only' | 'unknown';
  state: WindowState;
  optedIn: boolean;
  healthy: boolean;
  weeklyHeadroom: boolean;
  credentialGeneration: string;
  observedResetAtMs?: number;
  eligibleAtMs?: number;
  providerActivationApproved?: boolean;
  attemptState?: 'none' | 'reserved' | 'sent' | 'verifying' | 'ambiguous' | 'verified';
  alreadyAttemptedWindowKey?: string;
  windowEpochKey?: string;
}
export interface OfflinePolicy {
  enabled: boolean;
  allowedPlanning: boolean;
  idleAfterMinutes: number;
  initialSpreadHorizonMinutes: number;
  maxRepairDeferralMinutes: number;
  resolutionMinutes: number;
}
export interface OfflineInput {
  nowMs: number;
  policyStartAtMs: number;
  lastRealTrafficAtMs: number;
  activeRequests: number;
  planEpoch: number;
  policy: OfflinePolicy;
  accounts: OfflineAccount[];
}
export interface PlannedIntent {
  accountId: string;
  credentialGeneration: string;
  windowEpochKey: string;
  planEpoch: number;
  scheduledAtMs: number;
  earliestAtMs: number;
  purpose: 'initial' | 'repair';
  evidence: 'OFFLINE_PLAN_ONLY';
}
export interface OfflineResult {
  mode: 'DISABLED' | 'ACTIVE' | 'COOLDOWN' | 'IDLE_PLANNING' | 'OBSERVE_ONLY';
  eligibleN: number;
  targetSpacingMinutes: number | null;
  intents: PlannedIntent[];
  reasons: string[];
}
export const DEFAULT_POLICY: OfflinePolicy = {
  enabled: true,
  allowedPlanning: true,
  idleAfterMinutes: 30,
  initialSpreadHorizonMinutes: 300,
  maxRepairDeferralMinutes: 60,
  resolutionMinutes: 5,
};
function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isComparable(a: OfflineAccount): boolean {
  return a.plan === 'plus' && a.windowKind === 'five-hour'
    && a.optedIn && a.healthy && a.weeklyHeadroom
    && a.state !== 'UNKNOWN' && a.state !== 'BLOCKED'
    && a.state !== 'VERIFYING';
}
function isCandidate(a: OfflineAccount): boolean {
  return a.state === 'UNSTARTED_CANDIDATE' || a.state === 'RESTART_ELIGIBLE';
}
function mod(x: number, m: number): number { return ((x % m) + m) % m; }
function nextCycleAtOrAfter(candidateMs: number, earliestMs: number): number {
  return candidateMs >= earliestMs ? candidateMs
    : candidateMs + Math.ceil((earliestMs - candidateMs) / FIVE_HOURS_MS) * FIVE_HOURS_MS;
}
export function planIdleStagger(input: OfflineInput): OfflineResult {
  const reasons: string[] = [];
  const make = (mode: OfflineResult['mode'], eligibleN = 0, intents: PlannedIntent[] = []): OfflineResult => ({
    mode, eligibleN,
    targetSpacingMinutes: eligibleN >= 2 ? 300 / eligibleN : null,
    intents, reasons,
  });
  const p = input.policy;
  if (!p.enabled) return make('DISABLED');
  if (!finiteTime(input.nowMs) || !finiteTime(input.policyStartAtMs)
    || !finiteTime(input.lastRealTrafficAtMs) || input.activeRequests < 0
    || !Number.isFinite(input.planEpoch) || !Number.isInteger(input.planEpoch)
    || p.idleAfterMinutes < 0 || p.resolutionMinutes <= 0
    || p.initialSpreadHorizonMinutes < 0 || p.maxRepairDeferralMinutes < 0) {
    reasons.push('invalid-input');
    return make('OBSERVE_ONLY');
  }
  if (input.activeRequests > 0) return make('ACTIVE');
  if (input.nowMs < input.lastRealTrafficAtMs + p.idleAfterMinutes * MINUTE_MS) return make('COOLDOWN');
  if (!p.allowedPlanning) return make('OBSERVE_ONLY');

  const eligible = [...input.accounts].filter(isComparable).sort((a,b) => a.id.localeCompare(b.id));
  if (eligible.length < 2) {
    reasons.push('fewer-than-two-eligible-accounts');
    return make('IDLE_PLANNING', eligible.length);
  }
  const n = eligible.length;
  const active = eligible.filter(a => a.state === 'ACTIVE_ANCHORED' || a.state === 'EXHAUSTED');
  const anchored = active.filter(a => finiteTime(a.observedResetAtMs));
  if (active.length !== anchored.length) {
    reasons.push('anchored-account-has-no-verified-reset');
    return make('OBSERVE_ONLY', n);
  }
  const reference = anchored.length ? anchored[0] : null;
  const refIndex = reference ? eligible.findIndex(a => a.id === reference.id) : 0;
  const base = reference ? reference.observedResetAtMs! : input.policyStartAtMs;
  const intents: PlannedIntent[] = [];
  for (let index = 0; index < n; index++) {
    const a = eligible[index];
    if (!isCandidate(a)) continue;
    if (!finiteTime(a.eligibleAtMs) || !a.windowEpochKey) {
      reasons.push(a.id + ':missing-stable-local-eligibility-or-window-key');
      continue;
    }
    if (a.attemptState && a.attemptState !== 'none') {
      reasons.push(a.id + ':attempt-already-exists');
      continue;
    }
    if (a.alreadyAttemptedWindowKey === a.windowEpochKey) {
      reasons.push(a.id + ':already-attempted-this-window');
      continue;
    }
    const maxDelayMs = (a.state === 'UNSTARTED_CANDIDATE'
      ? p.initialSpreadHorizonMinutes : p.maxRepairDeferralMinutes) * MINUTE_MS;
    const indexDistance = mod(index - refIndex, n);
    const intendedOffset = indexDistance * FIVE_HOURS_MS / n;
    const earliest = Math.max(input.policyStartAtMs, a.eligibleAtMs);
    const intended = nextCycleAtOrAfter(base + intendedOffset, earliest);
    const bounded = Math.min(intended, earliest + maxDelayMs);
    const quantumMs = p.resolutionMinutes * MINUTE_MS;
    const snapped = earliest + Math.floor((bounded - earliest) / quantumMs) * quantumMs;
    const scheduled = Math.max(earliest, snapped);
    if (scheduled + quantumMs < input.nowMs) {
      reasons.push(a.id + ':missed-slot-needs-fresh-reconciliation');
      continue;
    }
    if (!a.providerActivationApproved) {
      reasons.push(a.id + ':provider-approval-missing-plan-only');
    }
    intents.push({
      accountId: a.id, credentialGeneration: a.credentialGeneration,
      windowEpochKey: a.windowEpochKey, planEpoch: input.planEpoch,
      scheduledAtMs: scheduled, earliestAtMs: earliest,
      purpose: a.state === 'UNSTARTED_CANDIDATE' ? 'initial' : 'repair',
      evidence: 'OFFLINE_PLAN_ONLY',
    });
  }
  intents.sort((a,b) => a.scheduledAtMs - b.scheduledAtMs || a.accountId.localeCompare(b.accountId));
  return make('IDLE_PLANNING', n, intents);
}
export function offlineDispatchGuard(input: OfflineInput, intent: PlannedIntent): { ok: boolean; reason: string } {
  if (!input.policy.enabled || !input.policy.allowedPlanning) return { ok: false, reason: 'policy-disabled' };
  if (input.activeRequests !== 0 || input.nowMs < input.lastRealTrafficAtMs + input.policy.idleAfterMinutes * MINUTE_MS) {
    return { ok: false, reason: 'foreground-or-quiet-period' };
  }
  if (intent.planEpoch !== input.planEpoch) return { ok: false, reason: 'stale-plan-epoch' };
  if (input.nowMs < intent.scheduledAtMs) return { ok: false, reason: 'not-due' };
  if (input.nowMs > intent.scheduledAtMs + input.policy.resolutionMinutes * MINUTE_MS) return { ok: false, reason: 'missed-deadline' };
  const a = input.accounts.find(x => x.id === intent.accountId);
  if (!a || !isComparable(a) || !isCandidate(a)) return { ok: false, reason: 'account-ineligible' };
  if (!a.providerActivationApproved) return { ok: false, reason: 'upstream-contract-not-approved' };
  if (!a.windowEpochKey || a.windowEpochKey !== intent.windowEpochKey
    || a.credentialGeneration !== intent.credentialGeneration) return { ok: false, reason: 'generation-mismatch' };
  if (a.alreadyAttemptedWindowKey === a.windowEpochKey || (a.attemptState && a.attemptState !== 'none')) {
    return { ok: false, reason: 'attempt-already-reserved-or-sent' };
  }
  return { ok: true, reason: 'offline-eligible-only-no-network-side-effect' };
}
