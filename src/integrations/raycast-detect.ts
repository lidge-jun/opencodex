/**
 * Detect a Raycast install and whether Custom Providers can take effect.
 *
 * Custom Providers is a Raycast Pro feature: Raycast reads
 * `~/.config/raycast/ai/providers.yaml` only while a subscription is active, and
 * the `ai` directory itself only exists once the user has clicked "Reveal
 * Providers Config" in Settings > AI. Neither fact stops the writer — the plan
 * (devlog/_plan/260904_raycast_integration/000_plan.md) makes a free plan a
 * WARNING, never a refusal — so this module only answers what status and the
 * GUI need to explain a file that is written but ignored.
 *
 * Detection is read-only and injectable, like cursor-detect.ts: nothing here
 * touches the Raycast install or its preferences, and the tests run against
 * stubbed deps rather than the machine they execute on.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type RaycastPlan = "pro" | "free" | "unknown";

export interface RaycastInstall {
  /** The app bundle or install directory, or null when none of the well-known locations exist. */
  appPath: string | null;
  /** `~/.config/raycast/ai` exists — the install signal the registry uses. */
  aiDirPresent: boolean;
  plan: RaycastPlan;
}

export interface RaycastDetectDeps {
  platform: string;
  homedir: string;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  /** stdout of `defaults read <domain> <key>` trimmed, or null when the command fails / is unavailable. */
  readDefault(domain: string, key: string): string | null;
}

/**
 * The preference Raycast writes for its subscription state. Read through
 * `defaults` rather than by parsing the plist: cfprefsd caches writes, so the
 * file on disk can lag what the running app believes.
 */
const RAYCAST_DEFAULTS_DOMAIN = "com.raycast.macos.v1";
const RAYCAST_SUBSCRIPTION_KEY = "subscriptions_active";

export function realRaycastDetectDeps(): RaycastDetectDeps {
  return {
    platform: process.platform,
    homedir: homedir(),
    env: process.env,
    exists: path => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    readDefault: (domain, key) => {
      // `defaults` is macOS-only; elsewhere the plan is simply unknown.
      if (process.platform !== "darwin") return null;
      try {
        const result = Bun.spawnSync(["defaults", "read", domain, key], { stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) return null;
        return result.stdout.toString().trim();
      } catch {
        return null;
      }
    },
  };
}

function appPathFor(deps: RaycastDetectDeps): string | null {
  // Join with the target platform's separator so a test describing another OS
  // gets that OS's paths, not the host's.
  const { join } = deps.platform === "win32" ? win32 : posix;
  if (deps.platform === "darwin") {
    for (const candidate of ["/Applications/Raycast.app", join(deps.homedir, "Applications", "Raycast.app")]) {
      if (deps.exists(candidate)) return candidate;
    }
    return null;
  }
  if (deps.platform === "win32") {
    const local = deps.env.LOCALAPPDATA;
    if (!local) return null;
    const candidate = join(local, "Programs", "Raycast");
    return deps.exists(candidate) ? candidate : null;
  }
  return null;
}

function planFor(deps: RaycastDetectDeps): RaycastPlan {
  if (deps.platform !== "darwin") return "unknown";
  // Read once: `defaults` spawns a process, and the answer cannot change
  // between two reads inside one detection.
  const value = deps.readDefault(RAYCAST_DEFAULTS_DOMAIN, RAYCAST_SUBSCRIPTION_KEY);
  if (value === "1") return "pro";
  if (value === "0") return "free";
  return "unknown";
}

export function detectRaycast(deps: RaycastDetectDeps = realRaycastDetectDeps()): RaycastInstall {
  const { join } = deps.platform === "win32" ? win32 : posix;
  return {
    appPath: appPathFor(deps),
    // Raycast ignores XDG and uses this path on every platform it ships on.
    aiDirPresent: deps.exists(join(deps.homedir, ".config", "raycast", "ai")),
    plan: planFor(deps),
  };
}
