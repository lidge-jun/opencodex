import { pinnedCodexAccountId } from "../account-priority";
import type { OcxConfig } from "../../types";
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

type Sample = { at: number; failed: boolean };
type WindowState = { samples: Sample[]; degraded: boolean; healthySince?: number };

const windows = new Map<string, WindowState>();
const pinnedDegradeWarned = new Set<string>();

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

function recompute(state: WindowState, now: number): void {
  const cutoff = now - CODEX_SLIDING_FAILURE_WINDOW_MS;
  if (state.samples.length > 0 && state.samples[0]!.at <= cutoff) {
    state.samples = state.samples.filter(sample => sample.at > cutoff);
  }
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
  if (!codexFailureWindowEnabled(config)) return;
  const state = stateFor(accountId);
  state.samples.push({ at: now, failed });
  if (state.samples.length > MAX_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  recompute(state, now);
  if (!state.degraded) pinnedDegradeWarned.delete(accountId);
}

export function isCodexFailureWindowDegraded(accountId: string, now = Date.now()): boolean {
  const state = windows.get(accountId);
  if (!state) return false;
  recompute(state, now);
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
