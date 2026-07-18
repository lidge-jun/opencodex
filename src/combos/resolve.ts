import type { OcxComboConfig, OcxComboTarget, OcxConfig } from "../types";
import {
  coolComboTarget,
  isComboTargetInCooldown,
} from "./failover";
import {
  getCombo,
  parseComboModelId,
  targetKey,
} from "./types";

export interface ComboPick {
  comboId: string;
  target: OcxComboTarget;
  targetIndex: number;
  /** Keys already attempted this request (including the returned target). */
  attempted: string[];
}

interface StickyState {
  index: number;
  successesLeft: number;
}

/** In-memory sticky RR cursor per combo id. */
const stickyState = new Map<string, StickyState>();

export function clearComboStickyState(comboId?: string): void {
  if (!comboId) {
    stickyState.clear();
    return;
  }
  stickyState.delete(comboId);
}

function weightedIndex(targets: OcxComboTarget[], start: number, exclude: Set<string>, now: number, comboId: string): number {
  const eligible: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < targets.length; i++) {
    const idx = (start + i) % targets.length;
    const t = targets[idx]!;
    const key = targetKey(t);
    if (exclude.has(key)) continue;
    if (isComboTargetInCooldown(comboId, t, now)) continue;
    eligible.push(idx);
    weights.push(Math.max(1, t.weight ?? 1));
  }
  if (eligible.length === 0) return -1;
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.floor(Math.random() * total);
  for (let i = 0; i < eligible.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return eligible[i]!;
  }
  return eligible[0]!;
}

function nextFailoverIndex(targets: OcxComboTarget[], start: number, exclude: Set<string>, now: number, comboId: string): number {
  for (let i = 0; i < targets.length; i++) {
    const idx = (start + i) % targets.length;
    const t = targets[idx]!;
    if (exclude.has(targetKey(t))) continue;
    if (isComboTargetInCooldown(comboId, t, now)) continue;
    return idx;
  }
  return -1;
}

function pickIndex(comboId: string, combo: OcxComboConfig, exclude: Set<string>, now: number): number {
  const targets = combo.targets;
  if (targets.length === 0) return -1;
  const strategy = combo.strategy ?? "failover";
  if (strategy === "round-robin") {
    const sticky = stickyState.get(comboId);
    const start = sticky?.index ?? 0;
    return weightedIndex(targets, start, exclude, now, comboId);
  }
  return nextFailoverIndex(targets, 0, exclude, now, comboId);
}

/** Record a successful combo hop so sticky RR can rotate after stickyLimit successes. */
export function noteComboSuccess(comboId: string, combo: OcxComboConfig, targetIndex: number): void {
  if ((combo.strategy ?? "failover") !== "round-robin") return;
  const limit = combo.stickyLimit ?? 1;
  const prev = stickyState.get(comboId);
  if (prev && prev.index === targetIndex && prev.successesLeft > 1) {
    stickyState.set(comboId, { index: targetIndex, successesLeft: prev.successesLeft - 1 });
    return;
  }
  const nextIndex = (targetIndex + 1) % Math.max(combo.targets.length, 1);
  stickyState.set(comboId, { index: nextIndex, successesLeft: limit });
}

/**
 * Pick the next healthy combo target (does not call routeModel — avoids circular imports).
 * Returns null when every target is excluded or cooled down.
 */
export function pickComboTarget(
  config: OcxConfig,
  comboId: string,
  opts?: { exclude?: Iterable<string>; now?: number },
): ComboPick | null {
  const combo = getCombo(config, comboId);
  if (!combo) throw new Error(`Unknown combo: ${comboId}`);
  const now = opts?.now ?? Date.now();
  const exclude = new Set(opts?.exclude ?? []);
  const idx = pickIndex(comboId, combo, exclude, now);
  if (idx < 0) return null;
  const target = combo.targets[idx]!;
  return {
    comboId,
    target,
    targetIndex: idx,
    attempted: [...exclude, targetKey(target)],
  };
}

/** If `modelId` is `combo/<id>`, pick the first available target; otherwise null. */
export function tryPickComboModel(
  config: OcxConfig,
  modelId: string,
  opts?: { exclude?: Iterable<string>; now?: number },
): ComboPick | null {
  const comboId = parseComboModelId(modelId);
  if (!comboId) return null;
  if (!config.combos?.[comboId]) {
    throw new Error(`Unknown combo: ${comboId}`);
  }
  const picked = pickComboTarget(config, comboId, opts);
  if (!picked) {
    throw new Error(`No available targets for combo: ${comboId}`);
  }
  return picked;
}

export function advanceComboAfterFailure(
  config: OcxConfig,
  comboId: string,
  failed: Pick<OcxComboTarget, "provider" | "model">,
  attempted: string[],
  opts?: { retryAfter?: string | null; now?: number },
): ComboPick | null {
  coolComboTarget(comboId, failed, opts);
  return pickComboTarget(config, comboId, {
    exclude: attempted,
    now: opts?.now,
  });
}
