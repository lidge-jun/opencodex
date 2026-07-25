import { describe, expect, test } from "bun:test";
import {
  GLOBAL_VIEW_KEY,
  LEGACY_GLOBAL_VIEW_KEY,
  ensureMigratedViewMode,
  migrateLegacyViewMode,
  providersHashForGlobalViewChange,
  providersHashForViewMode,
  readViewMode,
  toggleViewMode,
  viewModeFromProvidersHash,
  writeViewMode,
  type StorageLike,
} from "../src/view-mode";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
  };
}

class ThrowingStorage implements StorageLike {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
}

describe("view-mode preference", () => {
  test("defaults to classic when nothing is stored", () => {
    expect(readViewMode(memoryStorage())).toBe("classic");
  });

  test("reads canonical classic and workspace", () => {
    expect(readViewMode(memoryStorage({ [GLOBAL_VIEW_KEY]: "classic" }))).toBe("classic");
    expect(readViewMode(memoryStorage({ [GLOBAL_VIEW_KEY]: "workspace" }))).toBe("workspace");
  });

  test("accepts the interim legacy global key", () => {
    expect(readViewMode(memoryStorage({ [LEGACY_GLOBAL_VIEW_KEY]: "workspace" }))).toBe("workspace");
  });

  test("migrates providers-only workspace preference", () => {
    const storage = memoryStorage({ "ocx-providers-view": "workspace" });
    expect(migrateLegacyViewMode(storage)).toBe("workspace");
    expect(ensureMigratedViewMode(storage)).toBe("workspace");
    expect(storage.data[GLOBAL_VIEW_KEY]).toBe("workspace");
    expect(storage.data["ocx-dashboard-view"]).toBe("workspace");
  });

  test("mixed old keys prefer dashboard then providers", () => {
    expect(migrateLegacyViewMode(memoryStorage({
      "ocx-dashboard-view": "classic",
      "ocx-providers-view": "workspace",
    }))).toBe("classic");
    expect(migrateLegacyViewMode(memoryStorage({
      "ocx-providers-view": "workspace",
    }))).toBe("workspace");
  });

  test("storage access throwing falls back to classic", () => {
    expect(readViewMode(new ThrowingStorage())).toBe("classic");
    writeViewMode("workspace", new ThrowingStorage()); // must not throw
  });

  test("toggle updates canonical key", () => {
    const storage = memoryStorage();
    const next = toggleViewMode(readViewMode(storage));
    writeViewMode(next, storage);
    expect(next).toBe("workspace");
    expect(storage.data[GLOBAL_VIEW_KEY]).toBe("workspace");
    expect(readViewMode(storage)).toBe("workspace");
  });
});

describe("providers hash sync helpers", () => {
  test("maps both toggle directions while Providers is active", () => {
    expect(providersHashForGlobalViewChange("#providers", "workspace", true)).toBe("providers/workspace");
    expect(providersHashForGlobalViewChange("#providers/workspace", "classic", true)).toBe("providers");
    expect(providersHashForGlobalViewChange("#providers/workspace", "workspace", true)).toBeNull();
    expect(providersHashForGlobalViewChange("#providers", "workspace", false)).toBeNull();
  });

  test("round-trips hash helpers", () => {
    expect(providersHashForViewMode("workspace")).toBe("providers/workspace");
    expect(viewModeFromProvidersHash("providers/workspace")).toBe("workspace");
    expect(viewModeFromProvidersHash("providers")).toBe("classic");
    expect(viewModeFromProvidersHash("dashboard")).toBeNull();
  });
});
