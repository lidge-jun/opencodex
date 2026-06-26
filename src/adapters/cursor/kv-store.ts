export interface CursorKvStore {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

export function createCursorKvStore(seed: Record<string, Uint8Array> = {}): CursorKvStore {
  const values = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(seed)) {
    values.set(key, cloneBytes(value));
  }

  return {
    get(key) {
      const value = values.get(key);
      return value ? cloneBytes(value) : undefined;
    },
    set(key, value) {
      values.set(key, cloneBytes(value));
    },
  };
}
