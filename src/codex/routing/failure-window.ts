import { pinnedCodexAccountId } from "../account-priority";
import type { OcxConfig } from "../../types";
import { beginCodexAccountGenerationLiveCheck, isCodexAccountGenerationLive } from "../account-store";
import { isMainQuotaDispatchLive } from "../main-account-cache";
import type { CodexAuthContext } from "../auth-context";
import type { CodexUpstreamOutcomeMeta } from "./cooldown-math";
import {
  deleteAccountHealth,
  setAccountHealth,
  type CodexUpstreamHealth,
} from "./health-store";

/** Sliding window for transient upstream faults. Distinct from the 5-minute consecutive-streak gap. */
export const CODEX_SLIDING_FAILURE_WINDOW_MS = 60_000;
export const CODEX_SLIDING_FAILURE_MIN_SAMPLES = 20;
export const CODEX_SLIDING_FAILURE_DEGRADE_RATIO = 0.25;
export const CODEX_SLIDING_FAILURE_RECOVER_RATIO = 0.1;
export const CODEX_SLIDING_FAILURE_RECOVER_SUSTAIN_MS = 30_000;
const MAX_SAMPLES = 512;

type Sample = { at: number; failed: boolean; credentialGeneration?: number };
type WindowState = { samples: Sample[]; degraded: boolean; healthySince?: number; credentialGeneration?: number };

const windows = new Map<string, WindowState>();
const pinnedDegradeWarned = new Set<string>();

/** Read only dispatch-time provenance retained by auth materialization, never recapture at arrival. */
export function codexFailureWindowOutcomeMeta(
  context: CodexAuthContext,
): Pick<CodexUpstreamOutcomeMeta, "failureWindowCredentialGeneration" | "mainFailureWindowDispatch"> {
  if (context.kind === "pool") return { failureWindowCredentialGeneration: context.generation };
  return context.kind === "main-pool" ? { mainFailureWindowDispatch: context.mainQuotaDispatch ?? null } : {};
}

/** Fence window samples only; other health and recovery-lease semantics stay with their owners. */
export function noteCodexFailureWindowOutcome(
  config: OcxConfig, accountId: string, failed: boolean, now: number, meta: CodexUpstreamOutcomeMeta,
): void {
  if (meta.mainFailureWindowDispatch !== undefined
    && (!meta.mainFailureWindowDispatch || !isMainQuotaDispatchLive(meta.mainFailureWindowDispatch))) return;
  const generation = meta.failureWindowCredentialGeneration ?? meta.credentialGeneration;
  if (generation !== undefined && !isCodexAccountGenerationLive(accountId, generation)) return;
  appendSample(config, accountId, failed, now, generation);
}

export function codexFailureWindowEnabled(config: OcxConfig): boolean {
  return config.codexFailureWindow !== false;
}

function stateFor(accountId: string): WindowState {
  let state = windows.get(accountId);
  if (!state) {
    state = { samples: [], degraded: false };
    windows.set(accountId, state);
  }
  return state;
}

function recompute(
  accountId: string, state: WindowState, now: number,
  generationLive?: ReturnType<typeof beginCodexAccountGenerationLiveCheck>,
): void {
  // One store snapshot per insertion/read, never one file load per retained sample. The
  // unlocked insertion precheck can race another process; provenance must survive it.
  const tagged = state.credentialGeneration !== undefined
    || state.samples.some(sample => sample.credentialGeneration !== undefined);
  const live = generationLive ?? (tagged ? beginCodexAccountGenerationLiveCheck() : undefined);
  // Unknown evidence is not a credential removal: preserve samples and all derived state.
  if (live?.snapshotStatus === "failed") return;
  if (state.credentialGeneration !== undefined && !live?.(accountId, state.credentialGeneration)) {
    state.degraded = false;
    state.healthySince = undefined;
    state.credentialGeneration = undefined;
    pinnedDegradeWarned.delete(accountId);
  }
  const cutoff = now - CODEX_SLIDING_FAILURE_WINDOW_MS;
  state.samples = state.samples.filter(sample => sample.at > cutoff
    && (sample.credentialGeneration === undefined || live?.(accountId, sample.credentialGeneration)));
  state.credentialGeneration ??= state.samples.find(sample => sample.credentialGeneration !== undefined)?.credentialGeneration;
  const samples = state.samples.length;
  const failed = state.samples.reduce((count, sample) => count + (sample.failed ? 1 : 0), 0);
  const degraded = samples >= CODEX_SLIDING_FAILURE_MIN_SAMPLES
    && failed * 4 >= samples;
  const recovering = state.degraded
    && samples >= CODEX_SLIDING_FAILURE_MIN_SAMPLES
    && failed * 10 <= samples;
  if (degraded) {
    state.degraded = true;
    state.healthySince = undefined;
    return;
  }
  if (!state.degraded) {
    state.healthySince = undefined;
    return;
  }
  if (!recovering) {
    state.healthySince = undefined;
    return;
  }
  state.healthySince ??= now;
  if (now - state.healthySince >= CODEX_SLIDING_FAILURE_RECOVER_SUSTAIN_MS) {
    state.degraded = false;
    state.healthySince = undefined;
  }
}

/** Record one terminal success or transient fault. Quota and caller errors are not samples. */
export function noteCodexFailureWindowSample(
  config: OcxConfig,
  accountId: string,
  failed: boolean,
  now: number,
): void {
  appendSample(config, accountId, failed, now);
}

function appendSample(
  config: OcxConfig, accountId: string, failed: boolean, now: number, credentialGeneration?: number,
): void {
  if (!codexFailureWindowEnabled(config)) return;
  const existing = windows.get(accountId);
  const tagged = credentialGeneration !== undefined || existing?.credentialGeneration !== undefined
    || existing?.samples.some(sample => sample.credentialGeneration !== undefined);
  const live = tagged ? beginCodexAccountGenerationLiveCheck() : undefined;
  if (live?.snapshotStatus === "failed") return;
  // A stale arrival is not an ownership transition and must not delete a live replacement's state.
  if (credentialGeneration !== undefined && !live?.(accountId, credentialGeneration)) return;
  const state = stateFor(accountId);
  state.samples.push({ at: now, failed, ...(credentialGeneration === undefined ? {} : { credentialGeneration }) });
  if (state.samples.length > MAX_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  recompute(accountId, state, now, live);
  if (!state.degraded) pinnedDegradeWarned.delete(accountId);
}

export function isCodexFailureWindowDegraded(accountId: string, now = Date.now()): boolean {
  const state = windows.get(accountId);
  if (!state) return false;
  recompute(accountId, state, now);
  if (!state.degraded) pinnedDegradeWarned.delete(accountId);
  return state.degraded;
}

/**
 * Unbound placement may leave a degraded account. A manual pin stays unless the operator
 * opts into detouring new threads. Bound threads never consult this predicate.
 */
export function failureWindowSteersNewThreads(
  config: OcxConfig,
  accountId: string,
  now: number,
): boolean {
  if (!codexFailureWindowEnabled(config)) return false;
  if (!isCodexFailureWindowDegraded(accountId, now)) return false;
  if (pinnedCodexAccountId(config) !== accountId) return true;
  if (config.codexPinnedTransientPolicy === "detour-new-threads") return true;
  if (!pinnedDegradeWarned.has(accountId)) {
    pinnedDegradeWarned.add(accountId);
    console.warn("[opencodex] pinned Codex account is degraded; new threads stay on it until it recovers");
  }
  return false;
}

export function forgetCodexFailureWindow(accountId: string): void {
  windows.delete(accountId);
  pinnedDegradeWarned.delete(accountId);
}

export function forgetCodexFailureWindows(): void {
  windows.clear();
  pinnedDegradeWarned.clear();
}

/** Consecutive-success bookkeeping for a healthy terminal, moved out of the routing module. */
export function settleCodexSuccessStreak(
  config: OcxConfig,
  accountId: string,
  current: CodexUpstreamHealth | undefined,
  base: CodexUpstreamHealth | undefined,
  preserved: Partial<CodexUpstreamHealth>,
  cooldownUntil: number | null,
): void {
  const failoverEnabled = (config.upstreamFailoverThreshold ?? 3) > 0;
  if (failoverEnabled && current && current.consecutiveFailures >= 2) {
    const consecutiveSuccesses = (current.consecutiveSuccesses ?? 0) + 1;
    if (consecutiveSuccesses < 2) {
      setAccountHealth(accountId, {
        ...base!,
        ...preserved,
        consecutiveSuccesses,
      });
      return;
    }
  }
  // Level 1 clears immediately; escalated accounts need two consecutive healthy terminals.
  // Hard quota cooldown intentionally survives either recovery path.
  if (cooldownUntil) setAccountHealth(accountId, { consecutiveFailures: 0, ...preserved });
  else deleteAccountHealth(accountId);
}
