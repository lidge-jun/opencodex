/**
 * macOS adapter for the Codex desktop-app restart.
 *
 * Measured shape (devlog/_plan/260913_cross_platform_desktop_app_restart/001_platform_topology.md):
 *
 *   15901     1  /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
 *   16733 15901  /Applications/ChatGPT.app/Contents/Resources/codex ... app-server ...
 *   15903     1  .../Contents/Frameworks/Codex Framework.framework/.../browser_crashpad_handler
 *
 * The bundle is named ChatGPT.app but its identifier is com.openai.codex, and the
 * display name is shared with a different OpenAI product. Every identity decision
 * here therefore keys on the identifier, never on the name.
 */
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  isUnderRoot,
  type DesktopAppAdapter,
  type DesktopAppInstall,
  type DesktopExec,
  type DesktopProcess,
} from "./types";

const BUNDLE_ID = "com.openai.codex";
const CONVENTIONAL_BUNDLE = "/Applications/ChatGPT.app";
const SHELL_SUFFIX = "/Contents/MacOS/ChatGPT";

/** Absolute system locations only. PATH is never consulted for any of these. */
const PS = "/bin/ps";
const OSASCRIPT = "/usr/bin/osascript";
const OPEN = "/usr/bin/open";
const MDFIND = "/usr/bin/mdfind";
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

const PROBE_TIMEOUT_MS = 10_000;
const MAX_ANCESTRY_HOPS = 16;

function shellPath(bundle: string): string {
  return join(bundle, "Contents", "MacOS", "ChatGPT");
}

function readBundleIdentifier(exec: DesktopExec, bundle: string): string | null {
  try {
    return exec(PLIST_BUDDY, [
      "-c", "Print :CFBundleIdentifier",
      join(bundle, "Contents", "Info.plist"),
    ], { timeout: PROBE_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

function confirmBundle(exec: DesktopExec, candidate: string): DesktopAppInstall | null {
  if (!candidate) return null;
  let resolved: string;
  try {
    // Resolved ONCE here so membership is a pure comparison against a trusted value.
    // A prefix test against an unresolved path admits sibling directories such as
    // /Applications/ChatGPT.app-evil/..., which the same user can create.
    resolved = realpathSync(candidate);
  } catch {
    return null;
  }
  if (readBundleIdentifier(exec, resolved) !== BUNDLE_ID) return null;
  return { id: BUNDLE_ID, root: resolved, relaunch: BUNDLE_ID };
}

interface PsSnapshot {
  pid: number;
  parentPid: number;
  createdAt: string;
  uid: number;
  executable: string;
}

/**
 * Column order matters. lstart is five whitespace-separated tokens, and the executable
 * path itself contains spaces and parentheses on this app (Codex (Service).app), so
 * everything after the uid is taken as the remainder of the line rather than split.
 *
 * comm as the FINAL -o column yields the full, untruncated executable path; this was
 * checked against a 150+ character helper path rather than assumed. The 16-character
 * truncation people expect belongs to ucomm.
 */
function parsePsLine(line: string): PsSnapshot | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\d+)\s+(.+)$/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  const uid = Number(match[4]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(uid)) {
    return null;
  }
  return {
    pid,
    parentPid,
    createdAt: (match[3] ?? "").trim(),
    uid,
    executable: (match[5] ?? "").trim(),
  };
}

function readPsSnapshots(exec: DesktopExec): PsSnapshot[] | null {
  let stdout: string;
  try {
    stdout = exec(PS, ["-Ao", "pid=,ppid=,lstart=,uid=,comm="], { timeout: PROBE_TIMEOUT_MS });
  } catch {
    // A probe that could not RUN is not evidence of absence.
    return null;
  }
  const out: PsSnapshot[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parsePsLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Prefer the bundle the RUNNING shell executes out of.
 *
 * Membership is path-scoped while the quit and the relaunch are bundle-id-scoped. If
 * two bundles claim com.openai.codex, discovering by identifier alone could enumerate
 * one installation and quit the other. Starting from the live process makes the thing
 * we quit the same thing we counted.
 */
function discoverFromRunningShell(exec: DesktopExec): string | null {
  for (const snapshot of readPsSnapshots(exec) ?? []) {
    if (!snapshot.executable.endsWith(SHELL_SUFFIX)) continue;
    return snapshot.executable.slice(0, -SHELL_SUFFIX.length);
  }
  return null;
}

function currentUid(): number | undefined {
  try {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
  } catch {
    return undefined;
  }
}

let killProcess: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => {
  process.kill(pid, signal);
};

/** Test-only seam, so a kill can be observed without ending a developer's own Codex. */
export function setDarwinKillForTests(
  next: ((pid: number, signal: NodeJS.Signals) => void) | null,
): void {
  killProcess = next ?? ((pid, signal) => { process.kill(pid, signal); });
}

export const darwinDesktopAppAdapter: DesktopAppAdapter = {
  discover(exec): DesktopAppInstall | null {
    const running = discoverFromRunningShell(exec);
    if (running) {
      const confirmed = confirmBundle(exec, running);
      if (confirmed) return confirmed;
    }
    let spotlight = "";
    try {
      const query = "kMDItemCFBundleIdentifier == '" + BUNDLE_ID + "'";
      spotlight = exec(MDFIND, [query], { timeout: PROBE_TIMEOUT_MS })
        .split(/\r?\n/)
        .map(entry => entry.trim())
        .find(entry => entry.length > 0) ?? "";
    } catch {
      spotlight = "";
    }
    return confirmBundle(exec, spotlight) ?? confirmBundle(exec, CONVENTIONAL_BUNDLE);
  },

  listProcesses(exec, install): DesktopProcess[] | null {
    const snapshots = readPsSnapshots(exec);
    if (snapshots === null) return null;
    const uid = currentUid();
    // Without a uid there is no way to scope the result to this user, and reporting an
    // empty list would tell the caller the app is not running (#2557's failure mode in a
    // different disguise). This is a probe failure.
    if (uid === undefined) return null;
    const out: DesktopProcess[] = [];
    for (const snapshot of snapshots) {
      if (!isUnderRoot(snapshot.executable, install.root)) continue;
      // Same user only.
      if (snapshot.uid !== uid) continue;
      out.push({
        pid: snapshot.pid,
        parentPid: snapshot.parentPid,
        createdAt: snapshot.createdAt,
        executable: snapshot.executable,
      });
    }
    return out;
  },

  isShell(entry, install): boolean {
    return entry.executable === shellPath(install.root);
  },

  ancestryPids(exec): number[] {
    const chain: number[] = [process.pid];
    let current = process.pid;
    for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
      let stdout: string;
      try {
        stdout = exec(PS, ["-o", "ppid=", "-p", String(current)], { timeout: PROBE_TIMEOUT_MS });
      } catch (error) {
        // ps -p <pid> exits 1 with empty output when the pid does not exist, and
        // execFileSync turns a non-zero exit into a throw. Without this branch the
        // clean-end handling below is unreachable in production, every dead parent reads
        // as unreadable, and the orphaned handoff helper refuses the one job it exists
        // for. Hop 0 is this process, which always exists, so a failure there is real.
        const status = (error as { status?: unknown } | null)?.status;
        if (hop > 0 && status === 1) return chain;
        // Anything else: could not look, so we cannot conclude we are outside the tree.
        return [];
      }
      const trimmed = stdout.trim();
      // Empty output means the pid has no live parent entry: a CLEAN end of chain, not
      // a read failure. The detached handoff helper reaches exactly this state once its
      // caller exits, and reading it as unreadable would make the helper refuse the one
      // job it exists for.
      if (trimmed === "") return chain;
      const parent = Number(trimmed);
      if (!Number.isSafeInteger(parent) || parent <= 0) return chain;
      if (chain.includes(parent)) return chain;
      chain.push(parent);
      if (parent === 1) return chain;
      current = parent;
    }
    // Bound reached without finding the top. A truncated chain silently defeats the
    // self-ancestry intersection, so this reports "could not establish" instead.
    return [];
  },

  requestQuit(exec, install): void {
    // The Apple event, so the app runs its own termination path. Delivery is
    // synchronous; termination is not, which is why the ladder always waits and
    // re-verifies identity afterwards.
    exec(OSASCRIPT, ["-e", 'quit app id "' + install.id + '"'], { timeout: PROBE_TIMEOUT_MS });
  },

  forceStop(_exec, root): void {
    killProcess(root.pid, "SIGKILL");
  },

  captureRelaunchContext(): Record<string, string> {
    // LaunchServices supplies the session, so nothing needs carrying forward.
    return {};
  },

  relaunch(exec, install): void {
    // Deliberately without -g: the operator asked for a restart and expects the app in
    // front of them. An unknown bundle id exits non-zero with
    // LSCopyApplicationURLsForBundleIdentifier() failed, which the ladder turns into
    // relaunch_failed rather than a silent no-op. Not -n either: a second instance is
    // both unreliable to obtain and unwanted.
    exec(OPEN, ["-b", install.relaunch], { timeout: PROBE_TIMEOUT_MS });
  },
};

export const darwinDefaultExec: DesktopExec = (file, args, options) => execFileSync(file, [...args], {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: options?.timeout ?? PROBE_TIMEOUT_MS,
});
