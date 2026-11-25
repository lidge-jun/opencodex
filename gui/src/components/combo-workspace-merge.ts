import type { ComboItem } from "../combo-workspace-data";

function comparable(value: unknown, key: string): string | undefined {
  if (["allowMeteredTargets", "quotaOnlyFallback", "preserveFallbackModel"].includes(key)) return JSON.stringify(Boolean(value));
  if (key === "targets" && Array.isArray(value)) {
    return JSON.stringify(value.map(({ clientKey: _clientKey, ...target }) => ({ ...target, metered: Boolean(target.metered) })));
  }
  return JSON.stringify(value);
}

export function mergeComboDraft(previous: ComboItem, draft: ComboItem, remote: ComboItem) {
  const merged = { ...remote };
  const conflicts: string[] = [];
  for (const key of Object.keys({ ...previous, ...draft, ...remote }) as (keyof ComboItem)[]) {
    const oldValue = comparable(previous[key], key);
    const localValue = comparable(draft[key], key);
    const remoteValue = comparable(remote[key], key);
    if (localValue !== oldValue) {
      Object.assign(merged, { [key]: draft[key] });
      if (remoteValue !== oldValue && remoteValue !== localValue) conflicts.push(key);
    }
  }
  return { merged, conflicts };
}
