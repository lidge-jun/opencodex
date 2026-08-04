import type { TranslatorBudget } from "../../lib/translator-budget";

export interface CursorKvStore {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

export function createCursorKvStore(
  seed: Record<string, Uint8Array>,
  budget: TranslatorBudget,
): CursorKvStore {
  const values = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const sizes = new Map<string, number>();
  for (const [key, value] of Object.entries(seed)) {
    const bytes = encoder.encode(key).byteLength + value.byteLength;
    budget.chargeRetained(bytes, { kind: "cursor_kv" });
    values.set(key, cloneBytes(value));
    sizes.set(key, bytes);
  }

  return {
    get(key) {
      const value = values.get(key);
      if (!value) return undefined;
      budget.chargeRetained(value.byteLength, { kind: "cursor_kv" });
      const cloned = cloneBytes(value);
      queueMicrotask(() => budget.releaseRetained(value.byteLength, { kind: "cursor_kv" }));
      return cloned;
    },
    set(key, value) {
      const nextBytes = encoder.encode(key).byteLength + value.byteLength;
      const previousBytes = sizes.get(key) ?? 0;
      const reservation = budget.reserveTransient(nextBytes, { kind: "cursor_kv" });
      let cloned: Uint8Array;
      try {
        cloned = cloneBytes(value);
      } catch (error) {
        reservation.release();
        throw error;
      }
      values.set(key, cloned);
      sizes.set(key, nextBytes);
      reservation.commitRetained();
      budget.releaseRetained(previousBytes, { kind: "cursor_kv" });
    },
  };
}
