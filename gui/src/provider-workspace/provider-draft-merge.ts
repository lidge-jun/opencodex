/**
 * Three-way merge for the raw provider JSON editor.
 *
 * The editor's draft is a whole config document, but the user only owns the fields they
 * changed. Applying that delta to the latest saved document keeps providers and fields
 * added or changed elsewhere, and reports a conflict when both sides changed the same
 * value, deleted a value the other side edited, or added the same name differently.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonMergeResult = { value: JsonValue; conflicts: string[] };

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]));
  }
  return false;
}

function pathKey(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

export function threeWayMergeJson(base: unknown, latest: unknown, draft: unknown, path = ""): JsonMergeResult {
  if (deepEqualJson(draft, base)) return { value: latest as JsonValue, conflicts: [] };
  if (deepEqualJson(latest, base)) return { value: draft as JsonValue, conflicts: [] };
  if (deepEqualJson(draft, latest)) return { value: draft as JsonValue, conflicts: [] };
  if (!isJsonObject(base) || !isJsonObject(latest) || !isJsonObject(draft)) {
    return { value: draft as JsonValue, conflicts: [path || "$"] };
  }

  // Own-key construction: a provider or model named __proto__ must stay data.
  const out: Record<string, JsonValue> = Object.create(null);
  const conflicts: string[] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(latest), ...Object.keys(draft)]);
  for (const key of keys) {
    const inBase = Object.hasOwn(base, key);
    const inLatest = Object.hasOwn(latest, key);
    const inDraft = Object.hasOwn(draft, key);
    const baseValue = base[key];
    const latestValue = latest[key];
    const draftValue = draft[key];

    if (!inDraft) {
      // The user removed this key.
      if (!inBase) {
        if (inLatest) out[key] = latestValue!;
        continue;
      }
      if (!inLatest) continue;
      if (deepEqualJson(latestValue, baseValue)) continue;
      conflicts.push(pathKey(path, key));
      continue;
    }

    if (!inBase) {
      // The user added this key.
      if (!inLatest) { out[key] = draftValue!; continue; }
      if (deepEqualJson(latestValue, draftValue)) { out[key] = draftValue!; continue; }
      conflicts.push(pathKey(path, key));
      out[key] = draftValue!;
      continue;
    }

    if (!inLatest) {
      // The saved document removed this key.
      if (deepEqualJson(draftValue, baseValue)) continue;
      conflicts.push(pathKey(path, key));
      out[key] = draftValue!;
      continue;
    }

    const merged = threeWayMergeJson(baseValue, latestValue, draftValue, pathKey(path, key));
    out[key] = merged.value;
    conflicts.push(...merged.conflicts);
  }
  return { value: out, conflicts };
}
