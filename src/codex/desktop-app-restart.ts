/**
 * Full restart of the Codex desktop app (the Electron shell), Windows only.
 *
 * `--restart-codex` deliberately signals only `codex app-server` /
 * `codex-code-mode-host` processes: `isCodexAppServerCommandLine` requires a
 * `codex` executable token, so the shell that owns the model picker is never a
 * match. On macOS that is enough, because the respawned app-server re-emits
 * `codex-app-server-initialized` and the renderer drops its cached
 * `model/list`. On Windows MSIX it is not: externally terminating the child
 * does not reliably re-emit that event in the surviving shell, so the picker
 * keeps showing the old catalog until the app itself is restarted (#2292).
 *
 * This is therefore a SEPARATE opt-in flag rather than a widening of
 * `--restart-codex`. Quitting the desktop app ends live conversations, which is
 * a different consent from restarting a background helper, and the CLI contract
 * for `--restart-codex` promises the narrow behavior.
 *
 * Everything here fails CLOSED: if the package cannot be identified, if a
 * target is part of our own ancestry, or if any target survives termination,
 * nothing is relaunched and the caller is told to restart manually. A stale
 * picker is a much smaller problem than a wrongly killed process.
 */
import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsTaskkillExe } from "../lib/windows-elevation";
import { execFileSync } from "node:child_process";

/** Bounded subprocess options. A hung Appx/CIM probe must never wedge `ocx sync`. */
export interface DesktopAppExecOptions {
  timeout?: number;
  windowsHide?: boolean;
}

export interface DesktopAppRestartIo {
  platform?: NodeJS.Platform;
  /** Returns stdout. Options are part of the seam so the timeout is testable. */
  execFile?: (file: string, args: readonly string[], options?: DesktopAppExecOptions) => string;
  /** Process ancestry of the current process, innermost first. Used for the self-kill guard. */
  ancestryPids?: () => number[];
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => void;
  now?: () => number;
}

export type DesktopAppRestartReason =
  | "windows_only"
  | "package_discovery_failed"
  | "no_targets"
  | "self_ancestry"
  | "targets_survived";

export interface DesktopAppRestartResult {
  attempted: boolean;
  stopped: number[];
  surviving: number[];
  relaunch: "started" | "skipped";
  reason?: DesktopAppRestartReason;
}

/** How long a graceful close is given before the forced pass. */
const GRACEFUL_EXIT_TIMEOUT_MS = 15_000;
/** How long a forced kill is given before the target counts as surviving. */
const FORCED_EXIT_TIMEOUT_MS = 5_000;
/** Every probe is bounded; PowerShell module loading is the slow part. */
const PROBE_TIMEOUT_MS = 10_000;

interface DesktopPackage {
  family: string;
  installLocation: string;
  aumid: string;
}

/**
 * Runtime discovery, never a hardcoded identifier. The beta MSIX package family
 * changes between builds, so a literal AUMID would silently stop matching and
 * then either do nothing or — worse — match a package we did not mean.
 */
function discoverPackage(exec: NonNullable<DesktopAppRestartIo["execFile"]>): DesktopPackage | null {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Import-Module Appx -ErrorAction SilentlyContinue",
    "$p = Get-AppxPackage -Name OpenAI.Codex",
    "if (-not $p) { $p = Get-AppxPackage -Name OpenAI.CodexBeta }",
    "if (-not $p -or -not $p.InstallLocation) { 'MISS' } else {",
    "  $p.PackageFamilyName; $p.InstallLocation; \"$($p.PackageFamilyName)!App\"",
    "}",
  ].join("; ");
  let stdout: string;
  try {
    stdout = exec(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length < 3 || lines[0] === "MISS") return null;
  const [family, installLocation, aumid] = lines;
  if (!family || !installLocation || !aumid) return null;
  return { family, installLocation, aumid };
}

interface DesktopProcess {
  pid: number;
  parentPid: number;
  /** Win32_Process CreationDate. Guards against PID reuse across the wait window. */
  createdAt: string;
}

/**
 * Only `ChatGPT.exe` processes whose image lives under the discovered install
 * location AND owned by the current user. The install location alone is not
 * enough: an MSIX package under `WindowsApps` is shared, so on a multi-user
 * machine another account's Codex desktop matches the same path. The app-server
 * collector already pays for `GetOwner` for exactly this reason.
 *
 * `CreationDate` is captured so a PID can be re-verified before it is signalled;
 * a graceful-close window is long enough for Windows to recycle a PID.
 */
function listPackageProcesses(
  exec: NonNullable<DesktopAppRestartIo["execFile"]>,
  installLocation: string,
): DesktopProcess[] {
  const literal = installLocation.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$root = '${literal}'`,
    "$me = ([Security.Principal.WindowsIdentity]::GetCurrent()).Name",
    "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" |",
    "  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'OrdinalIgnoreCase') } |",
    "  ForEach-Object {",
    "    $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner",
    "    if ($o -and $o.ReturnValue -eq 0 -and $o.User) {",
    "      $owner = if ($o.Domain) { \"$($o.Domain)\\$($o.User)\" } else { $o.User }",
    "      if ($owner -ieq $me) {",
    "        \"$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToString('o'))\"",
    "      }",
    "    }",
    "  }",
  ].join(" ");
  let stdout: string;
  try {
    stdout = exec(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return [];
  }
  const processes: DesktopProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const createdAt = match[3]!;
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid)) {
      processes.push({ pid, parentPid, createdAt });
    }
  }
  return processes;
}

/**
 * True when the PID still names the same process we verified. Between listing
 * and signalling there is a graceful-close window, and a `taskkill /T /F` on a
 * recycled PID would tear down an unrelated process tree.
 */
function stillSameProcess(
  exec: NonNullable<DesktopAppRestartIo["execFile"]>,
  installLocation: string,
  target: DesktopProcess,
): boolean {
  const current = listPackageProcesses(exec, installLocation)
    .find(p => p.pid === target.pid);
  return current !== undefined && current.createdAt === target.createdAt;
}

/** Roots are the package processes whose parent is not itself in the package tree. */
function rootProcesses(processes: readonly DesktopProcess[]): DesktopProcess[] {
  const inTree = new Set(processes.map(p => p.pid));
  return processes.filter(p => !inTree.has(p.parentPid));
}

/**
 * Full Windows parent chain for this process, innermost first.
 *
 * `process.ppid` is one level, which is not enough: a terminal hosted inside the
 * desktop app sits several hops below `ChatGPT.exe`, so a one-level check would
 * miss the exact case the guard exists for and we would terminate our own host.
 * The chain therefore comes from CIM, with a bound so a corrupted parent cycle
 * cannot spin.
 */
function windowsAncestryPids(exec: NonNullable<DesktopAppRestartIo["execFile"]>): number[] {
  const chain: number[] = [process.pid];
  let current = process.pid;
  for (let hop = 0; hop < 16; hop++) {
    let stdout: string;
    try {
      stdout = exec(resolveTrustedWindowsPowerShellExe(), [
        "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='SilentlyContinue'; (Get-CimInstance Win32_Process -Filter "ProcessId=${current}").ParentProcessId`,
      ], { timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    } catch {
      // An unreadable chain must not be read as "not our ancestor".
      return [];
    }
    const parent = Number(stdout.trim());
    if (!Number.isSafeInteger(parent) || parent <= 0 || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

function defaultExecFile(file: string, args: readonly string[], options?: DesktopAppExecOptions): string {
  return execFileSync(file, [...args], {
    encoding: "utf-8",
    timeout: options?.timeout ?? PROBE_TIMEOUT_MS,
    windowsHide: options?.windowsHide ?? true,
  });
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForExit(
  pid: number,
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => void,
  now: () => number,
): boolean {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isAlive(pid)) return true;
    sleep(250);
  }
  return !isAlive(pid);
}

/**
 * Stop every package-tree root gracefully, force the stragglers, then relaunch
 * through the discovered AUMID. Returns without relaunching if anything
 * survived, because launching a second shell beside a stuck one is worse than
 * leaving the user to restart it.
 */
export function restartCodexDesktopApp(io: DesktopAppRestartIo = {}): DesktopAppRestartResult {
  const platform = io.platform ?? process.platform;
  const skipped = (reason: DesktopAppRestartReason): DesktopAppRestartResult => ({
    attempted: false, stopped: [], surviving: [], relaunch: "skipped", reason,
  });
  if (platform !== "win32") return skipped("windows_only");

  const exec = io.execFile ?? defaultExecFile;
  const pkg = discoverPackage(exec);
  if (!pkg) return skipped("package_discovery_failed");

  const processes = listPackageProcesses(exec, pkg.installLocation);
  const roots = rootProcesses(processes);
  if (roots.length === 0) return skipped("no_targets");

  const ancestryPids = io.ancestryPids ? io.ancestryPids() : windowsAncestryPids(exec);
  if (ancestryPids.length === 0) {
    // Fail closed: an unreadable ancestry chain cannot prove we are outside the
    // tree we are about to terminate.
    return skipped("self_ancestry");
  }
  const ancestry = new Set(ancestryPids);
  if (processes.some(p => ancestry.has(p.pid))) {
    // Terminating our own tree would kill this command mid-flight and leave the
    // user with neither a restarted app nor an explanation.
    return skipped("self_ancestry");
  }

  const isAlive = io.isAlive ?? defaultIsAlive;
  const sleep = io.sleep ?? defaultSleep;
  const now = io.now ?? (() => Date.now());
  const stopped: number[] = [];
  const surviving: number[] = [];

  for (const root of roots) {
    const pid = root.pid;
    // Re-verify immediately before the graceful close: the listing is already
    // one probe old.
    if (!stillSameProcess(exec, pkg.installLocation, root)) {
      stopped.push(pid);
      continue;
    }
    try {
      exec(resolveTrustedWindowsPowerShellExe(), [
        "-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`,
      ], { timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    } catch {
      /* a refused graceful close still gets the forced pass below */
    }
    if (waitForExit(pid, GRACEFUL_EXIT_TIMEOUT_MS, isAlive, sleep, now)) {
      stopped.push(pid);
      continue;
    }
    // The wait window is long enough for Windows to recycle a PID, and the next
    // step is `/T /F` against a whole tree. Confirm the PID is still the process
    // we verified, or leave it alone.
    if (!stillSameProcess(exec, pkg.installLocation, root)) {
      stopped.push(pid);
      continue;
    }
    try {
      exec(resolveTrustedWindowsTaskkillExe(), ["/PID", String(pid), "/T", "/F"], {
        timeout: PROBE_TIMEOUT_MS, windowsHide: true,
      });
    } catch {
      /* fall through to the liveness check: the process state decides, not the exit code */
    }
    if (waitForExit(pid, FORCED_EXIT_TIMEOUT_MS, isAlive, sleep, now)) stopped.push(pid);
    else surviving.push(pid);
  }

  if (surviving.length > 0) {
    return { attempted: true, stopped, surviving, relaunch: "skipped", reason: "targets_survived" };
  }

  try {
    exec(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile", "-NonInteractive", "-Command",
      `Start-Process 'shell:AppsFolder\\${pkg.aumid}'`,
    ], { timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  } catch {
    return { attempted: true, stopped, surviving, relaunch: "skipped", reason: "targets_survived" };
  }
  return { attempted: true, stopped, surviving, relaunch: "started" };
}
