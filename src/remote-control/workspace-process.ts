import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { commandInvocation, type SpawnInvocation } from "../lib/win-exec";
import { resolveTrustedWindowsTaskkillExe } from "../lib/windows-elevation";

export interface RemoteWorkspaceProcessInvocationOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

/**
 * Preserve argv boundaries on Unix and route Windows npm `.cmd`/`.bat` shims through the
 * repository's audited ComSpec escaping. `shell: true` is deliberately never used.
 */
export function remoteWorkspaceProcessInvocation(
  command: readonly string[],
  options: RemoteWorkspaceProcessInvocationOptions = {},
): SpawnInvocation {
  if (command.length < 1 || !command[0]) throw new Error("remote workspace process command is empty");
  return commandInvocation(
    command[0],
    command.slice(1),
    options.platform ?? process.platform,
    { env: options.env ?? process.env },
  );
}

export interface RemoteWorkspaceOwnedProcess {
  pid: number;
  exitCode: number | null;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface StopRemoteWorkspaceProcessOptions {
  platform?: NodeJS.Platform;
  taskkillPath?: string;
  execFile?: (file: string, args: readonly string[]) => void;
  waitMs?: number;
}

export async function waitForRemoteWorkspaceProcessExit(
  child: RemoteWorkspaceOwnedProcess,
  waitMs: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(waitMs) || waitMs < 1) throw new Error("invalid remote workspace process wait");
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      child.exited.then(() => true, () => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), waitMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run every owned-resource cleanup step and report the first failure only after all were attempted. */
export async function runRemoteWorkspaceCleanupSteps(
  steps: readonly (() => void | Promise<void>)[],
): Promise<void> {
  let failed = false;
  let firstFailure: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!failed) firstFailure = error;
      failed = true;
    }
  }
  if (failed) {
    throw firstFailure instanceof Error
      ? firstFailure
      : new Error("remote workspace cleanup failed");
  }
}

/** Stop only the process OCX spawned; Windows must include its `.cmd` descendant tree. */
export async function stopRemoteWorkspaceProcess(
  child: RemoteWorkspaceOwnedProcess,
  options: StopRemoteWorkspaceProcessOptions = {},
): Promise<void> {
  if (child.exitCode !== null) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const exec = options.execFile ?? ((file: string, args: readonly string[]) => {
      execFileSync(file, [...args], { stdio: "ignore", timeout: 5_000, windowsHide: true });
    });
    try {
      exec(options.taskkillPath ?? resolveTrustedWindowsTaskkillExe(), ["/PID", String(child.pid), "/T", "/F"]);
    } catch {
      try { child.kill(); } catch { /* child already exited */ }
    }
    if (!await waitForRemoteWorkspaceProcessExit(child, options.waitMs ?? 1_500)) {
      throw new Error("remote workspace Windows process tree did not exit");
    }
  } else {
    try { child.kill("SIGTERM"); } catch { /* child already exited */ }
    const exited = await waitForRemoteWorkspaceProcessExit(child, options.waitMs ?? 1_500);
    if (!exited) {
      try { child.kill("SIGKILL"); } catch { /* child already exited */ }
      if (!await waitForRemoteWorkspaceProcessExit(child, options.waitMs ?? 1_500)) {
        throw new Error("remote workspace process did not exit after SIGKILL");
      }
    }
  }
}

/** Windows AV/indexers can retain just-exited CLI files briefly; use Node's bounded retry. */
export function removeRemoteWorkspaceIsolation(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
}

/**
 * [Decision Log]
 * - 목적과 의도: Make Hub-owned Codex, Claude Code, and Pi processes start and stop identically
 *   across Linux, macOS, and Windows without leaving npm-shim descendants behind.
 * - 기존 구현 및 제약 조건: Unix can spawn executable scripts directly. Windows npm exposes
 *   `.cmd` files that Bun cannot safely launch shell-less, and killing cmd.exe alone can orphan Node.
 * - 검토한 주요 대안: `shell: true`, three runtime-specific wrappers, direct `.cmd` spawn, or the
 *   repository's existing escaped ComSpec invocation plus trusted System32 taskkill.
 * - 선택한 방식: Share one launcher and one owned-process stop helper across all three runtimes.
 * - 다른 대안 대신 이 방식을 선택한 이유: It preserves exact argv boundaries, avoids a PATH-
 *   resolved shell/taskkill hijack, and matches already-tested OpenCodex Windows behavior.
 * - 장점, 단점 및 영향: Windows npm installs work and stop cleanly. Windows stop is necessarily
 *   forceful because its normal process kill is already forceful; Unix gets a graceful SIGTERM
 *   window and then a bounded SIGKILL fallback so an ignoring child cannot outlive the session.
 */
