import type { OcxAccountPoolRotationStrategy } from "../types";

export const POOL_KEY_CODEX = "codex";
export const POOL_KEY_ANTHROPIC = "anthropic";

interface SelectionState {
  activeKey?: string;
  successes: number;
  currentWeights: Map<string, number>;
}

const selectionState = new Map<string, SelectionState>();

const DEFAULT_STICKY_LIMIT = 1;
const MIN_STICKY_LIMIT = 1;
const MAX_STICKY_LIMIT = 100;
const DEFAULT_STRATEGY: OcxAccountPoolRotationStrategy = "quota";
const VALID_STRATEGIES = new Set<OcxAccountPoolRotationStrategy>(["quota", "round-robin", "fill-first"]);

export function normalizeAccountPoolStrategy(raw: unknown): OcxAccountPoolRotationStrategy {
  if (typeof raw === "string" && VALID_STRATEGIES.has(raw as OcxAccountPoolRotationStrategy)) {
    return raw as OcxAccountPoolRotationStrategy;
  }
  return DEFAULT_STRATEGY;
}

export function normalizeAccountPoolStickyLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= MIN_STICKY_LIMIT && raw <= MAX_STICKY_LIMIT) {
    return raw;
  }
  return DEFAULT_STICKY_LIMIT;
}

function getOrCreateState(poolKey: string): SelectionState {
  let state = selectionState.get(poolKey);
  if (!state) {
    state = { successes: 0, currentWeights: new Map() };
    selectionState.set(poolKey, state);
  }
  return state;
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

export function pickRoundRobinAccount(
  poolKey: string,
  eligibleIds: string[],
  stickyLimit: number,
): string | null {
  if (eligibleIds.length === 0) return null;

  const limit = normalizeAccountPoolStickyLimit(stickyLimit);
  const state = getOrCreateState(poolKey);

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
  if (limit <= 1) {
    return picked;
  }

  state.activeKey = picked;
  state.successes = 0;
  return picked;
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

export function clearPoolRotationState(poolKey?: string): void {
  if (poolKey === undefined) {
    selectionState.clear();
    return;
  }
  selectionState.delete(poolKey);
}
