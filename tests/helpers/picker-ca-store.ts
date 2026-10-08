import { readFileSync, writeFileSync } from "node:fs";
import type { PickerCaStore } from "../../src/claude/intercept/picker-ca-store";

/** Test-only private fixture transport; production never stores signing keys in files. */
export function filePickerCaStore(path: string): PickerCaStore {
  return () => ({
    getPassword: () => {
      try { return readFileSync(path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    setPassword: value => writeFileSync(path, value, { mode: 0o600 }),
  });
}

export function memoryPickerCaStore(): { store: PickerCaStore; value: string | null; writes: number } {
  const state = { value: null as string | null, writes: 0, store: undefined as unknown as PickerCaStore };
  state.store = () => ({ getPassword: () => state.value, setPassword: value => { state.value = value; state.writes++; } });
  return state;
}
