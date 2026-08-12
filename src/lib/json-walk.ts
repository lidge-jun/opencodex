/**
 * Shared read-only JSON tree traversal for admission/accounting walks.
 *
 * Both request-size accounting (`boundedJsonSerializedByteLength`) and token estimation
 * (`countJsonTokens`) walk parsed client payloads with the same value/array/object frame
 * mechanics: iterative over container/index frames (deep nesting cannot overflow the
 * call stack), lazy own-key enumeration (no key arrays proportional to the payload),
 * and early termination once the caller's budget is exceeded. This primitive owns that
 * machinery; the two walkers only differ in what they count per node.
 */

export interface JsonWalkHooks {
  /** Called for every leaf value: string, number, boolean, null, and undefined. */
  onValue?(value: unknown): void;
  /** Called for every own enumerable object key (before its value). */
  onObjectKey?(key: string): void;
  onArrayStart?(): void;
  onArrayEnd?(): void;
  onArraySeparator?(): void;
  onObjectStart?(): void;
  onObjectEnd?(): void;
  onObjectSeparator?(): void;
  /** Stop the walk as soon as this returns true (checked before each frame). */
  isDone?(): boolean;
}

type Frame =
  | { kind: "value"; value: unknown }
  | { kind: "array"; array: unknown[]; index: number }
  | { kind: "object"; keys: Generator<string>; record: Record<string, unknown>; count: number };

function* ownEnumerableKeys(record: Record<string, unknown>): Generator<string> {
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) yield key;
  }
}

/**
 * Iteratively walk a parsed JSON value, invoking the hooks in structural order. The
 * walk stops when `hooks.isDone()` returns true; the caller decides how much it counted
 * and whether that crossed its budget.
 */
export function walkJsonTree(value: unknown, hooks: JsonWalkHooks): void {
  const stack: Frame[] = [{ kind: "value", value }];
  while (stack.length > 0 && !(hooks.isDone?.() ?? false)) {
    const frame = stack.pop()!;
    if (frame.kind === "value") {
      const current = frame.value;
      if (Array.isArray(current)) {
        hooks.onArrayStart?.();
        stack.push({ kind: "array", array: current, index: 0 });
      } else if (current && typeof current === "object") {
        const record = current as Record<string, unknown>;
        hooks.onObjectStart?.();
        stack.push({ kind: "object", keys: ownEnumerableKeys(record), record, count: 0 });
      } else {
        hooks.onValue?.(current);
      }
    } else if (frame.kind === "array") {
      if (frame.index < frame.array.length) {
        if (frame.index > 0) hooks.onArraySeparator?.();
        stack.push({ kind: "array", array: frame.array, index: frame.index + 1 });
        stack.push({ kind: "value", value: frame.array[frame.index] });
      } else {
        hooks.onArrayEnd?.();
      }
    } else {
      const next = frame.keys.next();
      if (next.done) {
        hooks.onObjectEnd?.();
      } else {
        if (frame.count > 0) hooks.onObjectSeparator?.();
        hooks.onObjectKey?.(next.value);
        stack.push({ kind: "object", keys: frame.keys, record: frame.record, count: frame.count + 1 });
        stack.push({ kind: "value", value: frame.record[next.value] });
      }
    }
  }
}
