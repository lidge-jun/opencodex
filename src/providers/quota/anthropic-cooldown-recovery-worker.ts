import type { OcxConfig } from "../../types";
import { ANTHROPIC_INSTANCE_IDS, type AnthropicInstanceId } from "../anthropic-instance-id";
import { getAccountSet } from "../../oauth/store";
import { anthropicRoutingFor } from "../../oauth/anthropic-routing";
import { registerStateSweepAfterTick, STATE_SWEEP_INTERVAL_MS } from "../../lib/state-store-sweeper";
import { fetchAnthropicAccountQuota } from "./anthropic-account-quota";

/**
 * Background recovery for Anthropic quota cooldowns.
 *
 * A 429 cools the account until the deadline upstream named, and a fresh usage read that shows
 * every rejected window open lifts it early (#6989). Until now that read only happened when
 * something else asked for quota: the dashboard, `ocx account refresh`, or a reset admitted
 * through this proxy. A Claude Code user whose window was reset elsewhere (a reset grant spent
 * in the Claude app, a plan upgrade) kept receiving "temporarily rate-limited" from a pool
 * whose accounts upstream had already reopened, until the old deadline or a manual
 * clear-cooldown.
 *
 * This worker issues that read itself, on the shared state sweep, for every account whose
 * cooldown is claimable. The read goes through `fetchAnthropicAccountQuota`, so the claim,
 * generation fence and settlement are the same ones a dashboard read uses; the worker adds only
 * the trigger and its pacing.
 */

/** First retry after a read that kept the cooldown. Doubles per retained read up to the cap. */
export const ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MIN_MS = STATE_SWEEP_INTERVAL_MS;
export const ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MAX_MS = 10 * 60_000;

type RecoveryAttempt = { generation: number; nextAt: number; delayMs: number };
type DueProbe = { instance: AnthropicInstanceId; accountId: string; key: string; generation: number };

/** Keyed per instance and account; bound to the cooldown generation the backoff was earned by. */
const attempts = new Map<string, RecoveryAttempt>();
let inFlight: Promise<void> | null = null;

function attemptKey(instance: AnthropicInstanceId, accountId: string): string {
  return `${instance}\0${accountId}`;
}

function anthropicInstanceProbesUsage(config: OcxConfig, instance: AnthropicInstanceId): boolean {
  const target = config.providers[instance];
  return !!target && target.disabled !== true && target.authMode === "oauth";
}

/** Cooled accounts whose refusal a usage read may lift and whose backoff has elapsed. */
export function dueAnthropicCooldownRecoveryProbes(config: OcxConfig, now = Date.now()): DueProbe[] {
  const due: DueProbe[] = [];
  const live = new Set<string>();
  for (const instance of ANTHROPIC_INSTANCE_IDS) {
    if (!anthropicInstanceProbesUsage(config, instance)) continue;
    const set = getAccountSet(instance);
    if (!set) continue;
    const routing = anthropicRoutingFor(instance);
    for (const row of set.accounts) {
      // A paused or signed-out account is refused by the probe before any request; skip it here.
      if (row.paused === true || row.needsReauth === true) continue;
      const key = attemptKey(instance, row.id);
      const claim = routing.captureAnthropicCooldownRecovery(row.id, now);
      // A refusal that named no window settles as retained whatever usage shows: never read for it.
      if (!claim || !claim.namesRejectedWindow) continue;
      live.add(key);
      // A deadline the sweeper reaches first needs no upstream read.
      const until = routing.getAnthropicAccountHealthSnapshot(row.id, now)?.cooldownUntil;
      if (until === undefined || until - now <= STATE_SWEEP_INTERVAL_MS) continue;
      const attempt = attempts.get(key);
      if (attempt && attempt.generation === claim.cooldownGeneration && attempt.nextAt > now) continue;
      due.push({ instance, accountId: row.id, key, generation: claim.cooldownGeneration });
    }
  }
  // A lifted, expired or removed cooldown drops its backoff with it.
  for (const key of attempts.keys()) if (!live.has(key)) attempts.delete(key);
  return due;
}

function settleAttempt(probe: DueProbe, now: number): void {
  const claim = anthropicRoutingFor(probe.instance).captureAnthropicCooldownRecovery(probe.accountId, now);
  // Lifted, or replaced by a newer refusal that earns its own first read on the next sweep.
  if (!claim || claim.cooldownGeneration !== probe.generation) { attempts.delete(probe.key); return; }
  const previous = attempts.get(probe.key);
  const delayMs = previous?.generation === probe.generation
    ? Math.min(previous.delayMs * 2, ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MAX_MS)
    : ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MIN_MS;
  attempts.set(probe.key, { generation: probe.generation, nextAt: now + delayMs, delayMs });
}

/**
 * One pass over every due cooled account. Single-flight: a sweep that fires while a pass is
 * still reading joins it. Reads are sequential; a pool rarely has more than a few cooled accounts
 * and this must never stampede the usage endpoint.
 */
export async function runAnthropicCooldownRecoveryProbes(config: OcxConfig, now = Date.now()): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    for (const probe of dueAnthropicCooldownRecoveryProbes(config, now)) {
      try {
        // Force bypasses the TTL; fresh dispatch refuses to join an older flight whose evidence
        // predates the claim. Settlement happens inside the probe under the generation fence.
        await fetchAnthropicAccountQuota(probe.instance, probe.accountId, true, config, true);
      } catch {
        // A stale or disowned probe settles nothing; the cooldown is kept and retried on backoff.
      }
      settleAttempt(probe, Date.now());
    }
  })().catch(() => {
    // Background recovery is best-effort; routing keeps the cooldown on failure.
  }).finally(() => { inFlight = null; });
  return inFlight;
}

export function registerAnthropicCooldownRecoveryProbeWorker(config: OcxConfig): () => void {
  return registerStateSweepAfterTick({
    name: "anthropic-cooldown-recovery",
    afterTick: () => { void runAnthropicCooldownRecoveryProbes(config); },
  });
}

/** Test-only: drop the backoff table and the single-flight promise. */
export function clearAnthropicCooldownRecoveryProbeStateForTests(): void {
  attempts.clear();
  inFlight = null;
}
