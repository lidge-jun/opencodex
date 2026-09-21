/**
 * Copying a value the way a consumer that must not observe later edits needs it copied.
 *
 * Serializing with JSON is not a copier and using it as one is a quiet hole: it drops functions
 * without saying so, and it invokes getters and toJSON, so the object being copied gets to decide
 * what the copy contains. Every read here goes through a property descriptor instead, including
 * array elements, which an exotic array can define as accessors just as an object can.
 *
 * The contract is narrow on purpose. This copies what JSON could have produced and refuses
 * everything else rather than approximating it: an accessor, a cycle, a function, a class instance,
 * a Map, a Date, a symbol value, a bigint, a non-finite number. A caller that is refused has to
 * decide what to do about it, which is the point; a copier that silently degraded would leave the
 * caller believing it held a snapshot of something it never read.
 *
 * Symbol-keyed properties are skipped rather than refused. Process bookkeeping rides on symbols by
 * convention here, and none of it is the data a consumer is being given a copy of.
 */

/** A copy, or a refusal. A union rather than a nullable value, because null is copyable data. */
export type PlainDataCopy<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const REFUSED = Symbol("refused");

export function copyPlainData<T>(value: T): PlainDataCopy<T> {
  const copied = copyValue(value, new Set());
  return copied === REFUSED ? { ok: false } : { ok: true, value: copied as T };
}

/**
 * A stable string for comparing two plain-data values.
 *
 * Key-sorted entry pairs rather than objects, because property order is observable through
 * serialization and two values that differ only in it are the same value.
 */
export function canonicalPlainData(value: unknown): string {
  return JSON.stringify(sorted(value));
}

/** Own enumerable string keys, with null in the position of any key that is an accessor. */
export function ownDataKeys(value: Record<string, unknown>): Array<string | null> {
  return Object.keys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined ? key : null;
  });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyValue(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value as number) ? value : REFUSED;
  if (type !== "object") return REFUSED;
  const object = value as object;
  if (seen.has(object)) return REFUSED;
  seen.add(object);
  try {
    if (Array.isArray(object)) return copyArray(object, seen);
    if (!isPlainObject(object)) return REFUSED;
    const copied: Record<string, unknown> = {};
    for (const key of ownDataKeys(object)) {
      if (key === null) return REFUSED;
      const entry = (object as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      const item = copyValue(entry, seen);
      if (item === REFUSED) return REFUSED;
      copied[key] = item;
    }
    return copied;
  } finally {
    seen.delete(object);
  }
}

function copyArray(source: unknown[], seen: Set<object>): unknown {
  const copied: unknown[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(source, index);
    // A hole is written as null, which is what a reader of the serialized value would find there.
    if (descriptor === undefined) { copied.push(null); continue; }
    if (descriptor.get !== undefined || descriptor.set !== undefined) return REFUSED;
    if (descriptor.value === undefined) { copied.push(null); continue; }
    const item = copyValue(descriptor.value, seen);
    if (item === REFUSED) return REFUSED;
    copied.push(item);
  }
  return copied;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => [key, sorted((value as Record<string, unknown>)[key])]);
  }
  return value;
}
