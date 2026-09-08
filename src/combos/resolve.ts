import type { OcxComboTarget, OcxConfig } from "../types";
import { getCachedProviderQuota } from "../providers/quota-routing-cache";
import type { ProviderQuota } from "../providers/quota-types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { sleepWithAbort } from "../lib/upstream-retry";
import {
  coolComboTarget,
  earliestComboCooldown,
  isComboTargetInCooldown,
  type ComboFailureCooldownScope,
} from "./failover";
import { quotaResetRemainingMs } from "./reset-window";
import { getCombo, resolveComboId, targetKey } from "./types";
import type { NormalizedComboConfig } from "./types";
import {
  captureConfigGeneration,
  type GenerationContext,
} from "../lib/state-store-sweeper";

export interface ComboPick {
  comboId: string;
  target: Required<OcxComboTarget>;
  targetIndex: number;
  attempted: string[];
  writerGeneration: number;
}

interface SelectionState {
  activeKey?: string;
  successes: number;
  currentWeights: Map<string, number>;
  successfulUses: Map<string, number>;
}

const selectionState = new Map<string, SelectionState>();
let lastReconciledGeneration = 0;
let liveComboTargets = new Set<string>();

function comboTargetOwnerKey(comboId: string, key: string): string {
  return `${comboId}::${key}`;
}

function mayCommitComboState(comboId: string, key: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration
    || liveComboTargets.has(comboTargetOwnerKey(comboId, key));
}

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

function targetProviderIsUsable(config: OcxConfig, target: OcxComboTarget, now: number): boolean {
  if (!Object.hasOwn(config.providers, target.provider)) return false;
  const provider = config.providers[target.provider];
  if (!provider || provider.disabled === true) return false;
  // Native account selection owns model-scoped quota; a provider summary cannot veto it.
  return isCanonicalOpenAiForwardProvider(provider)
    || !cachedProviderQuotaIsExhausted(getCachedProviderQuota(target.provider, now), now);
}

function quotaWindowExhausted(percent: number | undefined, resetAt: number | undefined, now: number): boolean {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 100) return false;
  return typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt > now;
}

export function cachedProviderQuotaIsExhausted(
  quota: ProviderQuota | null,
  now = Date.now(),
): boolean {
  if (!quota) return false;
  if (quotaWindowExhausted(quota.fiveHourPercent, quota.fiveHourResetAt, now)) return true;
  if (quotaWindowExhausted(quota.weeklyPercent, quota.weeklyResetAt, now)) return true;
  if (quotaWindowExhausted(quota.monthlyPercent, quota.monthlyResetAt, now)) return true;
  if (quota.customWindows?.some(window => quotaWindowExhausted(window.percent, window.resetAt, now))) return true;
  if (quota.creditsUsd?.unlimited !== true
      && typeof quota.creditsUsd?.percent === "number"
      && Number.isFinite(quota.creditsUsd.percent)
      && quota.creditsUsd.percent >= 100
      && quota.creditsUsd.remaining <= 0) return true;
  return false;
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

/**
 * Select the eligible target whose earliest known quota reset is nearest.
 *
 * Only reads the last successfully cached provider-quota snapshot; it never
 * triggers an upstream quota probe. When no target has fresh reset data,
 * every remaining value is Infinity and configured order becomes the
 * fallback. Targets with elapsed or stale reset timestamps are treated as
 * unknown (Infinity).
 */
function resetWindowIndex(
  targets: Required<OcxComboTarget>[],
  eligible: (target: Required<OcxComboTarget>) => boolean,
  now = Date.now(),
): number {
  let selected = -1;
  let smallestRemaining = Number.POSITIVE_INFINITY;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    if (!eligible(target)) continue;
    const remaining = quotaResetRemainingMs(getCachedProviderQuota(target.provider, now), now);
    // Strict comparison deliberately retains configured order for ties,
    // including the no-snapshot fallback where every value is Infinity.
    if (selected < 0 || remaining < smallestRemaining) {
      selected = index;
      smallestRemaining = remaining;
    }
  }
  return selected;
}

export function pickComboTarget(
  config: OcxConfig,
  comboId: string,
  options: {
    exclude?: Iterable<string>;
    eligible?: (target: Required<OcxComboTarget>) => boolean;
    now?: number;
  } = {},
): ComboPick | null {
  const writerGeneration = captureConfigGeneration();
  const combo = getCombo(config, comboId);
  if (!combo) throw new UnknownComboError(comboId);
  const excluded = new Set(options.exclude ?? []);
  const now = options.now ?? Date.now();
  const eligible = (target: Required<OcxComboTarget>): boolean =>
    targetProviderIsUsable(config, target, now)
    && !isComboTargetInCooldown(comboId, target, now)
    && !excluded.has(targetKey(target))
    && (options.eligible?.(target) ?? true);

  let targetIndex = -1;
  if (combo.strategy === "round-robin") {
    let state = selectionState.get(comboId);
    if (!state) {
      state = { successes: 0, currentWeights: new Map(), successfulUses: new Map() };
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
  } else if (combo.strategy === "random") {
    // Weighted random selection happens independently for every request.
    const eligibleTargets = combo.targets
      .map((target, index) => ({ target, index }))
      .filter(({ target }) => eligible(target));
    if (eligibleTargets.length > 0) {
      const totalWeight = eligibleTargets.reduce((sum, entry) => sum + entry.target.weight, 0);
      let random = Math.random() * totalWeight;
      for (const entry of eligibleTargets) {
        random -= entry.target.weight;
        if (random <= 0) {
          targetIndex = entry.index;
          break;
        }
      }
      if (targetIndex < 0) targetIndex = eligibleTargets[eligibleTargets.length - 1]!.index;
    }
  } else if (combo.strategy === "least-used") {
    let state = selectionState.get(comboId);
    if (!state) {
      state = { successes: 0, currentWeights: new Map(), successfulUses: new Map() };
      selectionState.set(comboId, state);
    }
    let fewestUses = Number.POSITIVE_INFINITY;
    for (let index = 0; index < combo.targets.length; index++) {
      const target = combo.targets[index]!;
      if (!eligible(target)) continue;
      const uses = state.successfulUses.get(targetKey(target)) ?? 0;
      if (targetIndex < 0 || uses < fewestUses) {
        targetIndex = index;
        fewestUses = uses;
      }
    }
  } else if (combo.strategy === "reset-window") {
    targetIndex = resetWindowIndex(combo.targets, eligible, now);
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
    writerGeneration,
  };
}

export function noteComboSuccess(
  comboId: string,
  combo: NormalizedComboConfig,
  target: Required<OcxComboTarget>,
  writerGeneration = captureConfigGeneration(),
): void {
  const key = targetKey(target);
  if (!mayCommitComboState(comboId, key, writerGeneration)) return;
  if (combo.strategy === "least-used") {
    let state = selectionState.get(comboId);
    if (!state) {
      state = { successes: 0, currentWeights: new Map(), successfulUses: new Map() };
      selectionState.set(comboId, state);
    }
    state.successfulUses.set(key, (state.successfulUses.get(key) ?? 0) + 1);
    return;
  }
  if (combo.strategy !== "round-robin") return;
  const state = selectionState.get(comboId);
  if (!state || state.activeKey !== key) return;
  state.successes += 1;
  if (state.successes >= combo.stickyLimit) {
    delete state.activeKey;
    state.successes = 0;
  }
}

export function noteComboFailure(
  comboId: string,
  target: OcxComboTarget,
  writerGeneration = captureConfigGeneration(),
): void {
  if (!mayCommitComboState(comboId, targetKey(target), writerGeneration)) return;
  const state = selectionState.get(comboId);
  if (state?.activeKey === targetKey(target)) {
    delete state.activeKey;
    state.successes = 0;
  }
}

export function advanceComboAfterFailure(
  config: OcxConfig,
  pick: ComboPick,
  options: {
    retryAfter?: string | null;
    resetAt?: unknown | unknown[];
    now?: number;
    cooldownMs?: number;
    eligible?: (target: Required<OcxComboTarget>) => boolean;
    cooldownScope?: ComboFailureCooldownScope;
    status?: number;
    code?: string | null;
    message?: string;
  } = {},
): ComboPick | null {
  noteComboFailure(pick.comboId, pick.target, pick.writerGeneration);
  const combo = getCombo(config, pick.comboId);
  // "none" records no cooldown at all: the failure described the request, not the target, so
  // the target must stay immediately selectable for the next (differently shaped) request.
  if (options.cooldownScope !== "none") {
    const cooldownTargets = options.cooldownScope === "provider" && combo
      ? combo.targets.filter(target => target.provider === pick.target.provider)
      : [pick.target];
    for (const target of cooldownTargets) {
      coolComboTarget(pick.comboId, target, {
        ...options,
        cooldownMs: options.cooldownMs ?? combo?.cooldownMs,
        writerGeneration: pick.writerGeneration,
      });
    }
  }
  return pickComboTarget(config, pick.comboId, {
    exclude: pick.attempted,
    now: options.now,
    eligible: target => !isComboTargetInCooldown(pick.comboId, target, options.now)
      && (options.eligible?.(target) ?? true),
  });
}

export async function pickComboTargetWithWait(
  config: OcxConfig,
  comboId: string,
  options: {
    exclude?: Iterable<string>;
    eligible?: (target: Required<OcxComboTarget>) => boolean;
    waitForCooldownMs: number;
    abortSignal?: AbortSignal;
    now?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<ComboPick | null> {
  const now = options.now ?? Date.now();
  const excluded = new Set(options.exclude ?? []);
  const customEligible = options.eligible;
  const eligible = (target: Required<OcxComboTarget>): boolean =>
    !isComboTargetInCooldown(comboId, target, now)
    && (customEligible?.(target) ?? true);
  const pick = pickComboTarget(config, comboId, { exclude: excluded, eligible, now });
  if (pick || options.waitForCooldownMs <= 0 || options.abortSignal?.aborted) return pick;
  const combo = getCombo(config, comboId);
  if (!combo) throw new UnknownComboError(comboId);
  const waitingTargets = combo.targets.filter(target =>
    targetProviderIsUsable(config, target, now)
    && !excluded.has(targetKey(target))
    && isComboTargetInCooldown(comboId, target, now)
    && (customEligible?.(target) ?? true),
  );
  const earliest = earliestComboCooldown(comboId, waitingTargets, now);
  if (earliest === undefined) return null;
  const delay = earliest.expiry - now;
  if (delay > options.waitForCooldownMs) return null;
  // The expiry computation above is the single source of truth for the wait budget.
  // Its target preserves configured order for ties.
  const target = earliest.target;
  console.warn(
    `[combo] ${comboId}: all targets cooling, waiting ${delay}ms for ${targetKey(target)}`,
  );
  try {
    await (options.sleep ?? sleepWithAbort)(delay, options.abortSignal);
  } catch (error) {
    if (options.abortSignal?.aborted) return null;
    throw error;
  }
  if (options.abortSignal?.aborted) return null;
  // Management updates can delete or rename the combo while this request sleeps.
  if (!getCombo(config, comboId)) return null;
  return pickComboTarget(config, comboId, {
    exclude: excluded,
    now: now + delay,
    eligible: targetCandidate =>
      !isComboTargetInCooldown(comboId, targetCandidate, now + delay)
      && (customEligible?.(targetCandidate) ?? true),
  });
}

export function reconcileComboRotationState(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const [comboId, state] of selectionState) {
    if (!context.comboIds.has(comboId)) {
      selectionState.delete(comboId);
      removed += 1;
      continue;
    }
    if (state.activeKey && !context.comboTargets.has(comboTargetOwnerKey(comboId, state.activeKey))) {
      delete state.activeKey;
      state.successes = 0;
      removed += 1;
    }
    for (const key of state.currentWeights.keys()) {
      if (context.comboTargets.has(comboTargetOwnerKey(comboId, key))) continue;
      state.currentWeights.delete(key);
      removed += 1;
    }
    for (const key of state.successfulUses.keys()) {
      if (context.comboTargets.has(comboTargetOwnerKey(comboId, key))) continue;
      state.successfulUses.delete(key);
      removed += 1;
    }
  }
  liveComboTargets = new Set(context.comboTargets);
  lastReconciledGeneration = context.generation;
  return removed;
}

export function clearComboSelectionState(comboId?: string): void {
  if (comboId === undefined) {
    selectionState.clear();
    liveComboTargets.clear();
    lastReconciledGeneration = 0;
    return;
  }
  selectionState.delete(comboId);
}

export function tryPickComboModel(config: OcxConfig, modelId: string): ComboPick | null {
  const comboId = resolveComboId(config, modelId);
  if (!comboId) return null;
  if (!getCombo(config, comboId)) throw new UnknownComboError(comboId);
  const picked = pickComboTarget(config, comboId);
  if (!picked) throw new NoAvailableComboTargetsError(comboId);
  return picked;
}
