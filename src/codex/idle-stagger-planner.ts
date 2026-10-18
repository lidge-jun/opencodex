/**
 * Issue #7206, PR A: deterministic OFFLINE quota phase planner.
 * No credentials, HTTP, clock reads, persistence, timers, config writes or imports
 * from the live Codex account pool. Outputs are diagnostics, NOT send permits.
 */
export const FIVE_HOURS_MS = 300 * 60_000;
export const MINUTE_MS = 60_000;
export const MAX_COHORT = 1024;
export const MAX_ATTEMPTS = 4096;

export type EvidenceKind = "verified-five-hour" | "fixed" | "sliding" | "unknown";
export type WindowState = "unstarted" | "restart-eligible" | "anchored" | "exhausted" | "unknown";
export type AttemptStage = "reserved" | "send-boundary" | "sent" | "ambiguous" | "verified" | "failed";

export interface OfflineAccount {
  id: string;
  credentialGeneration: string;
  windowGeneration: string | null;
  evidence: EvidenceKind;
  state: WindowState;
  optedIn: boolean;
  healthy: boolean;
  weeklyHeadroom: boolean;
  observedAtMs: number;
  eligibleAtMs?: number;
  resetAtMs?: number;
}

export interface Attempt {
  accountId: string;
  credentialGeneration: string;
  windowGeneration: string;
  /** One physical operation may cover short + weekly; still only one reservation. */
  affectedWindows: readonly ("short" | "weekly")[];
  stage: AttemptStage;
  atMs: number;
}

export interface PlannerInput {
  nowMs: number;
  stableStartMs: number;
  lastForegroundSettledAtMs: number;
  activeAdmissions: number;
  activeStreams: number;
  epoch: number;
  enabled: boolean;
  observeOnly: boolean;
  idleAfterMs: number;
  initialHorizonMs: number;
  maxRepairDeferralMs: number;
  evidenceTtlMs: number;
  accounts: readonly OfflineAccount[];
  ledger: readonly Attempt[];
}

export interface OfflineSlot {
  readonly kind: "OFFLINE_DIAGNOSTIC_ONLY";
  readonly accountId: string;
  readonly credentialGeneration: string;
  readonly windowGeneration: string;
  readonly epoch: number;
  readonly earliestMs: number;
  readonly scheduledMs: number;
  readonly purpose: "initial" | "repair";
}

export interface PlannerResult {
  mode: "disabled" | "active" | "quiet" | "observe-only" | "offline-plan";
  comparableN: number;
  spacingTargetMs: number | null;
  slots: readonly OfflineSlot[];
  reasons: readonly string[];
}

const finite = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const mod = (n: number, size: number): number => ((n % size) + size) % size;
function atOrAfter(candidate: number, floor: number): number {
  return candidate >= floor ? candidate : candidate + Math.ceil((floor - candidate) / FIVE_HOURS_MS) * FIVE_HOURS_MS;
}
function attemptKey(a: Pick<OfflineAccount, "id" | "credentialGeneration" | "windowGeneration">): string {
  return JSON.stringify([a.id, a.credentialGeneration, a.windowGeneration]);
}

/** Pure function: a planned slot can never be used directly to authorize upstream sends. */
export function planIdleStagger(input: PlannerInput): PlannerResult {
  const reasons: string[] = [];
  const result = (mode: PlannerResult["mode"], n = 0, slots: OfflineSlot[] = []): PlannerResult => ({
    mode, comparableN: n, spacingTargetMs: n >= 2 ? FIVE_HOURS_MS / n : null, slots, reasons,
  });
  if (!input.enabled) return result("disabled");
  const numerics = [input.nowMs, input.stableStartMs, input.lastForegroundSettledAtMs,
    input.epoch, input.idleAfterMs, input.initialHorizonMs, input.maxRepairDeferralMs,
    input.evidenceTtlMs, input.activeAdmissions, input.activeStreams];
  if (numerics.some(n => !finite(n)) || input.accounts.length > MAX_COHORT || input.ledger.length >= MAX_ATTEMPTS
    || new Set(input.accounts.map(a => a.id)).size !== input.accounts.length) {
    reasons.push("invalid-or-over-cap-input");
    return result("observe-only");
  }
  if (input.activeAdmissions > 0 || input.activeStreams > 0) return result("active");
  if (input.nowMs < input.lastForegroundSettledAtMs + input.idleAfterMs) return result("quiet");
  if (input.observeOnly) return result("observe-only");

  const ledgerKeys = new Set(input.ledger.map(a => JSON.stringify([a.accountId, a.credentialGeneration, a.windowGeneration])));
  const comparable = input.accounts.filter(a => a.evidence === "verified-five-hour"
    && a.optedIn && a.healthy && a.weeklyHeadroom
    && !!a.windowGeneration && !!a.credentialGeneration
    && (a.state !== "unstarted" && a.state !== "restart-eligible" || finite(a.eligibleAtMs!))
    && finite(a.observedAtMs) && a.observedAtMs <= input.nowMs
    && input.nowMs - a.observedAtMs <= input.evidenceTtlMs)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (comparable.length < 2) {
    reasons.push("fewer-than-two-fresh-verified-comparable-accounts");
    return result("observe-only", comparable.length);
  }
  const n = comparable.length;
  const anchored = comparable.filter(a => a.state === "anchored" || a.state === "exhausted");
  if (anchored.some(a => a.windowGeneration === null || a.windowGeneration.length === 0 || !finite(a.resetAtMs!))) {
    reasons.push("ambiguous-anchored-window");
    return result("observe-only", n);
  }
  const reference = anchored[0];
  const base = reference ? reference.resetAtMs! : input.stableStartMs;
  const referenceIndex = reference ? comparable.indexOf(reference) : 0;
  const slots: OfflineSlot[] = [];
  for (let i = 0; i < n; i++) {
    const a = comparable[i];
    if (a.state !== "unstarted" && a.state !== "restart-eligible") continue;
    if (!a.windowGeneration || !a.credentialGeneration || !finite(a.eligibleAtMs!)) {
      reasons.push(a.id + ":ambiguous-window-generation-or-eligibility");
      continue;
    }
    if (ledgerKeys.has(attemptKey(a))) {
      reasons.push(a.id + ":existing-window-operation");
      continue;
    }
    const earliestMs = Math.max(input.stableStartMs, a.eligibleAtMs!);
    const offset = mod(i - referenceIndex, n) * FIVE_HOURS_MS / n;
    const target = atOrAfter(base + offset, earliestMs);
    const cap = a.state === "unstarted" ? input.initialHorizonMs : input.maxRepairDeferralMs;
    const scheduledMs = Math.min(target, earliestMs + cap);
    if (scheduledMs < input.nowMs) {
      reasons.push(a.id + ":missed-slot-needs-new-generation-evidence");
      continue;
    }
    slots.push({kind:"OFFLINE_DIAGNOSTIC_ONLY", accountId:a.id, credentialGeneration:a.credentialGeneration,
      windowGeneration:a.windowGeneration, epoch:input.epoch, earliestMs, scheduledMs,
      purpose:a.state === "unstarted" ? "initial" : "repair"});
  }
  slots.sort((a,b) => a.scheduledMs-b.scheduledMs || (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  return result("offline-plan", n, slots);
}

/** Read-only revalidation: NEVER an admission token or network/send permission. */
export function checkOfflineSlot(input: PlannerInput, slot: OfflineSlot): boolean {
  if (!input.enabled || input.observeOnly || input.activeAdmissions > 0 || input.activeStreams > 0
    || slot.epoch !== input.epoch || slot.kind !== "OFFLINE_DIAGNOSTIC_ONLY"
    || input.nowMs < input.lastForegroundSettledAtMs + input.idleAfterMs
    || input.nowMs !== slot.scheduledMs) return false;
  const renewed = planIdleStagger(input);
  return renewed.mode === "offline-plan" && renewed.slots.some(p =>
    p.accountId === slot.accountId && p.credentialGeneration === slot.credentialGeneration
    && p.windowGeneration === slot.windowGeneration && p.scheduledMs === slot.scheduledMs);
}

/** Pure ledger reducer: unknown outcomes never allow speculative retries. */
export function transitionAttempt(ledger: readonly Attempt[], event: Attempt): readonly Attempt[] {
  if (ledger.length >= MAX_ATTEMPTS) return ledger;
  if (!event.windowGeneration || !event.credentialGeneration || !finite(event.atMs)) return ledger;
  const key = JSON.stringify([event.accountId,event.credentialGeneration,event.windowGeneration]);
  const index = ledger.findIndex(a => JSON.stringify([a.accountId,a.credentialGeneration,a.windowGeneration]) === key);
  if (index < 0) return event.stage === "reserved" && event.affectedWindows.length > 0
    ? [...ledger, {...event, affectedWindows:[...new Set(event.affectedWindows)]}] : ledger;
  const old = ledger[index];
  const allowed: Record<AttemptStage, readonly AttemptStage[]> = {
    reserved:["send-boundary", "ambiguous"], "send-boundary":["sent","ambiguous"],
    sent:["ambiguous","verified","failed"], ambiguous:["verified","failed"],
    verified:[], failed:[],
  };
  if (!allowed[old.stage].includes(event.stage) || event.atMs < old.atMs) return ledger;
  const copy = [...ledger];
  copy[index] = {...old, stage:event.stage, atMs:event.atMs};
  return copy;
}

/** Nonterminal stages recovered after a crash become ambiguous, never auto-retried. */
export function recoverAttempts(ledger: readonly Attempt[]): readonly Attempt[] {
  return ledger.map(a => a.stage === "verified" || a.stage === "failed" ? a : {...a,stage:"ambiguous" as const});
}
