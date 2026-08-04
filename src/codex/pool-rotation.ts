import type { OcxAccountPoolRotationStrategy } from "../types";
import type { GenerationContext } from "../lib/state-store-sweeper";

export const POOL_KEY_CODEX = "codex";
export const POOL_KEY_ANTHROPIC = "anthropic";

interface SelectionState {
  activeKey?: string;
  successes: number;
  currentWeights: Map<string, number>;
}

const selectionState = new Map<string, SelectionState>();
let lastReconciledGeneration = 0;

const DEFAULT_STICKY_LIMIT = 1;
const MIN_STICKY_LIMIT = 1;
const MAX_STICKY_LIMIT = 100;
const DEFAULT_STRATEGY: OcxAccountPoolRotationStrategy = "quota";
const VALID_STRATEGIES = new Set<OcxAccountPoolRotationStrategy>(["quota", "round-robin", "fill-first"]);

/** Strict parse for management APIs — returns null instead of defaulting. */
export function parseAccountPoolStrategy(raw: unknown): OcxAccountPoolRotationStrategy | null {
  if (typeof raw === "string" && VALID_STRATEGIES.has(raw as OcxAccountPoolRotationStrategy)) {
    return raw as OcxAccountPoolRotationStrategy;
  }
  return null;
}

/** Strict parse for management APIs — returns null instead of defaulting. */
export function parseAccountPoolStickyLimit(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= MIN_STICKY_LIMIT && raw <= MAX_STICKY_LIMIT) {
    return raw;
  }
  return null;
}

export function normalizeAccountPoolStrategy(raw: unknown): OcxAccountPoolRotationStrategy {
  return parseAccountPoolStrategy(raw) ?? DEFAULT_STRATEGY;
}

export function normalizeAccountPoolStickyLimit(raw: unknown): number {
  return parseAccountPoolStickyLimit(raw) ?? DEFAULT_STICKY_LIMIT;
}

function getOrCreateState(poolKey: string): SelectionState {
  let state = selectionState.get(poolKey);
  if (!state) {
    state = { successes: 0, currentWeights: new Map() };
    selectionState.set(poolKey, state);
  }
  return state;
}

function cloneSelectionState(state: SelectionState): SelectionState {
  return {
    activeKey: state.activeKey,
    successes: state.successes,
    currentWeights: new Map(state.currentWeights),
  };
}

function smoothWeightedIndex(ids: string[], state: SelectionState): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let total = 0;
  const weight = 1;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const score = (state.currentWeights.get(id) ?? 0) + weight;
    state.currentWeights.set(id, score);
    total += weight;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best >= 0) {
    const key = ids[best]!;
    state.currentWeights.set(key, (state.currentWeights.get(key) ?? 0) - total);
  }
  return best;
}

/**
 * Shared pick core. Mutates `state` the same way live resolve does; callers pass
 * either the live map entry or a scratch/clone for dry-run peek.
 */
function pickRoundRobinFromState(
  eligibleIds: string[],
  stickyLimit: number,
  state: SelectionState,
  commitSticky: boolean,
): string | null {
  if (eligibleIds.length === 0) return null;

  const limit = normalizeAccountPoolStickyLimit(stickyLimit);

  if (state.activeKey && eligibleIds.includes(state.activeKey)) {
    return state.activeKey;
  }

  if (state.activeKey) {
    delete state.activeKey;
    state.successes = 0;
  }

  const index = smoothWeightedIndex(eligibleIds, state);
  if (index < 0) return null;

  const picked = eligibleIds[index]!;
  if (commitSticky && limit > 1) {
    state.activeKey = picked;
    state.successes = 0;
  }
  return picked;
}

export function pickRoundRobinAccount(
  poolKey: string,
  eligibleIds: string[],
  stickyLimit: number,
): string | null {
  return pickRoundRobinFromState(eligibleIds, stickyLimit, getOrCreateState(poolKey), true);
}

/**
 * Dry-run of {@link pickRoundRobinAccount}: returns the same account resolve would
 * pick without advancing ring weights, activeKey, or successes.
 */
export function peekRoundRobinAccount(
  poolKey: string,
  eligibleIds: string[],
  stickyLimit: number,
): string | null {
  const live = selectionState.get(poolKey);
  const scratch = live
    ? cloneSelectionState(live)
    : { successes: 0, currentWeights: new Map<string, number>() };
  return pickRoundRobinFromState(eligibleIds, stickyLimit, scratch, false);
}

export function notePoolRotationSuccess(
  poolKey: string,
  accountId: string,
  stickyLimit: number,
): void {
  const limit = normalizeAccountPoolStickyLimit(stickyLimit);
  const state = selectionState.get(poolKey);
  if (!state) return;
  if (state.activeKey !== accountId) {
    state.activeKey = accountId;
    state.successes = 0;
  }
  state.successes += 1;
  if (state.successes >= limit) {
    delete state.activeKey;
    state.successes = 0;
  }
}

export function notePoolRotationFailure(poolKey: string, accountId: string): void {
  const state = selectionState.get(poolKey);
  if (state?.activeKey === accountId) {
    delete state.activeKey;
    state.successes = 0;
  }
}

/**
 * Force the next sticky/RR pick onto `accountId` (manual dashboard selection).
 * Clears sticky success counters and ring weights so the seeded account is held
 * for the next new-session pick before ordinary rotation resumes.
 */
export function seedPoolRotationAccount(poolKey: string, accountId: string): void {
  const state = getOrCreateState(poolKey);
  state.activeKey = accountId;
  state.successes = 0;
  state.currentWeights.clear();
}

export function clearPoolRotationState(poolKey?: string): void {
  if (poolKey === undefined) {
    selectionState.clear();
    return;
  }
  selectionState.delete(poolKey);
}

export function reconcilePoolRotationState(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  const anthropicIds = new Set<string>();
  for (const key of context.oauthAccountKeys) {
    const separator = key.indexOf("\0");
    if (separator > 0 && key.slice(0, separator) === "anthropic") {
      anthropicIds.add(key.slice(separator + 1));
    }
  }
  let removed = 0;
  for (const [poolKey, state] of selectionState) {
    const valid = poolKey === POOL_KEY_ANTHROPIC
      ? anthropicIds
      : poolKey === POOL_KEY_CODEX || poolKey.startsWith(`${POOL_KEY_CODEX}:`)
        ? context.codexAccountIds
        : null;
    if (!valid) continue;
    if (valid.size === 0) {
      selectionState.delete(poolKey);
      removed += 1;
      continue;
    }
    if (state.activeKey && !valid.has(state.activeKey)) {
      delete state.activeKey;
      state.successes = 0;
      removed += 1;
    }
    for (const accountId of state.currentWeights.keys()) {
      if (valid.has(accountId)) continue;
      state.currentWeights.delete(accountId);
      removed += 1;
    }
  }
  lastReconciledGeneration = context.generation;
  return removed;
}
