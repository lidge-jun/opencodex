/**
 * Process and workspace lifetime for one `agy acp` turn.
 *
 * Each turn gets a fresh directory outside the OpenCodex home. It has mode 0700 on POSIX and a
 * private NTFS ACL on Windows, with its own temp directory. The CLI's request-review permission
 * engine scopes file access to this workspace, which serves as both the spawn and session cwd.
 * POSIX signals the child's group and waits for leader exit and group disappearance. Windows
 * requires a successful System32 taskkill /T /F while the leader is alive and leader closure.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { forgetEphemeralSecretDir, hardenSecretDirAsync, windowsSecretAclApplies } from "../../lib/windows-secret-acl";

export interface TurnWorkspace { dir: string; tmp: string; remove(): Promise<void> }

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A fresh private workspace outside `home`; throws when the temp root resolves inside it. */
export async function createTurnWorkspace(home: string, tempRoot = tmpdir()): Promise<TurnWorkspace> {
  const root = await realpath(tempRoot);
  let homeReal = home;
  try { homeReal = await realpath(home); } catch { /* a missing home cannot contain the workspace */ }
  if (isInside(root, homeReal)) throw new Error("agy acp workspace would be inside the OpenCodex home");
  const created = await mkdtemp(join(root, "ocx-agy-acp-"));
  let aclDir: string | undefined;
  const remove = async (): Promise<void> => {
    try { await rm(created, { recursive: true, force: true, maxRetries: 2 }); } catch { return; }
    if (aclDir) forgetEphemeralSecretDir(aclDir);
  };
  try {
    const dir = await realpath(created);
    if (isInside(dir, homeReal)) throw new Error("agy acp workspace would be inside the OpenCodex home");
    if (windowsSecretAclApplies()) {
      aclDir = dir;
      const acl = await hardenSecretDirAsync(dir, { required: true });
      if (!acl.ok) throw new Error("agy acp could not harden the workspace ACL");
    } else {
      await chmod(dir, 0o700);
    }
    const tmp = join(dir, ".tmp");
    await mkdir(tmp, { mode: 0o700 });
    return { dir, tmp, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

export type AgyAcpChild = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "pid" | "exitCode" | "signalCode" | "kill" | "on" | "once">;
export type AgyAcpSpawn = (binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) => AgyAcpChild;

export const defaultAgyAcpSpawn: AgyAcpSpawn = (binary, args, options) => spawn(binary, args, {
  ...options,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  shell: false,
  detached: process.platform !== "win32",
}) as ChildProcessWithoutNullStreams;

export interface ReapOptions {
  graceMs: number;
  reapTimeoutMs: number;
  platform?: NodeJS.Platform;
  signalGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
  killWindowsTree?: (pid: number, completed: (ok: boolean) => void) => void;
  warnTreeFailure?: () => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

function defaultKillWindowsTree(pid: number, completed: (ok: boolean) => void): void {
  const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, error => completed(!error));
}

const GROUP_POLL_MS = 25;

export class AgyAcpTreeCleanupError extends Error {
  constructor(platform = process.platform) {
    super(platform === "win32"
      ? "Antigravity ACP could not confirm Windows process tree cleanup."
      : "Antigravity ACP could not confirm POSIX process tree cleanup.");
  }
}

/** Reject unless the owned process tree is confirmed gone within the deadline. */
export function reapProcessTree(child: AgyAcpChild, options: ReapOptions): Promise<void> {
  const set = options.setTimeout ?? setTimeout;
  const clear = options.clearTimeout ?? clearTimeout;
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  const signalGroup = options.signalGroup ?? ((target: number, signal: NodeJS.Signals | 0) => process.kill(-target, signal));
  const signalLeader = (sig: NodeJS.Signals): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(sig); } catch { /* best effort only */ }
  };
  const unconfirmed = (): AgyAcpTreeCleanupError => {
    const error = new AgyAcpTreeCleanupError(platform);
    if (options.warnTreeFailure) options.warnTreeFailure();
    else console.warn(error.message);
    return error;
  };
  const leaderGone = child.exitCode !== null || child.signalCode !== null;
  if (pid === undefined) return Promise.reject(unconfirmed());

  if (platform === "win32") {
    if (leaderGone) return Promise.reject(unconfirmed());
    return new Promise<void>((resolve, reject) => {
      let treeKilled = false;
      let leaderClosed = false;
      let settled = false;
      const finish = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        clear(deadline);
        if (confirmed) {
          resolve();
          return;
        }
        const error = unconfirmed();
        if (!leaderClosed) signalLeader("SIGKILL");
        reject(error);
      };
      const deadline = set(() => finish(false), options.reapTimeoutMs);
      child.once("close", () => {
        leaderClosed = true;
        if (treeKilled) finish(true);
      });
      try {
        (options.killWindowsTree ?? defaultKillWindowsTree)(pid, ok => {
          if (!ok) return finish(false);
          treeKilled = true;
          if (leaderClosed) finish(true);
        });
      } catch {
        finish(false);
      }
    });
  }

  const noSuchGroup = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
  return new Promise<void>((resolve, reject) => {
    let leaderExited = leaderGone;
    let groupSignalled = false;
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      clear(grace);
      clear(deadline);
      if (pollTimer !== undefined) clear(pollTimer);
      if (confirmed) {
        resolve();
      } else {
        if (!leaderExited) signalLeader("SIGKILL");
        reject(unconfirmed());
      }
    };

    const pollGroup = (): void => {
      try { signalGroup(pid, 0); } catch (error) { return finish(noSuchGroup(error)); }
      pollTimer = set(pollGroup, GROUP_POLL_MS);
    };
    const killGroup = (): void => {
      if (settled) return;
      if (!groupSignalled) {
        try { signalGroup(pid, "SIGKILL"); } catch (error) {
          if (!noSuchGroup(error)) return finish(false);
        }
        groupSignalled = true;
      }
      if (leaderExited) pollGroup();
    };
    const onExit = (): void => {
      if (leaderExited) return;
      leaderExited = true;
      clear(grace);
      killGroup();
    };

    const grace = set(killGroup, options.graceMs);
    const deadline = set(() => finish(false), options.reapTimeoutMs);
    if (leaderExited) {
      clear(grace);
      killGroup();
    } else {
      child.once("exit", onExit);
      child.once("close", onExit);
      try { signalGroup(pid, "SIGTERM"); } catch { signalLeader("SIGTERM"); }
    }
  });
}
