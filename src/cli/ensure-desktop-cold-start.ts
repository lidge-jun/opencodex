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
 * - Ownership or the process list that cannot be read is not evidence of absence: refuse.
 * - No claim and no running app: the ordinary CLI cold start.
 *
 * Concurrent shim launches share one Desktop launch through a lease file held by a live process;
 * every caller then waits on the same readiness probe.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import { getConfigDir } from "../config/paths";
import { resolveServiceOwnership } from "../service/state";

export type DesktopProcessState = "running" | "absent" | "unknown";
export type DesktopOwnershipState = "desktop" | "other" | "unknown";

export type EnsureColdStartPlan =
  | { kind: "spawn-cli" }
  | { kind: "wait-desktop" }
  | { kind: "launch-desktop" }
  | { kind: "refuse"; reason: "desktop-unlaunchable" | "unverified" };

export function planEnsureColdStart(facts: {
  ownership: DesktopOwnershipState;
  desktopProcess: DesktopProcessState;
  platform: NodeJS.Platform;
}): EnsureColdStartPlan {
  if (facts.desktopProcess === "running") return { kind: "wait-desktop" };
  if (facts.ownership === "unknown" || facts.desktopProcess === "unknown") return { kind: "refuse", reason: "unverified" };
  if (facts.ownership === "other") return { kind: "spawn-cli" };
  return facts.platform === "darwin" ? { kind: "launch-desktop" } : { kind: "refuse", reason: "desktop-unlaunchable" };
}

/** Desktop restart backoff tops out at 30 s; the budget covers it plus a cold sidecar start. */
export const DESKTOP_COLD_START_TIMEOUT_MS = 40_000;

export type DesktopColdStartResult<T> =
  | { kind: "cli" }
  | { kind: "live"; live: T }
  | { kind: "failed"; message: string };

export interface DesktopColdStartDeps<T> {
  platform: NodeJS.Platform;
  ownership: () => DesktopOwnershipState;
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
    ownership: deps.ownership(),
    desktopProcess: deps.desktopProcess(),
    platform: deps.platform,
  });
  if (plan.kind === "spawn-cli") return { kind: "cli" };
  if (plan.kind === "refuse") {
    return { kind: "failed", message: plan.reason === "unverified"
      ? "Could not verify whether OpenCodex Desktop manages this proxy, so no CLI proxy was started. Run `ocx doctor`, or start the proxy explicitly with `ocx start`."
      : `OpenCodex Desktop manages this proxy but is not running. Open OpenCodex to start it. ${QUIT_HINT}` };
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
    encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
}

/** A Desktop app executable: `opencodex-desktop`, inside an app bundle's Contents/MacOS on macOS. */
export function isDesktopExecutable(path: string, platform: NodeJS.Platform): boolean {
  if (basename(path) !== "opencodex-desktop") return false;
  return platform !== "darwin" || (basename(dirname(path)) === "MacOS" && basename(dirname(dirname(path))) === "Contents");
}

export interface DesktopProcessOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  run?: Execute;
  /** Linux: executable paths of this user's processes, or \`unverified\`. */
  linuxExecutables?: (uid: number) => string[] | "unverified";
}

/**
 * Linux: executables of this user's processes. A process that exited mid-scan or belongs to someone
 * else is skipped; one of this user's processes whose executable cannot be read makes the answer
 * unverifiable, because it could be the Desktop app.
 */
function linuxExecutables(uid: number): string[] | "unverified" {
  const paths: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (statSync(`/proc/${entry}`).uid !== uid) continue;
      paths.push(readlinkSync(`/proc/${entry}/exe`).replace(/ \(deleted\)$/, ""));
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT" || (error as { code?: unknown })?.code === "ESRCH") continue;
      return "unverified";
    }
  }
  return paths;
}

/** Whether this user runs an OpenCodex Desktop app, judged by executable identity, never arguments. */
export function inspectDesktopProcess(options: DesktopProcessOptions = {}): DesktopProcessState {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? execute;
  try {
    const uid = options.uid ?? process.getuid?.();
    if (platform === "linux") {
      if (uid === undefined) return "unknown";
      const executables = (options.linuxExecutables ?? linuxExecutables)(uid);
      if (executables === "unverified") return "unknown";
      return executables.some(path => isDesktopExecutable(path, platform)) ? "running" : "absent";
    }
    if (platform === "darwin") {
      if (uid === undefined) return "unknown";
      // macOS reports the full executable path as comm.
      const output = run("/bin/ps", ["-U", String(uid), "-o", "comm="], 3_000);
      return output.split("\n").some(line => isDesktopExecutable(line.trim(), platform)) ? "running" : "absent";
    }
    if (platform === "win32") {
      const env = options.env ?? process.env;
      const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
      const user = env.USERNAME?.trim();
      const args = ["/FI", "IMAGENAME eq opencodex-desktop.exe", ...(user ? ["/FI", `USERNAME eq ${user}`] : []), "/FO", "CSV", "/NH"];
      const output = run(win32.join(root, "System32", "tasklist.exe"), args, 3_000);
      return /^"opencodex-desktop\.exe",/im.test(output) ? "running" : "absent";
    }
    return "absent";
  } catch {
    return "unknown";
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

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "EPERM"; }
}

function readHolder(path: string): number | null {
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

const LEASE_FILE = /^desktop-launch\.(\d+)\.lease$/;

/**
 * One Desktop launch per cold start. Leases are numbered generations, each published whole with
 * link(2), which fails if the name exists, so exactly one contender can create generation N+1. A
 * caller launches only after creating the next generation while the newest one belongs to a dead
 * process (or none exists). A lease stays valid while its holder lives, so a slow launch never
 * expires under its owner. Nothing ever moves or overwrites another holder's lease.
 */
export function acquireDesktopLaunchLease(
  configDir: string,
  io: { pid?: number; alive?: (pid: number) => boolean } = {},
): (() => void) | null {
  const pid = io.pid ?? process.pid;
  const alive = io.alive ?? processAlive;
  const leasePath = (generation: number) => join(configDir, `desktop-launch.${generation}.lease`);
  for (let attempt = 0; attempt < 4; attempt++) {
    let generations: number[];
    try {
      generations = readdirSync(configDir).flatMap(name => {
        const match = LEASE_FILE.exec(name);
        return match ? [Number(match[1])] : [];
      }).sort((a, b) => b - a);
    } catch {
      // An unreadable lease directory must not suppress the launch; it only loses deduplication.
      return () => {};
    }
    const newest = generations[0];
    if (newest !== undefined) {
      try {
        const holder = readHolder(leasePath(newest));
        if (holder !== null && alive(holder)) return null;
      } catch (error) {
        if ((error as { code?: unknown })?.code === "ENOENT") continue;
        return null;
      }
    }
    const next = (newest ?? 0) + 1;
    const staged = join(configDir, `desktop-launch.${randomUUID()}.tmp`);
    try {
      writeFileSync(staged, String(pid), { flag: "wx", mode: 0o600 });
      linkSync(staged, leasePath(next));
    } catch (error) {
      if ((error as { code?: unknown })?.code === "EEXIST") continue;
      return () => {};
    } finally {
      try { unlinkSync(staged); } catch { /* not created */ }
    }
    const release = () => {
      try { if (readHolder(leasePath(next)) === pid) unlinkSync(leasePath(next)); } catch { /* already gone */ }
    };
    // A contender with a stale directory read can publish a generation a winner already cleaned
    // up. The highest generation is the one launcher; anyone below it stands down.
    try {
      if (readdirSync(configDir).some(name => Number(LEASE_FILE.exec(name)?.[1] ?? 0) > next)) {
        release();
        return null;
      }
    } catch { /* keep the lease: the directory was readable a moment ago */ }
    // Older generations belong to dead holders: the newest was checked before publishing above it.
    for (const generation of generations) {
      try { unlinkSync(leasePath(generation)); } catch { /* already gone */ }
    }
    return release;
  }
  return null;
}

/** Production wiring; `waitForProxy` is ensure's identity-checked readiness probe. */
export function productionDesktopColdStartDeps<T>(waitForProxy: (timeoutMs: number) => Promise<T | null>): DesktopColdStartDeps<T> {
  return {
    platform: process.platform,
    ownership: () => {
      try {
        const owner = resolveServiceOwnership();
        if (owner.kind === "unknown") return "unknown";
        return owner.kind === "owned" && owner.ownership.owner === "desktop" ? "desktop" : "other";
      } catch { return "unknown"; }
    },
    desktopProcess: () => inspectDesktopProcess(),
    launchDesktop: () => launchDesktopApp(),
    acquireLaunchLease: () => acquireDesktopLaunchLease(getConfigDir()),
    waitForProxy,
    info: line => console.log(line),
  };
}
