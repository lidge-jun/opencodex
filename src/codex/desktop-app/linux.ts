/**
 * Linux adapter for the Codex desktop-app restart.
 *
 * Measured shape (devlog/_plan/260913_cross_platform_desktop_app_restart/001_platform_topology.md):
 *
 *   /usr/bin/chatgpt -> /usr/lib/chatgpt/codex-launcher  (2-line sh script)
 *   that execs /usr/lib/chatgpt/ChatGPT
 *
 *   3284901  /usr/lib/chatgpt/ChatGPT                         (root: no --type=)
 *   3284913  /usr/lib/chatgpt/ChatGPT --type=zygote
 *   3284951  /usr/lib/chatgpt/ChatGPT --type=gpu-process
 *   3284953  /usr/lib/chatgpt/ChatGPT --type=utility ...
 *
 * The root's /proc/<pid>/environ is 1902 bytes of NUL: Chromium scrubs it after
 * startup. Session variables survive only in children that inherited them before
 * the scrub. Measured on lidge: DISPLAY=:1, XDG_SESSION_TYPE=x11,
 * XDG_RUNTIME_DIR=/run/user/1000,
 * DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus.
 */
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  isUnderRoot,
  type DesktopAppAdapter,
  type DesktopAppInstall,
  type DesktopExec,
  type DesktopProcess,
} from "./types";

const INSTALL_ID = "chatgpt";
const SHELL_NAME = "ChatGPT";
/** Absolute candidates only. A chatgpt earlier on PATH must not redirect a kill or a launch. */
const LAUNCHER_CANDIDATES = ["/usr/bin/chatgpt", "/usr/local/bin/chatgpt"] as const;
const SETSID = "/usr/bin/setsid";
const PROC_ROOT = "/proc";
const MAX_ANCESTRY_HOPS = 16;
/** Group-write 0o020 | world-write 0o002. Sticky/setgid bits are not a trust failure. */
const GROUP_OR_WORLD_WRITE = 0o022;

/**
 * Copied into the relaunch environment and nothing else.
 *
 * /proc/<pid>/environ is another process's full environment and routinely carries
 * API keys and session tokens. Copying it wholesale would move credentials between
 * security contexts for no benefit.
 */
const SESSION_ENV_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

const MINIMAL_ENV_KEYS = ["HOME", "USER", "LOGNAME", "LANG"] as const;
const RELAUNCH_PATH = "/usr/local/bin:/usr/bin:/bin";

function procPath(pid: number, leaf: string): string {
  return PROC_ROOT + "/" + String(pid) + "/" + leaf;
}

function readProcExe(pid: number): string {
  const link = readlinkSync(procPath(pid, "exe"));
  return typeof link === "string" ? link : Buffer.from(link).toString("utf8");
}

function currentUid(): number | undefined {
  try {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Root and shell must be uid 0 and not group/world writable.
 *
 * dirname(realpath(launcher)) alone is not enough: /usr/local/bin is group-writable
 * on some systems, so a planted chatgpt -> ~/x/codex-launcher beside a ~/x/ChatGPT
 * would make an attacker-chosen directory the membership boundary and the relaunch
 * target. A failed check is a discovery failure, never a fallback to the next
 * candidate -- otherwise the planted /usr/local/bin/chatgpt becomes the target.
 *
 * stat (follow) rather than lstat: a root-owned symlink to a user-writable directory
 * must fail on the target's mode, not pass on the symlink's.
 */
function isTrustedSystemPath(path: string): boolean {
  try {
    const st = statSync(path);
    return st.uid === 0 && (st.mode & GROUP_OR_WORLD_WRITE) === 0;
  } catch {
    return false;
  }
}

function discoverFromCandidate(candidate: string): DesktopAppInstall | null | "absent" {
  let resolvedLauncher: string;
  try {
    resolvedLauncher = realpathSync(candidate);
  } catch {
    return "absent";
  }
  const root = dirname(resolvedLauncher);
  const shell = join(root, SHELL_NAME);
  if (!isTrustedSystemPath(root) || !isTrustedSystemPath(shell)) return null;
  return { id: INSTALL_ID, root, relaunch: candidate };
}

function parsePpidAndRealUid(status: string): { parentPid: number; uid: number } | null {
  const ppidMatch = /^PPid:\s+(\d+)/m.exec(status);
  const uidMatch = /^Uid:\s+(\d+)/m.exec(status);
  if (!ppidMatch || !uidMatch) return null;
  const parentPid = Number(ppidMatch[1]);
  const uid = Number(uidMatch[1]);
  if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(uid)) return null;
  return { parentPid, uid };
}

/**
 * Field 22 (starttime) as an opaque token. Located after the LAST ')' because comm
 * can contain spaces and parentheses -- this app's helpers are literally named
 * "Codex (Service)".
 */
function parseStarttimeToken(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(/\s+/);
  const starttime = fields[19];
  return starttime ? starttime : null;
}

function cmdlineHasElectronType(pid: number): boolean | "unreadable" {
  try {
    const args = readFileSync(procPath(pid, "cmdline")).toString("utf8").split("\0");
    return args.some(arg => arg.startsWith("--type="));
  } catch {
    return "unreadable";
  }
}

function parseEnviron(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of buf.toString("utf8").split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function sessionEnvFrom(source: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SESSION_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

function byStarttimeAscending(a: DesktopProcess, b: DesktopProcess): number {
  // starttime is a jiffies integer stored in a string. A lexical sort misorders
  // it ("100" < "99"), so the oldest child -- the one most likely to still hold
  // the pre-scrub session -- would not be tried first.
  return Number(a.createdAt) - Number(b.createdAt);
}

function minimalRelaunchEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: RELAUNCH_PATH };
  for (const key of MINIMAL_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

let killProcess: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => {
  process.kill(pid, signal);
};

/** Test-only seam, so a kill can be observed without ending a developer's own Codex. */
export function setLinuxKillForTests(
  next: ((pid: number, signal: NodeJS.Signals) => void) | null,
): void {
  killProcess = next ?? ((pid, signal) => { process.kill(pid, signal); });
}

type LinuxSpawn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore"; env: NodeJS.ProcessEnv },
) => { pid?: number | undefined; unref(): void };

const defaultSpawn: LinuxSpawn = (command, args, options) => {
  const child = spawn(command, [...args], {
    detached: options.detached,
    stdio: options.stdio,
    env: options.env,
    shell: false,
  });
  // Headless ENOENT arrives as an async 'error'; without a listener it is an
  // uncaught exception that kills the caller after relaunch has already returned.
  child.on("error", () => {});
  return child;
};

let spawnProcess: LinuxSpawn = defaultSpawn;

/** Test-only seam, so relaunch can be observed without starting ChatGPT. */
export function setLinuxSpawnForTests(next: LinuxSpawn | null): void {
  spawnProcess = next ?? defaultSpawn;
}

export const linuxDesktopAppAdapter: DesktopAppAdapter = {
  discover(_exec): DesktopAppInstall | null {
    for (const candidate of LAUNCHER_CANDIDATES) {
      const found = discoverFromCandidate(candidate);
      if (found === "absent") continue;
      return found;
    }
    return null;
  },

  listProcesses(_exec, install): DesktopProcess[] | null {
    // A missing or unreadable /proc is an enumeration failure, not absence. Collapsing
    // those told users the app was not running and skipped a restart they asked for.
    if (!existsSync(PROC_ROOT)) return null;
    let names: string[];
    try {
      names = readdirSync(PROC_ROOT);
    } catch {
      return null;
    }
    const uid = currentUid();
    if (uid === undefined) return null;

    const out: DesktopProcess[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (!Number.isSafeInteger(pid)) continue;
      try {
        const executable = readProcExe(pid);
        if (!isUnderRoot(executable, install.root)) continue;
        const identity = parsePpidAndRealUid(readFileSync(procPath(pid, "status"), "utf8"));
        if (!identity || identity.uid !== uid) continue;
        const createdAt = parseStarttimeToken(readFileSync(procPath(pid, "stat"), "utf8"));
        if (!createdAt) continue;
        out.push({
          pid,
          parentPid: identity.parentPid,
          createdAt,
          executable,
        });
      } catch {
        // Per-pid EACCES/ENOENT (and a pid that vanished mid-scan) skip that pid.
        // They are not an enumeration failure.
        continue;
      }
    }
    return out;
  },

  isShell(entry, install): boolean {
    if (entry.executable !== join(install.root, SHELL_NAME)) return false;
    // Unreadable cmdline cannot prove this is the shell, so it is not a root.
    return cmdlineHasElectronType(entry.pid) === false;
  },

  ancestryPids(_exec): number[] {
    const chain: number[] = [process.pid];
    let current = process.pid;
    for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
      let status: string;
      try {
        status = readFileSync(procPath(current, "status"), "utf8");
      } catch (error) {
        // Two different situations arrive here and they must not be merged.
        //
        // ENOENT means the pid is simply gone. That is a CLEAN end of chain and the
        // normal state above an orphaned handoff helper, so the chain collected so far
        // is returned and the caller can still be judged outside the tree.
        //
        // Any OTHER error means we could not look, and "could not look" must never be
        // read as "we are outside the tree": that reading lets the ladder signal the
        // shell hosting the caller's own session. Hop 0 is this process itself, which
        // always exists, so a failure there is always a read failure.
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (hop > 0 && code === "ENOENT") return chain;
        return [];
      }
      const parsed = parsePpidAndRealUid(status);
      if (!parsed || parsed.parentPid <= 0) return chain;
      const parent = parsed.parentPid;
      if (chain.includes(parent)) return chain;
      chain.push(parent);
      if (parent === 1) return chain;
      current = parent;
    }
    // Bound reached without finding the top. A truncated chain silently defeats
    // the self-ancestry intersection, so this reports "could not establish".
    return [];
  },

  requestQuit(_exec, _install, root): void {
    // Honest ceiling: /proc/<root>/status on lidge had SIGTERM in neither SigCgt
    // nor SigIgn, so the Linux shell has the default SIGTERM disposition.
    // SIGTERM here is termination, not a graceful shutdown request. The app
    // registers no DBus quit method and has no systemd unit.
    killProcess(root.pid, "SIGTERM");
  },

  forceStop(_exec, root): void {
    killProcess(root.pid, "SIGKILL");
  },

  captureRelaunchContext(_exec, _install, processes): Record<string, string> {
    const ordered = processes.slice().sort(byStarttimeAscending);
    for (const entry of ordered) {
      let buf: Buffer;
      try {
        buf = readFileSync(procPath(entry.pid, "environ"));
      } catch {
        continue;
      }
      const environ = parseEnviron(buf);
      // The root is typically oldest and all-NUL after Chromium's scrub. Keep
      // walking until a child that inherited the session before the scrub.
      if (!environ.XDG_RUNTIME_DIR) continue;
      return sessionEnvFrom(environ);
    }
    return {};
  },

  relaunch(_exec, install, context): void {
    if (!context.XDG_RUNTIME_DIR) {
      // An app started without a session cannot reach the compositor, but
      // Electron still takes the single-instance lock, so the user's real
      // session then cannot start either.
      throw new Error(
        "missing graphical session: XDG_RUNTIME_DIR was not recovered from the live process tree",
      );
    }
    const env = { ...minimalRelaunchEnv(), ...sessionEnvFrom(context) };
    // The launcher is a sh script and Electron resolves its user-data directory
    // from HOME. Starting it with only the five session variables would produce
    // an app that launches and then behaves as a different user profile.
    const child = spawnProcess(SETSID, [install.relaunch], {
      detached: true,
      stdio: "ignore",
      env,
    });
    // A detached child reports a failed launch asynchronously, and this process is
    // about to stop caring about it, so the 'error' event has nobody to reach. An
    // absent pid is the synchronous signal that the spawn never happened - without
    // this check a missing /usr/bin/setsid still reported relaunch: "started".
    if (child.pid === undefined) {
      throw new Error("failed to spawn " + SETSID + " for the Codex desktop app relaunch");
    }
    // detached already calls setsid(2); the setsid binary then auto-forks because
    // it finds itself a group leader. The overlap is deliberate belt-and-braces
    // against a runtime that changes detached semantics. No --fork is needed.
    child.unref();
  },
};

/**
 * Linux needs no subprocess for discovery or enumeration - everything comes from
 * /proc and the filesystem - so this exists only to satisfy the shared contract and
 * to keep the ladder's adapter selection uniform. It is deliberately execFileSync
 * with a bounded timeout rather than a throwing stub, so a future adapter method that
 * does need a subprocess gets the same trusted-path, bounded-probe treatment as the
 * other two platforms instead of inventing its own.
 */
export const linuxDefaultExec: DesktopExec = (file, args, options) => execFileSync(file, [...args], {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: options?.timeout ?? 10_000,
});

