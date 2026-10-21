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
 * - A durable Desktop claim with no running app: start Desktop (hidden, by the path its own
 *   login registration recorded — LaunchServices never picks the bundle) where that is
 *   verifiable, then wait. Elsewhere, fail with guidance. A missing Desktop process
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
import { accessSync, constants, existsSync, linkSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
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
  /** Linux: whether procfs hides processes (hidepid=2/4). */
  procfsHidesProcesses?: () => boolean;
  /** Linux: whether this machine shows evidence of an OpenCodex Desktop install. */
  desktopInstalled?: () => boolean;
}

/**
 * Linux: hidepid=2 (invisible) or 4 (ptraceable) can hide a same-uid process whose credentials
 * differ from the caller's (for example after newgrp), so an empty scan proves nothing there.
 * An unreadable mount table is treated as filtering.
 */
export function procfsHidesProcesses(mountinfo = "/proc/self/mountinfo"): boolean {
  let text: string;
  try { text = readFileSync(mountinfo, "utf8"); } catch { return true; }
  return text.split("\n").some(line => {
    const [mount, fs] = line.split(" - ");
    if (mount?.split(" ")[4] !== "/proc" || !fs) return false;
    const [type, , options = ""] = fs.split(" ");
    return type === "proc" && options.split(",").some(option => /^hidepid=(2|4|invisible|ptraceable)$/.test(option));
  });
}

function linuxDesktopInstalled(): boolean {
  return existsSync(join(homedir(), ".opencodex-desktop")) || existsSync("/usr/bin/opencodex-desktop");
}

/** Linux truncates comm to 15 bytes. */
const LINUX_DESKTOP_COMM = "opencodex-desktop".slice(0, 15);

/**
 * Linux: executables of this user's processes. A process that exited mid-scan or belongs to someone
 * else is skipped. A non-dumpable process (ssh-agent, gpg-agent) hides its executable but not its
 * comm, so it is ruled out by name; one whose comm could be Desktop makes the answer unverifiable.
 * The scan must also see this process, or procfs is filtered and absence proves nothing.
 */
export function scanLinuxExecutables(uid: number, selfPid: number = process.pid, proc = "/proc"): string[] | "unverified" {
  const paths: string[] = [];
  let sawSelf = false;
  const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    if (Number(entry) === selfPid) sawSelf = true;
    try {
      if (statSync(`${proc}/${entry}`).uid !== uid) continue;
      paths.push(readlinkSync(`${proc}/${entry}/exe`).replace(/ \(deleted\)$/, ""));
    } catch (error) {
      if (code(error) === "ENOENT" || code(error) === "ESRCH") continue;
      try {
        if (readFileSync(`${proc}/${entry}/comm`, "utf8").trim() !== LINUX_DESKTOP_COMM) continue;
      } catch (commError) {
        if (code(commError) === "ENOENT" || code(commError) === "ESRCH") continue;
      }
      return "unverified";
    }
  }
  return sawSelf ? paths : "unverified";
}

/** Whether this user runs an OpenCodex Desktop app, judged by executable identity, never arguments. */
export function inspectDesktopProcess(options: DesktopProcessOptions = {}): DesktopProcessState {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? execute;
  try {
    const uid = options.uid ?? process.getuid?.();
    if (platform === "linux") {
      if (uid === undefined) return "unknown";
      const executables = (options.linuxExecutables ?? scanLinuxExecutables)(uid);
      if (executables === "unverified") return "unknown";
      if (executables.some(path => isDesktopExecutable(path, platform))) return "running";
      // A filtered procfs cannot prove absence where Desktop may be installed. Without an install
      // there is nothing to hide, so hardened hosts keep the plain CLI cold start.
      return (options.procfsHidesProcesses ?? procfsHidesProcesses)() && (options.desktopInstalled ?? linuxDesktopInstalled)()
        ? "unknown" : "absent";
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

const DESKTOP_BUNDLE_ID = "com.opencodex.desktop";
const DESKTOP_PLIST_LABEL = "OpenCodex";

/**
 * The app bundle the consented installation itself registered as its Start-at-Login program —
 * not whichever bundle LaunchServices would resolve for our identifier. `open -b` answers a
 * mutable per-user registry: any planted bundle claiming {@link DESKTOP_BUNDLE_ID} could be
 * selected and executed in the real app's place. The recorded claim, this app's own install-id
 * store, and the login registration it wrote are the durable evidence of which installation
 * that is; a claim whose registration is absent, malformed, stale or points off a Desktop
 * executable refuses the launch instead of guessing.
 */
function consentedDesktopBundle(home: string, installId: string, run: Execute): string | null {
  const localId = readFileSync(
    join(home, "Library", "Application Support", DESKTOP_BUNDLE_ID, "install-id"), "utf8",
  ).trim();
  if (!localId || localId !== installId) return null;
  const plistPath = realpathSync(join(home, "Library", "LaunchAgents", `${DESKTOP_PLIST_LABEL}.plist`));
  const registration = JSON.parse(
    run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], 3_000),
  ) as { Label?: unknown; RunAtLoad?: unknown; ProgramArguments?: unknown; Program?: unknown };
  const args = registration.ProgramArguments;
  // The shapes auto-launch writes: [program] or [program, "--autostart"]; see the migration
  // rules in desktop/src-tauri/src/login_registration.rs, which classify anything else Leave.
  // This is a macOS plist path, regardless of the host running an injected launch probe.
  if (registration.Label !== DESKTOP_PLIST_LABEL || registration.RunAtLoad !== true || !Array.isArray(args)
    || (args.length !== 1 && args.length !== 2) || typeof args[0] !== "string" || !posix.isAbsolute(args[0])
    || (args.length === 2 && args[1] !== "--autostart")
    || (registration.Program !== undefined && registration.Program !== args[0])) return null;
  const executable = realpathSync(args[0]);
  if (!isDesktopExecutable(executable, "darwin") || !statSync(executable).isFile()) return null;
  accessSync(executable, constants.X_OK);
  const bundle = dirname(dirname(dirname(executable)));
  if (!bundle.endsWith(".app")) return null;
  const info = JSON.parse(
    run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(bundle, "Contents", "Info.plist")], 3_000),
  ) as { CFBundleIdentifier?: unknown; CFBundleExecutable?: unknown };
  // `open` uses this selector, so checking only the registration and identifier would
  // validate one binary while launching another. The registered path is already canonical.
  if (info.CFBundleIdentifier !== DESKTOP_BUNDLE_ID || info.CFBundleExecutable !== "opencodex-desktop") return null;
  return realpathSync(join(bundle, "Contents", "MacOS", info.CFBundleExecutable)) === executable ? bundle : null;
}

/** Start the consented macOS app hidden, by the path its own login registration recorded. */
export function launchDesktopApp(options: {
  platform?: NodeJS.Platform;
  run?: Execute;
  home?: string;
  ownership?: () => ReturnType<typeof resolveServiceOwnership>;
} = {}): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  try {
    const owner = (options.ownership ?? resolveServiceOwnership)();
    if (owner.kind !== "owned" || owner.ownership.owner !== "desktop") return false;
    const bundle = consentedDesktopBundle(options.home ?? homedir(), owner.ownership.installId, options.run ?? execute);
    if (bundle === null) return false;
    (options.run ?? execute)("/usr/bin/open", ["-g", bundle, "--args", "--autostart"], 10_000);
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
    const withdraw = () => {
      try { if (readHolder(leasePath(next)) === pid) unlinkSync(leasePath(next)); } catch { /* already gone */ }
    };
    // A contender with a stale directory read can publish a generation a winner already cleaned
    // up. The highest generation is the one launcher; anyone below it stands down.
    try {
      if (readdirSync(configDir).some(name => Number(LEASE_FILE.exec(name)?.[1] ?? 0) > next)) {
        withdraw();
        return null;
      }
    } catch { /* keep the lease: the directory was readable a moment ago */ }
    // Older generations belong to dead holders: the newest was checked before publishing above it.
    for (const generation of generations) {
      try { unlinkSync(leasePath(generation)); } catch { /* already gone */ }
    }
    // The newest generation is never deleted on release: removing it would let numbering restart
    // below a stale contender. It stops counting once this process exits.
    return () => {};
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
