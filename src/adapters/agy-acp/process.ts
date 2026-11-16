/**
 * Process and workspace lifetime for one `agy acp` turn.
 *
 * Each turn gets a fresh private directory outside the OpenCodex home (mode 0700, resolved through
 * symlinks), with its own temp directory, used as both the spawn cwd and the session cwd. This is the
 * workspace the CLI's request-review permission engine scopes file access to; it is not an OS sandbox.
 * The child runs in its own process group on POSIX and is reaped as a group: SIGTERM, then SIGKILL on
 * a timer that does not depend on the direct child closing, so a descendant that ignores TERM is
 * still killed. Windows uses the absolute System32 taskkill with /T /F while the leader is alive.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export interface TurnWorkspace { dir: string; tmp: string; remove(): Promise<void> }

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/** A fresh private workspace outside `home`; throws when the temp root resolves inside it. */
export async function createTurnWorkspace(home: string, tempRoot = tmpdir()): Promise<TurnWorkspace> {
  const root = await realpath(tempRoot);
  let homeReal = home;
  try { homeReal = await realpath(home); } catch { /* a missing home cannot contain the workspace */ }
  if (isInside(root, homeReal)) throw new Error("agy acp workspace would be inside the OpenCodex home");
  const dir = await realpath(await mkdtemp(join(root, "ocx-agy-acp-")));
  if (isInside(dir, homeReal)) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("agy acp workspace would be inside the OpenCodex home");
  }
  await chmod(dir, 0o700);
  const tmp = join(dir, ".tmp");
  await mkdir(tmp, { mode: 0o700 });
  return { dir, tmp, remove: () => rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined) };
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
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  killWindowsTree?: (pid: number) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

function defaultKillWindowsTree(pid: number): void {
  const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, () => undefined);
}

/**
 * Terminate the child's whole tree and resolve once it has closed or the reap timeout passed.
 * The SIGKILL to the group is sent after the grace period even when the leader already closed.
 */
export function reapProcessTree(child: AgyAcpChild, options: ReapOptions): Promise<void> {
  const set = options.setTimeout ?? setTimeout;
  const clear = options.clearTimeout ?? clearTimeout;
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  const signalGroup = options.signalGroup ?? ((target: number, signal: NodeJS.Signals) => process.kill(-target, signal));
  const signal = (sig: NodeJS.Signals): void => {
    if (pid !== undefined && platform !== "win32") {
      try { signalGroup(pid, sig); return; } catch { /* no group left */ }
    }
    try { child.kill(sig); } catch { /* already gone */ }
  };
  return new Promise<void>(resolve => {
    const leaderGone = child.exitCode !== null || child.signalCode !== null;
    if (platform === "win32") {
      if (!leaderGone && pid !== undefined) {
        try { (options.killWindowsTree ?? defaultKillWindowsTree)(pid); } catch { /* fall back below */ }
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    } else {
      signal("SIGTERM");
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clear(killTimer);
      clear(reapTimer);
      // Whatever is left of the group (a descendant that ignored TERM or closed its stdio) goes now.
      if (platform !== "win32") signal("SIGKILL");
      resolve();
    };
    const killTimer = platform === "win32" ? undefined : set(() => signal("SIGKILL"), options.graceMs);
    const reapTimer = set(finish, options.reapTimeoutMs);
    if (leaderGone) finish();
    else child.once("close", finish);
  });
}
