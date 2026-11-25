import type { ComboItem, ComboTarget } from "../combo-workspace-data";

function comparable(value: unknown, key: string): string | undefined {
  if (["allowMeteredTargets", "quotaOnlyFallback", "preserveFallbackModel", "metered"].includes(key)) return JSON.stringify(Boolean(value));
  return JSON.stringify(value);
}

const identity = (target: ComboTarget) => !target.provider.trim() || !target.model.trim()
  ? JSON.stringify(["draft", target.clientKey, null])
  : JSON.stringify([target.provider.trim(), target.model.trim()]);
const targetValue = (target: ComboTarget) => {
  const { clientKey: _clientKey, ...rest } = target;
  return JSON.stringify({ ...rest, metered: Boolean(target.metered) });
};

function mergeTargets(previous: ComboTarget[], draft: ComboTarget[], remote: ComboTarget[]) {
  const old = new Map(previous.map(target => [identity(target), target]));
  const local = new Map(draft.map(target => [identity(target), target]));
  const incoming = new Map(remote.map(target => [identity(target), target]));
  const merged = new Map<string, ComboTarget>();
  let conflict = false;
  for (const key of new Set([...old.keys(), ...local.keys(), ...incoming.keys()])) {
    const before = old.get(key), mine = local.get(key), theirs = incoming.get(key);
    if (!before) {
      if (mine && theirs && targetValue(mine) !== targetValue(theirs)) {
        conflict = true;
        merged.set(key, { ...mine, metered: Boolean(mine.metered || theirs.metered) });
      } else if (mine || theirs) merged.set(key, (mine || theirs)!);
      continue;
    }
    if (!mine || !theirs) {
      const survivor = mine || theirs;
      if (survivor && targetValue(survivor) !== targetValue(before)) {
        conflict = true;
        // A remotely removed target with local edits needs an explicit decision.
        if (mine) merged.set(key, mine);
      }
      continue;
    }
    const target = { ...theirs, clientKey: mine.clientKey ?? theirs.clientKey };
    for (const field of ["weight", "reasoningEfforts", "modelProfile", "metered"] as const) {
      const prior = comparable(before[field], field);
      const myValue = comparable(mine[field], field);
      const theirValue = comparable(theirs[field], field);
      if (myValue !== prior) {
        Object.assign(target, { [field]: mine[field] });
        if (theirValue !== prior && theirValue !== myValue) {
          conflict = true;
          if (field === "metered") target.metered = Boolean(mine.metered || theirs.metered);
        }
      }
    }
    merged.set(key, target);
  }
  const oldOrder = previous.map(identity).filter(key => local.has(key));
  const localOrder = draft.map(identity).filter(key => old.has(key));
  const reordered = JSON.stringify(oldOrder) !== JSON.stringify(localOrder);
  const common = new Set([...old.keys()].filter(key => local.has(key) && incoming.has(key)));
  const baselineOrder = previous.map(identity).filter(key => common.has(key));
  const myOrder = draft.map(identity).filter(key => common.has(key));
  const theirOrder = remote.map(identity).filter(key => common.has(key));
  const sameOrder = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const remoteReordered = !sameOrder(baselineOrder, theirOrder);
  const orderConflict = !sameOrder(baselineOrder, myOrder) && remoteReordered && !sameOrder(myOrder, theirOrder);
  const hasIncomplete = draft.some(target => !target.provider.trim() || !target.model.trim());
  const order = reordered || (hasIncomplete && !remoteReordered) ? [...draft, ...remote] : [...remote, ...draft];
  const targets: ComboTarget[] = [];
  for (const item of order) {
    const key = identity(item);
    const target = merged.get(key);
    if (target) { targets.push(target); merged.delete(key); }
  }
  return { targets, conflict, orderConflict };
}

/**
 * Resolve only a target-order conflict in favor of the saved order: targets that also exist on
 * the server take its order, while draft-only targets keep their slots and every target keeps
 * its merged fields.
 */
export function applySavedTargetOrder(current: ComboTarget[], saved: ComboTarget[]): ComboTarget[] {
  const byKey = new Map(current.map(target => [identity(target), target]));
  const savedOrder = saved.map(identity).filter(key => byKey.has(key));
  const shared = new Set(savedOrder);
  let next = 0;
  return current.map(target => shared.has(identity(target)) ? byKey.get(savedOrder[next++]!)! : target);
}

export function mergeComboDraft(previous: ComboItem, draft: ComboItem, remote: ComboItem) {
  const merged = { ...remote };
  const conflicts: string[] = [];
  const targets = mergeTargets(previous.targets, draft.targets, remote.targets);
  merged.targets = targets.targets;
  if (targets.conflict) conflicts.push("targets");
  if (targets.orderConflict) conflicts.push("targets order");
  for (const key of Object.keys({ ...previous, ...draft, ...remote }) as (keyof ComboItem)[]) {
    if (key === "targets") continue;
    const oldValue = comparable(previous[key], key);
    const localValue = comparable(draft[key], key);
    const remoteValue = comparable(remote[key], key);
    if (localValue !== oldValue) {
      Object.assign(merged, { [key]: draft[key] });
      if (remoteValue !== oldValue && remoteValue !== localValue) {
        conflicts.push(key);
        if (key === "allowMeteredTargets") merged.allowMeteredTargets = Boolean(draft.allowMeteredTargets && remote.allowMeteredTargets);
      }
    }
  }
  return { merged, conflicts };
}
