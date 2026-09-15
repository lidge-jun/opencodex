import { randomUUID } from "node:crypto";
import { isCodexAccountGenerationLive, readCodexAccountRecord, type CodexRefreshProvenance } from "../account-store";
import { isCodexAccountPaused } from "../account-pause";
import { isSelectableCodexPoolAccount } from "../account-id";
import { isAccountNeedsReauth } from "../account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import type { OcxConfig } from "../../types";
import { CODEX_QUOTA_PROBE_INTERVAL_MS, type CodexUpstreamOutcomeMeta } from "./cooldown-math";
import {
  deleteScopedHealth,
  getAccountHealth,
  listScopedHealthEntries,
  scopedHealthFor,
  setAccountHealth,
  setScopedHealth,
  type CodexQuotaScope,
  type CodexUpstreamHealth,
} from "./health-store";

export type CodexQuotaRecoveryProbeClaim = {
  accountId: string;
  scope?: CodexQuotaScope;
  leaseId: string;
  cooldownGeneration: number;
  credentialGeneration: number;
  /** Claim-time `replacedAt`; unchanged after a probe-owned refresh, stamped on external replacement. */
  credentialReplacedAt?: number;
};

export type CodexQuotaRecoveryProbeProof = {
  credentialGeneration?: number;
};

/**
 * Grant at most one probe lease per interval for a cooled-down account.
 *
 * A cooled-down account is short-circuited locally, so it never sends traffic and
 * no organic 2xx can prove that upstream quota recovered — the cooldown can only
 * end by expiry or a proxy restart (#433). Releasing a single probe breaks that
 * deadlock. Explicit Retry-After cooldowns are excluded: those are literal retry
 * directives, not window announcements.
 *
 * Returns the lease id, or null when no probe may go out right now.
 */
export function tryAcquireCodexQuotaProbeLease(accountId: string, now = Date.now()): string | null {
  if (!canAcquireCodexQuotaProbeLease(accountId, now)) return null;
  const health = getAccountHealth(accountId)!;
  const probeLeaseId = randomUUID();
  setAccountHealth(accountId, {
    ...health,
    probeLeaseId,
    probeLeaseGeneration: health.cooldownGeneration ?? 0,
    lastProbeAt: now,
  });
  return probeLeaseId;
}

/** Side-effect-free check mirroring {@link tryAcquireCodexQuotaProbeLease} eligibility. */
export function canAcquireCodexQuotaProbeLease(accountId: string, now = Date.now()): boolean {
  return canAcquireQuotaProbeLease(getAccountHealth(accountId), now);
}

function canAcquireQuotaProbeLease(health: CodexUpstreamHealth | undefined, now: number): boolean {
  if (!health) return false;
  const cooldownUntil = health.cooldownUntil;
  if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return false;
  if (health.cooldownSource === "retry-after") return false;
  if (health.probeLeaseId !== undefined) return false;
  const origin = health.lastProbeAt ?? health.cooldownSince ?? cooldownUntil;
  return now - origin >= CODEX_QUOTA_PROBE_INTERVAL_MS;
}

/**
 * Claim due reset-derived cooldown probes without consulting account selection.
 * Added Pool credentials only; owned main usage recovery is handled separately.
 */
export function claimDueCodexQuotaRecoveryProbes(
  config: OcxConfig,
  limit: number,
  now = Date.now(),
): CodexQuotaRecoveryProbeClaim[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const candidates: Array<{
    accountId: string;
    scope?: CodexQuotaScope;
    health: CodexUpstreamHealth;
    credentialGeneration: number;
    credentialReplacedAt?: number;
    order: number;
  }> = [];
  for (const [order, account] of (config.codexAccounts ?? []).entries()) {
    if (!isSelectableCodexPoolAccount(account)
      || isCodexAccountPaused(config, account.id)
      || isAccountNeedsReauth(account.id)) continue;
    const record = readCodexAccountRecord(account.id);
    if (!record?.credential || record.deletedAt != null) continue;
    const due = [
      { scope: undefined, health: getAccountHealth(account.id) },
      ...[...(listScopedHealthEntries(account.id))].map(([scope, health]) => ({ scope, health })),
    ].filter((entry): entry is { scope?: CodexQuotaScope; health: CodexUpstreamHealth } =>
      // Generic WHAM evidence can recover only ordinary quota, never Reserve.
      // Do not spend this account's one claim per pass on an independent scope and
      // delay the shared scope that the response can actually recover.
      (entry.scope === undefined || entry.scope === "shared")
      && entry.health?.cooldownSource === "reset-derived"
      && canAcquireQuotaProbeLease(entry.health, now))
      .sort((a, b) =>
        (a.health.lastProbeAt ?? a.health.cooldownSince ?? 0)
        - (b.health.lastProbeAt ?? b.health.cooldownSince ?? 0));
    const candidate = due[0];
    if (candidate) candidates.push({
      accountId: account.id,
      ...(candidate.scope ? { scope: candidate.scope } : {}),
      health: candidate.health,
      credentialGeneration: record.generation,
      ...(record.replacedAt !== undefined ? { credentialReplacedAt: record.replacedAt } : {}),
      order,
    });
  }
  candidates.sort((a, b) => {
    const age = (a.health.lastProbeAt ?? a.health.cooldownSince ?? 0)
      - (b.health.lastProbeAt ?? b.health.cooldownSince ?? 0);
    return age || a.order - b.order;
  });
  return candidates.slice(0, boundedLimit).map(candidate => {
    const leaseId = randomUUID();
    const next = {
      ...candidate.health,
      probeLeaseId: leaseId,
      probeLeaseGeneration: candidate.health.cooldownGeneration ?? 0,
      lastProbeAt: now,
    };
    if (candidate.scope) setScopedHealth(candidate.accountId, candidate.scope, next);
    else setAccountHealth(candidate.accountId, next);
    return {
      accountId: candidate.accountId,
      ...(candidate.scope ? { scope: candidate.scope } : {}),
      leaseId,
      cooldownGeneration: candidate.health.cooldownGeneration ?? 0,
      credentialGeneration: candidate.credentialGeneration,
      ...(candidate.credentialReplacedAt !== undefined
        ? { credentialReplacedAt: candidate.credentialReplacedAt }
        : {}),
    };
  });
}

type CooldownRecoveryLease = Pick<CodexQuotaRecoveryProbeClaim,
  "accountId" | "scope" | "leaseId" | "cooldownGeneration">;

export type ManualResetCooldownClaim =
  | { kind: "pool"; probe: CodexQuotaRecoveryProbeClaim }
  | { kind: "main"; probe: CooldownRecoveryLease };

function manualResetAccountEligible(config: OcxConfig, accountId: string): boolean {
  return !isCodexAccountPaused(config, accountId) && !isAccountNeedsReauth(accountId)
    && (accountId === MAIN_CODEX_ACCOUNT_ID
      || (config.codexAccounts ?? []).some(account => account.id === accountId && isSelectableCodexPoolAccount(account)));
}

/** Explicit reset bypasses probe pacing, never another owner's lease or quota scope. */
export function claimManualResetCooldowns(
  config: OcxConfig,
  accountId: string,
  now = Date.now(),
  expectedPoolGeneration?: number,
): ManualResetCooldownClaim[] {
  if (!manualResetAccountEligible(config, accountId)) return [];
  const record = accountId === MAIN_CODEX_ACCOUNT_ID ? undefined : readCodexAccountRecord(accountId);
  if (accountId !== MAIN_CODEX_ACCOUNT_ID && (!record?.credential || record.deletedAt != null)) return [];
  if (record && expectedPoolGeneration !== undefined && record.generation !== expectedPoolGeneration) return [];
  const claims: ManualResetCooldownClaim[] = [];
  for (const scope of [undefined, "shared"] as const) {
    const health = scope ? scopedHealthFor(accountId, scope) : getAccountHealth(accountId);
    if (!health || health.cooldownSource !== "reset-derived" || health.probeLeaseId !== undefined
      || !Number.isFinite(health.cooldownUntil) || !(health.cooldownUntil! > now)) continue;
    const leaseId = randomUUID();
    const cooldownGeneration = health.cooldownGeneration ?? 0;
    const next = { ...health, probeLeaseId: leaseId, probeLeaseGeneration: cooldownGeneration, lastProbeAt: now };
    if (scope) setScopedHealth(accountId, scope, next);
    else setAccountHealth(accountId, next);
    const probe = { accountId, scope, leaseId, cooldownGeneration };
    claims.push(record ? { kind: "pool", probe: {
      ...probe, credentialGeneration: record.generation, credentialReplacedAt: record.replacedAt,
    } } : { kind: "main", probe });
  }
  return claims;
}

export type ManualResetRefreshLineage = Readonly<{
  fromGeneration: number;
  toGeneration: number;
  provenance: CodexRefreshProvenance;
}>;

type ManualResetQuotaProof = CodexQuotaRecoveryProbeProof & {
  refreshLineage?: ManualResetRefreshLineage;
};

/** Main proof is checked by the already-owned auth operation, never by a Pool record. */
export function settleManualResetCooldown(
  config: OcxConfig,
  claim: ManualResetCooldownClaim,
  recovered: boolean,
  proof: ManualResetQuotaProof = {},
  now = Date.now(),
): boolean {
  if (!recovered) return settleCooldownRecoveryLease(claim.probe, false, now);
  const eligible = manualResetAccountEligible(config, claim.probe.accountId);
  if (claim.kind === "main") return settleCooldownRecoveryLease(claim.probe, eligible, now);
  const lineage = proof.refreshLineage;
  // Equal wall-clock replacement stamps do not establish ancestry. Manual +1
  // recovery additionally needs the actual forced-refresh result for this edge.
  const ownedGeneration = proof.credentialGeneration === claim.probe.credentialGeneration
    || (proof.credentialGeneration === claim.probe.credentialGeneration + 1
      && lineage?.fromGeneration === claim.probe.credentialGeneration
      && lineage.toGeneration === proof.credentialGeneration
      && (lineage.provenance === "self-refresh" || lineage.provenance === "joined-lineage"));
  return settleCodexQuotaRecoveryProbe(claim.probe, eligible && ownedGeneration, proof, now);
}

/** Settle one background recovery claim without mutating account-wide outcome state. */
export function settleCodexQuotaRecoveryProbe(
  claim: CodexQuotaRecoveryProbeClaim,
  recovered: boolean,
  proof: CodexQuotaRecoveryProbeProof,
  now = Date.now(),
): boolean {
  const health = claim.scope
    ? scopedHealthFor(claim.accountId, claim.scope)
    : getAccountHealth(claim.accountId);
  if (!health || health.probeLeaseId !== claim.leaseId) return false;
  const currentRecord = readCodexAccountRecord(claim.accountId);
  const proofGeneration = proof.credentialGeneration;
  // A probe-owned token refresh (getValidCodexToken) advances the credential generation by
  // exactly one while preserving `replacedAt`; an external credential replacement bumps the
  // generation too but stamps a fresh `replacedAt`. Accept the +1 transition only when the
  // claim-time lineage is intact AND the generation the fresh quota was proven under is live.
  const generationFenced = proofGeneration !== undefined
    && (proofGeneration === claim.credentialGeneration
      ? isCodexAccountGenerationLive(claim.accountId, proofGeneration)
      : proofGeneration === claim.credentialGeneration + 1
        && currentRecord?.replacedAt === claim.credentialReplacedAt
        && isCodexAccountGenerationLive(claim.accountId, proofGeneration));
  return settleCooldownRecoveryLease(claim, recovered && generationFenced, now);
}

function settleCooldownRecoveryLease(claim: CooldownRecoveryLease, recovered: boolean, now: number): boolean {
  const health = claim.scope ? scopedHealthFor(claim.accountId, claim.scope) : getAccountHealth(claim.accountId);
  if (!health || health.probeLeaseId !== claim.leaseId) return false;
  const fenced = (claim.scope === undefined || claim.scope === "shared")
    && health.cooldownSource === "reset-derived"
    && (health.cooldownGeneration ?? 0) === claim.cooldownGeneration
    && (health.probeLeaseGeneration ?? 0) === claim.cooldownGeneration;
  if (!recovered || !fenced) {
    const released = withProbeLeaseReleased(health, now);
    if (claim.scope) setScopedHealth(claim.accountId, claim.scope, released);
    else setAccountHealth(claim.accountId, released);
    return false;
  }
  if (claim.scope) {
    deleteScopedHealth(claim.accountId, claim.scope);
  } else {
    const {
      cooldownUntil: _until,
      cooldownSince: _since,
      cooldownSource: _source,
      probeLeaseId: _leaseId,
      probeLeaseGeneration: _leaseGeneration,
      // "The quota window moved" is a statement about the whole refusal, so the avoidance it
      // announced goes with the block it produced. Leaving it would make this escape hatch stop
      // escaping: the account would still be passed over by every selection it is meant to win.
      quotaAvoidUntil: _avoid,
      ...rest
    } = health;
    setAccountHealth(claim.accountId, {
      ...rest,
      cooldownGeneration: claim.cooldownGeneration + 1,
      lastProbeAt: now,
    });
  }
  return true;
}

/** Acquire the recovery probe for one confirmed model-specific quota group. */
export function tryAcquireCodexQuotaScopeProbeLease(
  accountId: string,
  scope: CodexQuotaScope,
  now = Date.now(),
): string | null {
  const health = scopedHealthFor(accountId, scope);
  if (!canAcquireQuotaProbeLease(health, now)) return null;
  const probeLeaseId = randomUUID();
  setScopedHealth(accountId, scope, {
    ...health!,
    probeLeaseId,
    probeLeaseGeneration: health!.cooldownGeneration ?? 0,
    lastProbeAt: now,
  });
  return probeLeaseId;
}

/** Side-effect-free check for a confirmed model-specific quota probe. */
export function canAcquireCodexQuotaScopeProbeLease(
  accountId: string,
  scope: CodexQuotaScope,
  now = Date.now(),
): boolean {
  return canAcquireQuotaProbeLease(scopedHealthFor(accountId, scope), now);
}

/**
 * Hand a probe lease back without recording an upstream outcome. Used by paths
 * that take a lease and then fail before any request reaches upstream.
 */
export function releaseCodexQuotaProbeLease(accountId: string, leaseId: string, now = Date.now()): void {
  const health = getAccountHealth(accountId);
  if (!health || health.probeLeaseId !== leaseId) return;
  setAccountHealth(accountId, withProbeLeaseReleased(health, now));
}

/** Release a model-specific quota probe when the request never reaches upstream. */
export function releaseCodexQuotaScopeProbeLease(
  accountId: string,
  scope: CodexQuotaScope,
  leaseId: string,
  now = Date.now(),
): void {
  const health = scopedHealthFor(accountId, scope);
  if (!health || health.probeLeaseId !== leaseId) return;
  setScopedHealth(accountId, scope, withProbeLeaseReleased(health, now));
}

/**
 * True when this outcome belongs to the account's in-flight probe. The
 * undefined-id guard matters: without it an outcome carrying no lease would match
 * an account holding no lease and be mistaken for the probe owner.
 */
export function ownsProbeLease(health: CodexUpstreamHealth | undefined, meta: CodexUpstreamOutcomeMeta): boolean {
  return meta.probeLeaseId !== undefined && meta.probeLeaseId === health?.probeLeaseId;
}

/**
 * True when the owning probe may still clear the cooldown. A later 429 bumps the
 * generation, so a probe that started under an older cooldown must not erase the
 * newer restriction (which may carry an explicit Retry-After).
 */
export function probeMayClearCooldown(health: CodexUpstreamHealth | undefined, meta: CodexUpstreamOutcomeMeta): boolean {
  return ownsProbeLease(health, meta)
    && (health!.probeLeaseGeneration ?? 0) === (health!.cooldownGeneration ?? 0);
}

/** Strip the in-flight lease while preserving every hard-cooldown field. */
export function withProbeLeaseReleased(health: CodexUpstreamHealth, now: number): CodexUpstreamHealth {
  const { probeLeaseId: _id, probeLeaseGeneration: _gen, ...rest } = health;
  return { ...rest, lastProbeAt: now };
}
