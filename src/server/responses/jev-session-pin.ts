/**
 * Opt-in JEV session pin (#7525).
 *
 * A JEV Combo decides a target per request, so consecutive turns of one conversation can land on
 * different providers and each switch starts with a cold provider prompt cache. With
 * `sessionPin` set, a session keeps the target JEV chose for it while the session stays active.
 *
 * Identity. A pin is keyed by the admitted caller (the salted context principal of the matched
 * data-plane key, or `loopback`), the Combo id and the explicit session lane from
 * `sessionLaneIdFromRequest` (thread, session and parent-thread headers). A request without an
 * explicit session identity never pins, and a body field such as `prompt_cache_key` is never an
 * identity on its own.
 *
 * Lifetime. A pin is written only after the target JEV applied for this session completes a
 * response, and it is refreshed by every later completion on that same target, including tool-loop
 * continuations. It is released when the session stays idle past `ttlMs`, when any config
 * generation change happens after it was written, when its target is not among the request's
 * current JEV choices (disabled, removed, cooling down, quota exhausted, metered or otherwise
 * ineligible), when its effort is no longer offered, when opted-in quota evidence reads
 * `nearly_exhausted`, and when any target of a pinned session fails; a request that was already in
 * flight when that failure was recorded cannot write the pin back. A cancelled send writes and
 * releases nothing. Storage is process-local and bounded by `JEV_SESSION_PIN_CAPACITY`.
 */
import type { JevCandidate, JevDecision, JevDecisionBackend } from "../../combos/jev";
import { jevQuotaSignalForTarget } from "../../combos/jev-quota";
import { JEV_QUOTA_DEFAULT_TIERS, normalizeJevQuotaTiers, type JevQuotaTiers } from "../../combos/jev-quota-config";
import type { JevSessionPinRelease } from "../../combos/jev-session-pin-config";
import type { NormalizedComboConfig } from "../../combos/types";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import type { OcxComboDefaultEffort, OcxConfig } from "../../types";
import type { DataPlaneAdmission } from "../auth-cors";

export const JEV_SESSION_PIN_ROUTE_REASON = "jev-session-pin";
export const JEV_SESSION_PIN_CAPACITY = 512;

interface PinEntry {
  targetKey: string;
  effort: OcxComboDefaultEffort | null;
  backend: JevDecisionBackend;
  at: number;
  generation: number;
}

const pins = new Map<string, PinEntry>();
/**
 * Failure fence per session key. `forget()` stamps the key with a fresh sequence number; a request
 * that started before that stamp may no longer write the pin back, so a concurrent completion on
 * the same session cannot restore a target another request just saw fail. Bounded like the pins;
 * because an evicted stamp is unknowable, a writer whose key has no stamp is also refused once any
 * stamp was evicted after it started.
 */
const failureFences = new Map<string, number>();
let failureSequence = 0;
/** `failureSequence` at the most recent fence eviction. */
let fenceEvictedAt = 0;

function callerNamespace(admission: DataPlaneAdmission | undefined): string {
  if (!admission) return "unadmitted";
  if (admission.kind === "loopback") return "loopback";
  if (admission.contextPrincipalId) return `principal:${admission.contextPrincipalId}`;
  return admission.kind === "configured" ? `key:${admission.keyId}` : admission.kind;
}

function write(key: string, entry: PinEntry): void {
  // Insertion order is recency order; evicting from the front drops the least recent session.
  pins.delete(key);
  pins.set(key, entry);
  while (pins.size > JEV_SESSION_PIN_CAPACITY) {
    const oldest = pins.keys().next().value;
    if (oldest === undefined) break;
    pins.delete(oldest);
  }
}

function fenceFailure(key: string): void {
  failureFences.delete(key);
  failureFences.set(key, ++failureSequence);
  while (failureFences.size > JEV_SESSION_PIN_CAPACITY) {
    const oldest = failureFences.keys().next().value;
    if (oldest === undefined) break;
    failureFences.delete(oldest);
    fenceEvictedAt = failureSequence;
  }
}

export interface JevSessionPinReuse {
  /** The pinned decision to apply instead of asking the decision backend. */
  decision?: JevDecision;
  /** Set when a pin existed and was released instead of reused. */
  released?: JevSessionPinRelease;
}

export interface JevSessionPinScope {
  /**
   * Reuse the session's pin against this request's current JEV choices, or report its release.
   * `quota` is passed only when the Combo opted into advisory quota evidence; it is read from
   * loaded snapshots exactly as the decision payload would read it.
   */
  reuse(
    choices: readonly JevCandidate[],
    quota?: { config: OcxConfig; tiers?: JevQuotaTiers },
  ): JevSessionPinReuse;
  /**
   * Record a completed response. With the request's applied JEV decision it (re)writes the pin
   * when the completed target is the decided one; without one it only refreshes a pin that
   * already names the completed target.
   */
  complete(completedTargetKey: string, decision: JevDecision | undefined, writerGeneration: number): void;
  /** Drop the session's pin after a real target failure. */
  forget(): void;
}

/** The pin scope for one Combo request, or undefined when this request can never pin. */
export function jevSessionPinScope(args: {
  combo: Pick<NormalizedComboConfig, "strategy" | "sessionPin">;
  comboId: string;
  admission: DataPlaneAdmission | undefined;
  lane: string | undefined;
  now?: () => number;
}): JevSessionPinScope | undefined {
  const ttlMs = args.combo.sessionPin?.ttlMs;
  if (args.combo.strategy !== "jev" || ttlMs === undefined || !args.lane) return undefined;
  const key = `${callerNamespace(args.admission)}\u0000${args.comboId}\u0000${args.lane}`;
  const now = args.now ?? Date.now;
  const fence = failureFences.get(key) ?? 0;
  const startedAtSequence = failureSequence;
  const release = (reason: JevSessionPinRelease): JevSessionPinReuse => {
    pins.delete(key);
    return { released: reason };
  };
  return {
    reuse(choices, quota) {
      const entry = pins.get(key);
      if (!entry) return {};
      if (entry.generation !== captureConfigGeneration()) return release("config_changed");
      const at = now();
      if (at < entry.at || at - entry.at >= ttlMs) return release("expired");
      const candidate = choices.find(choice => choice.key === entry.targetKey);
      if (!candidate) return release("target_unavailable");
      if (entry.effort !== null && !candidate.reasoningEfforts.includes(entry.effort)) {
        return release("effort_unavailable");
      }
      if (quota && candidate.quotaIdentity !== null) {
        const identity = candidate.quotaIdentity ?? candidate;
        const tiers = normalizeJevQuotaTiers(quota.tiers) ?? JEV_QUOTA_DEFAULT_TIERS;
        const signal = jevQuotaSignalForTarget(quota.config, identity.provider, identity.model, at, tiers);
        if (signal.tier === "nearly_exhausted") return release("quota_nearly_exhausted");
      }
      return {
        decision: {
          backend: entry.backend,
          targetKey: entry.targetKey,
          effort: entry.effort,
          gate: "apply",
          latencyMs: 0,
          pinned: true,
          pinReason: "session",
        },
      };
    },
    complete(completedTargetKey, decision, writerGeneration) {
      // A config change while the response was in flight makes this completion obsolete.
      if (writerGeneration !== captureConfigGeneration()) return;
      // So does a failure on this session reported after this request started.
      const currentFence = failureFences.get(key);
      if ((currentFence ?? 0) !== fence) return;
      if (currentFence === undefined && fenceEvictedAt > startedAtSequence) return;
      if (!decision) {
        const entry = pins.get(key);
        if (entry && entry.targetKey === completedTargetKey && entry.generation === writerGeneration) {
          write(key, { ...entry, at: now() });
        }
        return;
      }
      // Only an applied decision pins; a fail-open fallback leaves the next turn to decide again.
      if (decision.gate !== "apply" || decision.targetKey !== completedTargetKey) return;
      write(key, {
        targetKey: decision.targetKey,
        effort: decision.effort,
        backend: decision.backend,
        at: now(),
        generation: writerGeneration,
      });
    },
    forget() {
      pins.delete(key);
      fenceFailure(key);
    },
  };
}

/** Test-only reset, alongside the Combo recall and rotation resets. */
export function clearJevSessionPinsForTests(): void {
  pins.clear();
  failureFences.clear();
  failureSequence = 0;
  fenceEvictedAt = 0;
}

/** Test-only view of the retained pin count. */
export function jevSessionPinCountForTests(): number {
  return pins.size;
}
