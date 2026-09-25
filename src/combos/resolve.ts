import type { OcxComboTarget, OcxConfig } from "../types";
import { getCachedProviderRoutingQuota } from "../providers/quota-routing-cache";
import type { ProviderQuota, ProviderQuotaWindow } from "../providers/quota-types";
import { sleepWithAbort } from "../lib/upstream-retry";
import {
  coolComboTarget,
  earliestComboCooldown,
  isComboTargetInCooldown,
  type ComboFailureCooldownScope,
} from "./failover";
import { quotaResetRemainingMs } from "./reset-window";
import { getCombo, resolveComboId, targetKey } from "./types";
import type { NormalizedComboConfig, NormalizedComboTarget } from "./types";
import {
  captureConfigGeneration,
  type GenerationContext,
} from "../lib/state-store-sweeper";

export interface ComboPick {
  comboId: string;
  target: NormalizedComboTarget;
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
  return !cachedProviderQuotaIsExhausted(getCachedProviderRoutingQuota(target.provider, provider, now), now, target.model);
}

function quotaWindowExhausted(percent: number | undefined, resetAt: number | undefined, now: number): boolean {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 100) return false;
  return typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt > now;
}

// `customWindows` is a generic carrier. Most labels are provider-wide counters ("Prepaid
// credits", "Free trial", "burst", "Spark") and must gate every model. Anthropic also rides it
// for per-model family counters, where a spent Opus week says nothing about a Sonnet request.
// `routing/quota.ts` already scopes those per model when it ranks accounts
// (`anthropicFamilyWindow`); this is the same fact applied to combo target selection.
//
// The scoping keys on `window.scope`, which the PRODUCER sets only where it proved model scope
// structurally, NEVER on the label text: `quota/antigravity.ts` forwards an upstream
// `group.displayName` unchanged, so a provider-wide group named "Opus" read as per-model would
// leave a spent window unenforced and send a doomed request. Every unproven direction keeps
// gating everything, which is the behaviour before this change: no scope on the window, no
// model on the request, or a family this gateway cannot match against a model id. Failing
// closed there costs at most a diverted target.
const MODEL_FAMILY_WINDOW_LABELS = new Set(["fable", "opus", "sonnet"]);

function customWindowAppliesToModel(window: ProviderQuotaWindow, model: string | undefined): boolean {
  if (window.scope !== "model" || model === undefined) return true;
  const family = window.label.trim().toLowerCase();
  if (!MODEL_FAMILY_WINDOW_LABELS.has(family)) return true;
  return model.toLowerCase().includes(family);
}

export function cachedProviderQuotaIsExhausted(
  quota: ProviderQuota | null,
  now = Date.now(),
  model?: string,
): boolean {
  if (!quota) return false;
  if (quotaWindowExhausted(quota.fiveHourPercent, quota.fiveHourResetAt, now)) return true;
  if (quotaWindowExhausted(quota.weeklyPercent, quota.weeklyResetAt, now)) return true;
  if (quotaWindowExhausted(quota.monthlyPercent, quota.monthlyResetAt, now)) return true;
  if (quota.customWindows?.some(window => customWindowAppliesToModel(window, model)
    && quotaWindowExhausted(window.percent, window.resetAt, now))) return true;
  if (quota.creditsUsd?.unlimited !== true
      && typeof quota.creditsUsd?.percent === "number"
      && Number.isFinite(quota.creditsUsd.percent)
      && quota.creditsUsd.percent >= 100
      && quota.creditsUsd.remaining <= 0) return true;
  return false;
}

/**
 * Why a catalog row is offered but cannot currently serve a request (#1711).
 *
 * Only one reason exists today. It is a string rather than a boolean so a later cause — a
 * cooldown, a revoked key — can be told apart by a consumer that already reads the field.
 */
export type QuotaInactiveReason = "no_credit";

/**
 * `"no_credit"` when every USABLE target of a catalog row has positive exhaustion evidence
 * (#1711), otherwise undefined.
 *
 * This reuses the credential-scoped evidence and exhaustion rules used by runtime selection.
 * Display-only account, model-group and service windows cannot mark a whole provider inactive.
 *
 * Three rules carry the correctness, all inherited rather than restated:
 *
 * - A target the operator has removed or disabled is not usable and is not evidence either way;
 *   it drops out before the vote. If nothing is left, the row is unavailable for an operator
 *   reason rather than a quota one, so this returns undefined.
 * - The canonical ChatGPT forward provider is exempt. Native account selection owns model-scoped
 *   quota, and a provider-level summary cannot veto it.
 * - A stale cache is NOT exhaustion. `getCachedProviderRoutingQuota` returns null past its 30-minute
 *   window, and a null reading ends the vote rather than counting as evidence, so an unprobed
 *   provider is never marked inactive.
 *
 * "Every" is the bar on purpose: one target that can still serve makes the row serviceable, which
 * is exactly what the combo loop concludes at request time.
 */
export function quotaInactiveReason(
  config: OcxConfig,
  // A combo votes over its own targets, which carry a model; the single-provider case has none,
  // and an absent model keeps gating on every window exactly as before.
  targets: readonly { provider: string; model?: string }[],
  now = Date.now(),
): QuotaInactiveReason | undefined {
  const usable = targets.filter(target => {
    if (!Object.hasOwn(config.providers, target.provider)) return false;
    const provider = config.providers[target.provider];
    return !!provider && provider.disabled !== true;
  });
  if (usable.length === 0) return undefined;
  for (const target of usable) {
    const provider = config.providers[target.provider]!;
    const quota = getCachedProviderRoutingQuota(target.provider, provider, now);
    if (!quota || !cachedProviderQuotaIsExhausted(quota, now, target.model)) return undefined;
  }
  return "no_credit";
}

function smoothWeightedIndex(
  targets: NormalizedComboTarget[],
  state: SelectionState,
  eligible: (target: NormalizedComboTarget) => boolean,
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
  config: OcxConfig,
  targets: NormalizedComboTarget[],
  eligible: (target: NormalizedComboTarget) => boolean,
  now = Date.now(),
): number {
  let selected = -1;
  let smallestRemaining = Number.POSITIVE_INFINITY;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    if (!eligible(target)) continue;
    const remaining = quotaResetRemainingMs(
      getCachedProviderRoutingQuota(target.provider, config.providers[target.provider], now), now,
    );
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
    eligible?: (target: NormalizedComboTarget) => boolean;
    now?: number;
    /** Inspect a round-robin choice without mutating its sticky/weight state. */
    preview?: boolean;
  } = {},
): ComboPick | null {
  const writerGeneration = captureConfigGeneration();
  const combo = getCombo(config, comboId);
  if (!combo) throw new UnknownComboError(comboId);
  const excluded = new Set(options.exclude ?? []);
  const now = options.now ?? Date.now();
  const eligible = (target: NormalizedComboTarget): boolean =>
    targetProviderIsUsable(config, target, now)
    && !isComboTargetInCooldown(comboId, target, now)
    && !excluded.has(targetKey(target))
    && (options.eligible?.(target) ?? true);

  let targetIndex = -1;
  if (combo.strategy === "round-robin") {
    let state = selectionState.get(comboId);
    if (!state) {
      state = { successes: 0, currentWeights: new Map(), successfulUses: new Map() };
      if (!options.preview) selectionState.set(comboId, state);
    } else if (options.preview) {
      state = {
        ...state,
        currentWeights: new Map(state.currentWeights),
        successfulUses: new Map(state.successfulUses),
      };
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
    targetIndex = resetWindowIndex(config, combo.targets, eligible, now);
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
  target: NormalizedComboTarget,
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
    eligible?: (target: NormalizedComboTarget) => boolean;
    cooldownScope?: ComboFailureCooldownScope;
    onCooldownRecorded?: (target: Pick<OcxComboTarget, "provider" | "model">) => void;
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
      const recorded = coolComboTarget(pick.comboId, target, {
        ...options,
        cooldownMs: options.cooldownMs ?? combo?.cooldownMs,
        writerGeneration: pick.writerGeneration,
      });
      if (recorded) options.onCooldownRecorded?.(target);
    }
  }
  // #5691: under `cooldownWaitPolicy: "before-last-resort"` this final synchronous pick
  // must not dispatch an emergency target while a normal one is merely cooling. Returning
  // null hands the decision to `pickComboTargetWithWait`, which waits a normal target out
  // inside the combo's wait budget or dispatches the last resort when none is reachable.
  // Without the policy the eligible set is unchanged and the pick is exactly as before.
  const defersLastResort = combo?.cooldownWaitPolicy === "before-last-resort"
    && combo.targets.some(target => !target.lastResort);
  return pickComboTarget(config, pick.comboId, {
    exclude: pick.attempted,
    now: options.now,
    eligible: target => !isComboTargetInCooldown(pick.comboId, target, options.now)
      && (options.eligible?.(target) ?? true)
      && (!defersLastResort || !target.lastResort),
  });
}

export async function pickComboTargetWithWait(
  config: OcxConfig,
  comboId: string,
  options: {
    exclude?: Iterable<string>;
    eligible?: (target: NormalizedComboTarget) => boolean;
    waitForCooldownMs: number;
    abortSignal?: AbortSignal;
    now?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<ComboPick | null> {
  const now = options.now ?? Date.now();
  const excluded = new Set(options.exclude ?? []);
  const customEligible = options.eligible;
  const eligibleAt = (target: NormalizedComboTarget, at: number): boolean =>
    !isComboTargetInCooldown(comboId, target, at)
    && (customEligible?.(target) ?? true);
  const eligible = (target: NormalizedComboTarget): boolean => eligibleAt(target, now);
  // Milliseconds already slept inside this call. `waitForCooldownMs` is documented as a cap
  // per *selection attempt*, so a deferral wait and the ordinary wait below must share it —
  // otherwise a 3s deferral followed by a 9s ordinary wait spends 12s against a 10s budget.
  let spentWaitMs = 0;

  // #5691: `cooldownWaitPolicy: "before-last-resort"` makes one extra attempt
  // over the normal targets alone, so a *brief* cooldown on a preferred target
  // waits rather than dispatching a target the operator marked emergency-only.
  //
  // It only ever defers. Every exit below falls through to the unchanged
  // selection, which still sees the last-resort target — a policy that could
  // withhold it when no normal target is reachable would turn a fallback into
  // an outage, which is worse than the premature routing it prevents.
  const policyCombo = getCombo(config, comboId);
  const defersLastResort = policyCombo?.cooldownWaitPolicy === "before-last-resort"
    && policyCombo.targets.some(target => !target.lastResort);
  if (defersLastResort && !options.abortSignal?.aborted) {
    const normalOnly = (target: NormalizedComboTarget): boolean =>
      !target.lastResort && eligible(target);
    const normalPick = pickComboTarget(config, comboId, {
      exclude: excluded,
      eligible: normalOnly,
      now,
    });
    if (normalPick) return normalPick;

    const waitable = policyCombo.targets.filter(target =>
      !target.lastResort
      && targetProviderIsUsable(config, target, now)
      && !excluded.has(targetKey(target))
      && isComboTargetInCooldown(comboId, target, now)
      && (customEligible?.(target) ?? true),
    );
    const soonest = earliestComboCooldown(comboId, waitable, now);
    const normalDelay = soonest === undefined ? undefined : soonest.expiry - now;
    if (normalDelay !== undefined && normalDelay <= options.waitForCooldownMs) {
      console.warn(
        `[combo] ${comboId}: deferring last resort, waiting ${normalDelay}ms for ${targetKey(soonest!.target)}`,
      );
      try {
        await (options.sleep ?? sleepWithAbort)(normalDelay, options.abortSignal);
      } catch (error) {
        if (options.abortSignal?.aborted) return null;
        throw error;
      }
      spentWaitMs += normalDelay;
      if (options.abortSignal?.aborted) return null;
      // The combo can be deleted or renamed while this request sleeps.
      if (!getCombo(config, comboId)) return null;
      const waited = pickComboTarget(config, comboId, {
        exclude: excluded,
        now: now + normalDelay,
        eligible: target => !target.lastResort
          && !isComboTargetInCooldown(comboId, target, now + normalDelay)
          && (customEligible?.(target) ?? true),
      });
      if (waited) return waited;
    }
    // No normal target is reachable. Fall through; the last resort is eligible.
  }

  // Both advance when the deferral above slept; they are identical to `now` and
  // `options.waitForCooldownMs` when it did not, so the non-policy path is unchanged.
  const clock = now + spentWaitMs;
  const remainingWaitMs = options.waitForCooldownMs - spentWaitMs;

  const pick = pickComboTarget(config, comboId, {
    exclude: excluded,
    eligible: target => eligibleAt(target, clock),
    now: clock,
  });
  if (pick || remainingWaitMs <= 0 || options.abortSignal?.aborted) return pick;
  const combo = getCombo(config, comboId);
  if (!combo) throw new UnknownComboError(comboId);
  const waitingTargets = combo.targets.filter(target =>
    targetProviderIsUsable(config, target, clock)
    && !excluded.has(targetKey(target))
    && isComboTargetInCooldown(comboId, target, clock)
    && (customEligible?.(target) ?? true),
  );
  const earliest = earliestComboCooldown(comboId, waitingTargets, clock);
  if (earliest === undefined) return null;
  const delay = earliest.expiry - clock;
  if (delay > remainingWaitMs) return null;
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
    now: clock + delay,
    eligible: targetCandidate => eligibleAt(targetCandidate, clock + delay),
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

export function tryPickComboModel(config: OcxConfig, modelId: string, preview = false): ComboPick | null {
  const comboId = resolveComboId(config, modelId);
  if (!comboId) return null;
  if (!getCombo(config, comboId)) throw new UnknownComboError(comboId);
  const picked = pickComboTarget(config, comboId, { preview });
  if (!picked) throw new NoAvailableComboTargetsError(comboId);
  return picked;
}
