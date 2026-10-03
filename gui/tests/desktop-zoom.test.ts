import { describe, expect, test } from "bun:test";
import {
  accumulateWheel,
  applyWebviewZoom,
  clampZoom,
  readSavedZoom,
  stepZoom,
  WHEEL_STEP_PX,
  writeSavedZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STORAGE_KEY,
  zoomKeyAction,
  zoomManagedOn,
  zoomPercent,
} from "../src/lib/desktop-zoom";

/**
 * Desktop page zoom. Tauri's polyfill restarted at 100% on every page load and never saved
 * the level; these pin the dashboard-owned replacement: the same keys and steps, a remembered
 * level, and a level that can never leave the range or drift off whole percents.
 */
describe("zoom levels", () => {
  test("steps by ten points and returns to 100% on reset", () => {
    expect(stepZoom(1, "in")).toBe(1.1);
    expect(stepZoom(1, "out")).toBe(0.9);
    expect(stepZoom(1.7, "reset")).toBe(1);
  });

  test("repeated steps stay on whole percents", () => {
    let zoom = 1;
    for (let i = 0; i < 7; i += 1) zoom = stepZoom(zoom, "in");
    expect(zoom).toBe(1.7);
    expect(zoomPercent(zoom)).toBe(170);
  });

  test("never leaves the supported range", () => {
    let zoom = 1;
    for (let i = 0; i < 100; i += 1) zoom = stepZoom(zoom, "in");
    expect(zoom).toBe(ZOOM_MAX);
    for (let i = 0; i < 100; i += 1) zoom = stepZoom(zoom, "out");
    expect(zoom).toBe(ZOOM_MIN);
  });

  test("a non-finite level falls back to 100%", () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("remembered level", () => {
  const memory = (initial?: string) => {
    const values = new Map<string, string>(initial === undefined ? [] : [[ZOOM_STORAGE_KEY, initial]]);
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
  };

  test("round-trips through storage", () => {
    const storage = memory();
    writeSavedZoom(1.3, storage);
    expect(readSavedZoom(storage)).toBe(1.3);
  });

  test("an empty, garbled or out-of-range value reads as something safe", () => {
    expect(readSavedZoom(memory())).toBe(1);
    expect(readSavedZoom(memory("wide"))).toBe(1);
    expect(readSavedZoom(memory("9"))).toBe(ZOOM_MAX);
    expect(readSavedZoom(memory("0.01"))).toBe(ZOOM_MIN);
  });

  test("a storage that throws neither reads nor writes loudly", () => {
    const broken = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(readSavedZoom(broken)).toBe(1);
    expect(() => writeSavedZoom(1.2, broken)).not.toThrow();
  });
});

describe("key bindings", () => {
  const press = (key: string, mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey">> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  test("Ctrl drives zoom on Linux and Cmd on macOS, never the other", () => {
    expect(zoomKeyAction(press("=", { ctrlKey: true }), "linux")).toBe("in");
    expect(zoomKeyAction(press("+", { ctrlKey: true }), "linux")).toBe("in");
    expect(zoomKeyAction(press("-", { ctrlKey: true }), "linux")).toBe("out");
    expect(zoomKeyAction(press("0", { ctrlKey: true }), "linux")).toBe("reset");
    expect(zoomKeyAction(press("=", { metaKey: true }), "macos")).toBe("in");
    expect(zoomKeyAction(press("=", { metaKey: true }), "linux")).toBeNull();
    expect(zoomKeyAction(press("=", { ctrlKey: true }), "macos")).toBeNull();
  });

  test("a bare key or another key is ignored", () => {
    expect(zoomKeyAction(press("="), "linux")).toBeNull();
    expect(zoomKeyAction(press("b", { ctrlKey: true }), "linux")).toBeNull();
  });

  test("an Alt chord is handled like Tauri's polyfill handled it, so the dashboard stays the only writer", () => {
    expect(zoomKeyAction(press("=", { ctrlKey: true, altKey: true }), "linux")).toBe("in");
    expect(zoomKeyAction(press("-", { ctrlKey: true, altKey: true }), "linux")).toBe("out");
  });

  test("only macOS and Linux are managed by the dashboard", () => {
    expect(zoomManagedOn("linux")).toBe(true);
    expect(zoomManagedOn("macos")).toBe(true);
    expect(zoomManagedOn("windows")).toBe(false);
    expect(zoomManagedOn("unknown")).toBe(false);
  });
});

describe("wheel gestures", () => {
  test("one mouse notch is one step, up zooming in", () => {
    expect(accumulateWheel(0, -100)).toEqual({ accumulated: 0, action: "in" });
    expect(accumulateWheel(0, 100)).toEqual({ accumulated: 0, action: "out" });
  });

  test("small touchpad deltas add up before they step", () => {
    let acc = 0;
    let steps = 0;
    for (let i = 0; i < 20; i += 1) {
      const next = accumulateWheel(acc, -5);
      acc = next.accumulated;
      if (next.action) steps += 1;
    }
    expect(steps).toBe(Math.floor((20 * 5) / WHEEL_STEP_PX));
  });

  test("reversing direction starts a new gesture", () => {
    const first = accumulateWheel(0, -30);
    expect(first.action).toBeNull();
    expect(accumulateWheel(first.accumulated, 30).accumulated).toBe(30);
  });

  test("a zero delta changes nothing", () => {
    expect(accumulateWheel(-20, 0)).toEqual({ accumulated: -20, action: null });
  });
});

describe("talking to the shell", () => {
  test("without a shell nothing is applied and nothing throws", async () => {
    const saved = Reflect.get(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    try {
      expect(await applyWebviewZoom(1.2)).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: saved });
    }
  });
});
