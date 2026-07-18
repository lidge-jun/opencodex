import type { OcxComboTarget, OcxConfig } from "../types";
import { coolComboTarget, isComboTargetInCooldown } from "./failover";
import { getCombo, parseComboModelId, targetKey } from "./types";
import type { NormalizedComboConfig } from "./types";

export interface ComboPick {
  comboId: string;
  target: Required<OcxComboTarget>;
  targetIndex: number;
  attempted: string[];
}

interface SelectionState {
  activeKey?: string;
  successes: number;
  currentWeights: Map<string, number>;
}

const selectionState = new Map<string, SelectionState>();

export class UnknownComboError extends Error {
  constructor(readonly comboId: string) {
    super(`Unknown combo: ${comboId}`);
    this.name = "UnknownComboError";
  }
}

export class NoAvailableComboTargetsError extends Error {
  readonly code = "combo_unavailable";

  constructor(readonly comboId: string) {
    super(`No available targets for combo: ${comboId}`);
    this.name = "NoAvailableComboTargetsError";
  }
}

function targetProviderIsUsable(config: OcxConfig, target: OcxComboTarget): boolean {
  return Object.hasOwn(config.providers, target.provider)
    && config.providers[target.provider]?.disabled !== true;
}

function smoothWeightedIndex(
  targets: Required<OcxComboTarget>[],
  state: SelectionState,
  eligible: (target: Required<OcxComboTarget>) => boolean,
): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    if (!eligible(target)) continue;
    const key = targetKey(target);
    const score = (state.currentWeights.get(key) ?? 0) + target.weight;
    state.currentWeights.set(key, score);
    total += target.weight;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best >= 0) {
    const key = targetKey(targets[best]!);
    state.currentWeights.set(key, (state.currentWeights.get(key) ?? 0) - total);
  }
  return best;
}

export function pickComboTarget(
  config: OcxConfig,
  comboId: string,
  options: {
    exclude?: Iterable<string>;
    eligible?: (target: Required<OcxComboTarget>) => boolean;
  } = {},
): ComboPick | null {
  const combo = getCombo(config, comboId);
  if (!combo) throw new UnknownComboError(comboId);
  const excluded = new Set(options.exclude ?? []);
  const eligible = (target: Required<OcxComboTarget>): boolean =>
    targetProviderIsUsable(config, target)
    && !excluded.has(targetKey(target))
    && (options.eligible?.(target) ?? true);

  let targetIndex = -1;
  if (combo.strategy === "round-robin") {
    let state = selectionState.get(comboId);
    if (!state) {
      state = { successes: 0, currentWeights: new Map() };
      selectionState.set(comboId, state);
    }
    if (state.activeKey) {
      targetIndex = combo.targets.findIndex(target => targetKey(target) === state.activeKey && eligible(target));
      if (targetIndex < 0) {
        delete state.activeKey;
        state.successes = 0;
      }
    }
    if (targetIndex < 0) {
      targetIndex = smoothWeightedIndex(combo.targets, state, eligible);
      if (targetIndex >= 0) {
        state.activeKey = targetKey(combo.targets[targetIndex]!);
        state.successes = 0;
      }
    }
  } else {
    targetIndex = combo.targets.findIndex(eligible);
  }

  if (targetIndex < 0) return null;
  const target = combo.targets[targetIndex]!;
  return {
    comboId,
    target,
    targetIndex,
    attempted: [...excluded, targetKey(target)],
  };
}

export function noteComboSuccess(
  comboId: string,
  combo: NormalizedComboConfig,
  target: Required<OcxComboTarget>,
): void {
  if (combo.strategy !== "round-robin") return;
  const state = selectionState.get(comboId);
  if (!state || state.activeKey !== targetKey(target)) return;
  state.successes += 1;
  if (state.successes >= combo.stickyLimit) {
    delete state.activeKey;
    state.successes = 0;
  }
}

export function noteComboFailure(comboId: string, target: OcxComboTarget): void {
  const state = selectionState.get(comboId);
  if (state?.activeKey === targetKey(target)) {
    delete state.activeKey;
    state.successes = 0;
  }
}

export function advanceComboAfterFailure(
  config: OcxConfig,
  pick: ComboPick,
  options: { retryAfter?: string | null; now?: number } = {},
): ComboPick | null {
  noteComboFailure(pick.comboId, pick.target);
  coolComboTarget(pick.comboId, pick.target, options);
  return pickComboTarget(config, pick.comboId, {
    exclude: pick.attempted,
    eligible: target => !isComboTargetInCooldown(pick.comboId, target, options.now),
  });
}

export function clearComboSelectionState(comboId?: string): void {
  if (comboId === undefined) {
    selectionState.clear();
    return;
  }
  selectionState.delete(comboId);
}

export function tryPickComboModel(config: OcxConfig, modelId: string): ComboPick | null {
  const comboId = parseComboModelId(modelId);
  if (!comboId) return null;
  if (!getCombo(config, comboId)) throw new UnknownComboError(comboId);
  const picked = pickComboTarget(config, comboId);
  if (!picked) throw new NoAvailableComboTargetsError(comboId);
  return picked;
}
