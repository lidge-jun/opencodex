import { spawn } from "node:child_process";

/** Fits inside the caller's outer test/hook budget, separately from the child deadline. */
export const TEST_CHILD_REAP_RESERVE_MS = 5_000;

export interface TestChildResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  reaped: boolean;
  pipesClosed: boolean;
  elapsedMs: number;
}

/**
 * Own a test child on the parent's live event loop. Kill at the deadline, then bound exit/EOF
 * observation separately: descendants retaining pipes must not make a completed child hang.
 * A result with reaped=false is NOT permission to remove a handle-bearing child's fixture.
 * env, when supplied, is the complete environment; do not merge a caller's allowlist.
 * Capture continuously (at most 1 MiB) so failure diagnostics survive a timeout.
 */
export function spawnTestChild(
  argv: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; deadlineMs: number },
): Promise<TestChildResult> {
  const { cwd, env, deadlineMs } = options;
  const startedAt = performance.now();
  const maxCaptureBytes = 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new Error("[test-child] the child could not be spawned"));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let reaped = false;
    let pipesClosed = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let spawned = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let reap: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(reap);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        signal,
        timedOut,
        reaped,
        pipesClosed,
        elapsedMs: performance.now() - startedAt,
      });
    };
    const beginReapGrace = () => {
      if (settled) return;
      reap ??= setTimeout(finish, TEST_CHILD_REAP_RESERVE_MS);
    };
    const stop = () => {
      if (settled || timedOut) return;
      timedOut = true;
      clearTimeout(deadline);
      beginReapGrace();
      try { child.kill("SIGKILL"); } catch { /* The kill's own failure must not extend the wait. */ }
    };
    const capture = (chunk: Buffer, into: Buffer[]) => {
      if (settled || timedOut) return;
      bytes += chunk.length;
      if (bytes > maxCaptureBytes) { stop(); return; }
      into.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, stdoutChunks));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, stderrChunks));
    child.stdout?.on("error", stop);
    child.stderr?.on("error", stop);
    child.once("spawn", () => { spawned = true; });
    // Before "spawn" the child never started (missing executable): report it as a failure
    // rather than an empty result. After it, an error is a failed kill; the reap grace bounds that.
    child.on("error", (error: Error) => {
      if (settled) return;
      if (spawned) { beginReapGrace(); return; }
      settled = true;
      clearTimeout(deadline);
      clearTimeout(reap);
      reject(new Error(`[test-child] the child could not be spawned: ${error.message}`, { cause: error }));
    });
    child.once("exit", (code, exitSignal) => {
      reaped = true;
      exitCode = code;
      signal = exitSignal;
      clearTimeout(deadline);
      // A descendant retaining a pipe must not turn a clean exit into a wait for EOF.
      beginReapGrace();
    });
    child.once("close", (code, exitSignal) => {
      pipesClosed = true;
      exitCode = code;
      signal = exitSignal;
      finish();
    });
    deadline = setTimeout(stop, deadlineMs);
  });
}
