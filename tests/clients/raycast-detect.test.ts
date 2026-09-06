import { describe, expect, test } from "bun:test";
import { detectRaycast, type RaycastDetectDeps } from "../../src/integrations/raycast-detect";

/**
 * Stubbed deps only. The real detector spawns `defaults` and reads the
 * developer's subscription state, and this suite must pass identically on a
 * machine with Raycast Pro, with the free tier, and with no Raycast at all.
 */
function fakeDeps(
  platform: string,
  existing: readonly string[],
  options: { env?: Record<string, string>; defaultValue?: string | null; homedir?: string } = {},
): RaycastDetectDeps & { defaultsReads: number } {
  const present = new Set(existing);
  const deps = {
    platform,
    homedir: options.homedir ?? (platform === "win32" ? "C:\\Users\\u" : "/home/u"),
    env: options.env ?? {},
    defaultsReads: 0,
    exists: (path: string) => present.has(path),
    readDefault: (domain: string, key: string) => {
      deps.defaultsReads += 1;
      expect(domain).toBe("com.raycast.macos.v1");
      expect(key).toBe("subscriptions_active");
      return options.defaultValue ?? null;
    },
  };
  return deps;
}

describe("detectRaycast", () => {
  test("darwin: a Pro subscription, the app bundle and the revealed ai folder", () => {
    const deps = fakeDeps("darwin", ["/Applications/Raycast.app", "/home/u/.config/raycast/ai"], { defaultValue: "1" });
    expect(detectRaycast(deps)).toEqual({
      appPath: "/Applications/Raycast.app",
      aiDirPresent: true,
      plan: "pro",
    });
    // One process spawn per detection, not one per field.
    expect(deps.defaultsReads).toBe(1);
  });

  test("darwin: the free tier is reported, not refused, and the user-local bundle is found", () => {
    const deps = fakeDeps("darwin", ["/home/u/Applications/Raycast.app"], { defaultValue: "0" });
    expect(detectRaycast(deps)).toEqual({
      appPath: "/home/u/Applications/Raycast.app",
      aiDirPresent: false,
      plan: "free",
    });
  });

  test("darwin: a failed or unexpected defaults read is unknown, never free", () => {
    expect(detectRaycast(fakeDeps("darwin", [], { defaultValue: null })).plan).toBe("unknown");
    expect(detectRaycast(fakeDeps("darwin", [], { defaultValue: "(null)" })).plan).toBe("unknown");
    expect(detectRaycast(fakeDeps("darwin", [], { defaultValue: "" })).plan).toBe("unknown");
  });

  test("win32: LOCALAPPDATA\\Programs\\Raycast is the install path and the plan is unknown", () => {
    const local = "C:\\Users\\u\\AppData\\Local";
    const deps = fakeDeps("win32", [`${local}\\Programs\\Raycast`, "C:\\Users\\u\\.config\\raycast\\ai"], {
      env: { LOCALAPPDATA: local },
      defaultValue: "1",
    });
    expect(detectRaycast(deps)).toEqual({
      appPath: `${local}\\Programs\\Raycast`,
      aiDirPresent: true,
      plan: "unknown",
    });
    // `defaults` does not exist off macOS, so it is never asked.
    expect(deps.defaultsReads).toBe(0);
  });

  test("win32: no LOCALAPPDATA means no app path rather than a guessed one", () => {
    expect(detectRaycast(fakeDeps("win32", [])).appPath).toBeNull();
  });

  test("linux: nothing is detected and nothing is spawned", () => {
    const deps = fakeDeps("linux", [], { defaultValue: "1" });
    expect(detectRaycast(deps)).toEqual({ appPath: null, aiDirPresent: false, plan: "unknown" });
    expect(deps.defaultsReads).toBe(0);
  });
});
