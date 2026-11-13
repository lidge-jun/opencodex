/**
 * Native OpenAI Decisions defaults to a JEV session pin (#7525); other decision methods retain
 * their opt-in timed pins. `sessionPin: false` opts the native OpenAI route out.
 *
 * Keep the chosen target for an explicit client conversation. Native OpenAI Decisions has no idle
 * expiry by default; other methods require an explicit `sessionPin.ttlMs` and remain in memory.
 *
 * Identity. A pin is keyed by the resolved caller (the salted context principal of a matched
 * data-plane key, including a valid key presented on loopback, or anonymous `loopback`), the
 * Combo id and the explicit session lane from
 * `sessionLaneIdFromRequest` (thread, session and parent-thread headers). A request without an
 * explicit session identity never pins, and a body field such as `prompt_cache_key` is never an
 * identity on its own.
 *
 * Lifetime. A pin is written only after the target JEV applied for this session completes a
 * response. An explicitly timed pin is refreshed by later completions on that same target.
 * It is released when a configured `ttlMs` elapses, when any live config
 * generation change happens after it was written, when its target is not among the request's
 * current JEV choices (disabled, removed, cooling down, quota exhausted, metered or otherwise
 * ineligible), when its effort is no longer offered, when opted-in quota evidence reads
 * `nearly_exhausted`, and when any target of a pinned session fails; a request that was already in
 * flight when that failure was recorded cannot write the pin back. A cancelled send writes and
 * releases nothing. Loopback pins are backed by private local storage across clean restarts.
 * Authenticated callers retain process-local pins, as their principals are process-local.
 */
import { createHash } from "node:crypto";
import type { JevCandidate, JevDecision, JevDecisionBackend } from "../../combos/jev";
import { jevQuotaSignalForTarget } from "../../combos/jev-quota";
import { JEV_QUOTA_DEFAULT_TIERS, normalizeJevQuotaTiers, type JevQuotaTiers } from "../../combos/jev-quota-config";
import type { JevSessionPinRelease } from "../../combos/jev-session-pin-config";
import type { NormalizedComboConfig } from "../../combos/types";
import { onSpendLedgerOwnerReleased } from "../../lib/spend-ledger-owner";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import type { OcxComboDefaultEffort, OcxConfig } from "../../types";
import type { DataPlaneAdmission } from "../auth-cors";
import { deleteStoredJevSessionPin, readStoredJevSessionPin, saveJevSessionPin } from "./jev-session-pin-store";

export const JEV_SESSION_PIN_ROUTE_REASON = "jev-session-pin";
export const JEV_SESSION_PIN_CAPACITY = 512;

interface PinEntry {
  targetKey: string;
  effort: OcxComboDefaultEffort | null;
  backend: JevDecisionBackend;
  at: number;
  generation: number;
  comboFingerprint?: string;
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

function callerNamespace(
  admission: DataPlaneAdmission | undefined,
  clientPrincipalId?: string,
): string {
  if (clientPrincipalId) return `principal:${clientPrincipalId}`;
  if (!admission) return "unadmitted";
  if (admission.kind === "loopback") return "loopback";
  if (admission.contextPrincipalId) return `principal:${admission.contextPrincipalId}`;
  return admission.kind === "configured" ? `key:${admission.keyId}` : admission.kind;
}

function cache(key: string, entry: PinEntry): void {
  // Evict only the memory copy of a durable pin; it can be read back from disk.
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
  openAIDecisions: boolean;
  comboId: string;
  admission: DataPlaneAdmission | undefined;
  clientPrincipalId?: string;
  lane: string | undefined;
  now?: () => number;
}): JevSessionPinScope | undefined {
  const ttlMs = args.combo.sessionPin === false ? undefined : args.combo.sessionPin?.ttlMs;
  if (args.combo.strategy !== "jev" || args.combo.sessionPin === false || !args.lane
    || !args.openAIDecisions && ttlMs === undefined) return undefined;
  // Only native OpenAI Decisions uses a resolved loopback key to split local callers. Other JEV
  // backends keep their existing admission-based identity, even when a request has a client key.
  const clientPrincipalId = args.openAIDecisions ? args.clientPrincipalId : undefined;
  const key = `${callerNamespace(args.admission, clientPrincipalId)}\u0000`
    + `${args.comboId}\u0000${args.lane}`;
  // The process-local generation cannot be compared across restarts. The normalized Combo
  // fingerprint detects edits while the proxy was down without persisting config or credentials.
  const comboFingerprint = args.openAIDecisions && args.admission?.kind === "loopback"
    && !clientPrincipalId
    ? createHash("sha256").update(JSON.stringify(args.combo)).digest("hex")
    : undefined;
  const now = args.now ?? Date.now;
  const fence = failureFences.get(key) ?? 0;
  const startedAtSequence = failureSequence;
  const remove = (): void => {
    pins.delete(key);
    if (comboFingerprint) deleteStoredJevSessionPin(key);
  };
  const read = (): PinEntry | undefined => {
    const live = pins.get(key);
    if (live || !comboFingerprint) return live;
    const stored = readStoredJevSessionPin(key);
    if (!stored) return undefined;
    const entry = { ...stored, generation: captureConfigGeneration() };
    cache(key, entry);
    return entry;
  };
  const write = (entry: PinEntry): void => {
    cache(key, entry);
    if (comboFingerprint) saveJevSessionPin(key, { ...entry, comboFingerprint });
  };
  const release = (reason: JevSessionPinRelease): JevSessionPinReuse => {
    remove();
    return { released: reason };
  };
  return {
    reuse(choices, quota) {
      const entry = read();
      if (!entry) return {};
      if (entry.generation !== captureConfigGeneration() || entry.comboFingerprint !== comboFingerprint) {
        return release("config_changed");
      }
      const at = now();
      if (ttlMs !== undefined && (at < entry.at || at - entry.at >= ttlMs)) return release("expired");
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
      cache(key, entry);
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
        if (ttlMs === undefined) return;
        const entry = read();
        if (entry && entry.targetKey === completedTargetKey && entry.generation === writerGeneration
          && entry.comboFingerprint === comboFingerprint) {
          write({ ...entry, at: now() });
        }
        return;
      }
      // Only an applied decision pins; a fail-open fallback leaves the next turn to decide again.
      if (decision.gate !== "apply" || decision.targetKey !== completedTargetKey) return;
      if (decision.pinned && ttlMs === undefined) return;
      write({
        targetKey: decision.targetKey,
        effort: decision.effort,
        backend: decision.backend,
        at: now(),
        generation: writerGeneration,
        comboFingerprint,
      });
    },
    forget() {
      remove();
      fenceFailure(key);
    },
  };
}

function clearLivePins(): void {
  pins.clear();
  failureFences.clear();
  failureSequence = 0;
  fenceEvictedAt = 0;
}
onSpendLedgerOwnerReleased(clearLivePins);

/** Test-only reset, alongside the Combo recall and rotation resets. */
export const clearJevSessionPinsForTests = clearLivePins;

/** Test-only view of the retained pin count. */
export function jevSessionPinCountForTests(): number {
  return pins.size;
}
