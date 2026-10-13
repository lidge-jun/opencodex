/**
 * Cold start for `ocx ensure` when OpenCodex Desktop owns or runs the proxy (#6971).
 *
 * The Codex launcher shim runs `ocx ensure` before every Codex launch. Without this policy,
 * ensure spawned a detached CLI proxy whenever nothing answered on the port. That is wrong in two
 * Desktop situations: during the Desktop supervisor's restart backoff, and after Desktop quit
 * while its durable ownership claim remains. In both, the CLI proxy took the port and Desktop came
 * back as a guest without supervision. That is why the dashboard used to disable the shim under
 * Desktop.
 *
 * Rules, in order:
 * - A running Desktop app is the supervisor. Wait for its proxy; never start a competing one.
 * - A durable Desktop claim with no running app: start Desktop (hidden, as a login launch would)
 *   where that is possible, then wait. Elsewhere, fail with guidance. A missing Desktop process
 *   never authorizes a CLI proxy by itself; handing ownership to the CLI stays an explicit
 *   `ocx service install` consent step.
 * - No claim and no running app: the ordinary CLI cold start.
 *
 * Concurrent shim launches share one Desktop launch through a short-lived lease file; every
 * caller then waits on the same readiness probe.
 */
import { execFileSync } from "node:child_process";
import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, win32 } from "node:path";
import { getConfigDir } from "../config/paths";
import { resolveServiceOwnership } from "../service/state";

export type DesktopProcessState = "running" | "absent" | "unknown";

export type EnsureColdStartPlan =
  | { kind: "spawn-cli" }
  | { kind: "wait-desktop" }
  | { kind: "launch-desktop" }
  | { kind: "refuse" };

export function planEnsureColdStart(facts: {
  desktopOwned: boolean;
  desktopProcess: DesktopProcessState;
  platform: NodeJS.Platform;
}): EnsureColdStartPlan {
  if (facts.desktopProcess === "running") return { kind: "wait-desktop" };
  if (!facts.desktopOwned) return { kind: "spawn-cli" };
  // An unverifiable process list is treated as absence for the claimed owner: relaunching through
  // LaunchServices is idempotent, and nothing here can fall back to a CLI proxy.
  return facts.platform === "darwin" ? { kind: "launch-desktop" } : { kind: "refuse" };
}

/** Desktop restart backoff tops out at 30 s; the budget covers it plus a cold sidecar start. */
export const DESKTOP_COLD_START_TIMEOUT_MS = 40_000;
/** A launch lease older than this belongs to an ensure that is no longer waiting. */
export const DESKTOP_LAUNCH_LEASE_MS = DESKTOP_COLD_START_TIMEOUT_MS + 5_000;

export type DesktopColdStartResult<T> =
  | { kind: "cli" }
  | { kind: "live"; live: T }
  | { kind: "failed"; message: string };

export interface DesktopColdStartDeps<T> {
  platform: NodeJS.Platform;
  desktopOwned: () => boolean;
  desktopProcess: () => DesktopProcessState;
  /** Start the Desktop app hidden. Returns false when the request could not be made. */
  launchDesktop: () => boolean;
  /** Returns a release function when this caller should launch, or null when another caller already did. */
  acquireLaunchLease: () => (() => void) | null;
  waitForProxy: (timeoutMs: number) => Promise<T | null>;
  info?: (line: string) => void;
}

const QUIT_HINT = "To run the proxy from this CLI instead, quit OpenCodex and run `ocx service install` or `ocx start`.";

export async function runDesktopColdStart<T>(deps: DesktopColdStartDeps<T>): Promise<DesktopColdStartResult<T>> {
  const plan = planEnsureColdStart({
    desktopOwned: deps.desktopOwned(),
    desktopProcess: deps.desktopProcess(),
    platform: deps.platform,
  });
  if (plan.kind === "spawn-cli") return { kind: "cli" };
  if (plan.kind === "refuse") {
    return { kind: "failed", message: `OpenCodex Desktop manages this proxy but is not running. Open OpenCodex to start it. ${QUIT_HINT}` };
  }
  if (plan.kind === "launch-desktop") {
    const release = deps.acquireLaunchLease();
    try {
      if (release) {
        deps.info?.("Starting OpenCodex Desktop, which manages this proxy...");
        if (!deps.launchDesktop()) {
          return { kind: "failed", message: `OpenCodex Desktop manages this proxy, but it could not be started. Open OpenCodex manually. ${QUIT_HINT}` };
        }
      }
      const live = await deps.waitForProxy(DESKTOP_COLD_START_TIMEOUT_MS);
      if (live) return { kind: "live", live };
      return { kind: "failed", message: `OpenCodex Desktop was started, but its proxy did not answer in time. Check the OpenCodex menu. ${QUIT_HINT}` };
    } finally { release?.(); }
  }
  deps.info?.("Waiting for OpenCodex Desktop to restart its proxy...");
  const live = await deps.waitForProxy(DESKTOP_COLD_START_TIMEOUT_MS);
  if (live) return { kind: "live", live };
  return {
    kind: "failed",
    message: `OpenCodex Desktop is running but its proxy is not answering. Use Start Proxy in the OpenCodex menu. ${QUIT_HINT}`,
  };
}

type Execute = (command: string, args: string[], timeoutMs: number) => string;

function execute(command: string, args: string[], timeoutMs: number): string {
  return execFileSync(command, args, {
    encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
}

/** Whether this user has an OpenCodex Desktop app process, by image name. */
export function inspectDesktopProcess(options: {
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  run?: Execute;
} = {}): DesktopProcessState {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? execute;
  try {
    if (platform === "win32") {
      const env = options.env ?? process.env;
      const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
      const output = run(win32.join(root, "System32", "tasklist.exe"),
        ["/FI", "IMAGENAME eq opencodex-desktop.exe", "/FO", "CSV", "/NH"], 3_000);
      return /^"opencodex-desktop\.exe",/im.test(output) ? "running" : "absent";
    }
    if (platform !== "darwin" && platform !== "linux") return "absent";
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) return "unknown";
    // Linux truncates comm to 15 characters, so match the executable path in the command line.
    run("pgrep", ["-U", String(uid), "-f", "(^|/)opencodex-desktop( |$)"], 1_500);
    return "running";
  } catch (error) {
    // pgrep exits 1 when nothing matched; anything else is an unanswered question.
    return (error as { status?: unknown })?.status === 1 && platform !== "win32" ? "absent" : "unknown";
  }
}

/** Start the macOS app hidden, the same way its login item does. */
export function launchDesktopApp(options: { platform?: NodeJS.Platform; run?: Execute } = {}): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  try {
    (options.run ?? execute)("/usr/bin/open", ["-g", "-b", "com.opencodex.desktop", "--args", "--autostart"], 10_000);
    return true;
  } catch { return false; }
}

/** One Desktop launch per cold start; a stale lease from a dead caller is replaced once. */
export function acquireDesktopLaunchLease(configDir: string, now: () => number = Date.now): (() => void) | null {
  const path = join(configDir, "desktop-launch.lease");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      const created = statSync(path);
      return () => {
        try {
          const current = statSync(path);
          if (current.ino === created.ino && current.dev === created.dev) unlinkSync(path);
        } catch { /* already gone */ }
      };
    } catch (error) {
      // An unwritable lease must not suppress the launch; it only loses deduplication.
      if ((error as { code?: unknown })?.code !== "EEXIST") return () => {};
      try {
        if (now() - statSync(path).mtimeMs < DESKTOP_LAUNCH_LEASE_MS) return null;
        unlinkSync(path);
      } catch { return null; }
    }
  }
  return null;
}

/** Production wiring; `waitForProxy` is ensure's identity-checked readiness probe. */
export function productionDesktopColdStartDeps<T>(waitForProxy: (timeoutMs: number) => Promise<T | null>): DesktopColdStartDeps<T> {
  return {
    platform: process.platform,
    desktopOwned: () => {
      try {
        const owner = resolveServiceOwnership();
        return owner.kind === "owned" && owner.ownership.owner === "desktop";
      } catch { return false; }
    },
    desktopProcess: () => inspectDesktopProcess(),
    launchDesktop: () => launchDesktopApp(),
    acquireLaunchLease: () => acquireDesktopLaunchLease(getConfigDir()),
    waitForProxy,
    info: line => console.log(line),
  };
}

