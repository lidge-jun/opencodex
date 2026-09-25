import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// Ingest raw bytes before decoding: split UTF-8 and stderr share the same allowance.
export const CURSOR_FOREGROUND_SHELL_MAX_BYTES = 1024 * 1024;
export const CURSOR_FOREGROUND_SHELL_TERM_GRACE_MS = 2_000;
export const CURSOR_FOREGROUND_SHELL_KILL_GRACE_MS = 2_000;

export interface ForegroundShellResult {
  stdout: string;
  stderr: string;
  code: number;
  aborted: boolean;
  signal: string;
}

interface OwnedShell {
  stop(): void;
  completion: Promise<ForegroundShellResult>;
}

/** One transport owns this registry, independently of background-shell admission. */
export class CursorForegroundShellOwner {
  private readonly shells = new Set<OwnedShell>();
  private closed = false;

  get activeCount(): number { return this.shells.size; }
  get isClosed(): boolean { return this.closed; }

  register(shell: OwnedShell): void {
    this.shells.add(shell);
    if (this.closed) shell.stop();
  }

  release(shell: OwnedShell): void { this.shells.delete(shell); }

  async close(): Promise<void> {
    // Seal before taking the snapshot: queued native frames must not spawn after teardown.
    this.closed = true;
    const shells = [...this.shells];
    for (const shell of shells) shell.stop();
    await Promise.all(shells.map(shell => shell.completion));
  }
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (process.platform !== "linux") return true;
  // Orphan zombies cannot execute or hold pipes, but kill(0) still sees them until init
  // reaps them. Do not mistake those for TERM-resistant live descendants. Fail closed
  // on inspection errors other than a process disappearing during the snapshot.
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try { stat = readFileSync(`/proc/${name}/stat`, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return true;
      }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
    }
    return false;
  } catch { return true; }
}

export function runForegroundShell(
  command: string,
  cwd: string,
  hardTimeout: number,
  owner = new CursorForegroundShellOwner(),
  signal?: AbortSignal,
): Promise<ForegroundShellResult> {
  const failure = (reason: string): ForegroundShellResult => ({
    stdout: "", stderr: reason, code: 1, aborted: true, signal: "",
  });
  if (owner.isClosed || signal?.aborted) return Promise.resolve(failure("Cursor shell cancelled."));
  // Windows needs a job-object owner to prove descendant cleanup. taskkill /T after
  // the shell leader exits cannot provide that guarantee; do not spawn unowned work.
  if (process.platform === "win32") {
    return Promise.resolve(failure("Cursor foreground native shell requires POSIX process-group ownership; use the client shell tool on Windows."));
  }

  let child: ReturnType<typeof spawn>;
  try { child = spawn(command, { cwd, shell: true, detached: true, stdio: "pipe" }); }
  catch { return Promise.resolve(failure("Cursor shell failed to start.")); }
  let resolveCompletion!: (result: ForegroundShellResult) => void;
  const completion = new Promise<ForegroundShellResult>(resolve => { resolveCompletion = resolve; });
  let reason: string | undefined;
  let closed = false;
  let settled = false;
  let exitCode = 1;
  let exitSignal = "";
  let terminationStarted = 0;
  let killed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  // Fixed buffers bound bookkeeping even for a producer writing one byte per chunk.
  let stdout = Buffer.allocUnsafe(CURSOR_FOREGROUND_SHELL_MAX_BYTES);
  let stderr = Buffer.allocUnsafe(CURSOR_FOREGROUND_SHELL_MAX_BYTES);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const owned: OwnedShell = { stop: () => stop("Cursor shell cancelled."), completion };
  const abort = () => owned.stop();
  const alive = () => child.pid !== undefined && groupAlive(child.pid);
  const kill = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, sig); } catch { /* bounded confirmation, never kill the proxy group */ }
  };
  const detach = () => {
    if (timeout) clearTimeout(timeout);
    if (poll) clearTimeout(poll);
    signal?.removeEventListener("abort", abort);
  };
  const finish = (clean: boolean) => {
    if (settled) return;
    settled = true;
    detach();
    // Only confirmed process/pipe cleanup releases ownership. An unresolved group is
    // quarantined in the registry, not relabelled as successfully cleaned up.
    if (clean) owner.release(owned);
    const result = reason
      ? failure(clean ? reason : `${reason} Process cleanup could not be confirmed.`)
      : { stdout: stdout.toString("utf8", 0, stdoutBytes), stderr: stderr.toString("utf8", 0, stderrBytes), code: exitCode, aborted: false, signal: exitSignal };
    result.signal = exitSignal;
    stdout = stderr = Buffer.alloc(0);
    resolveCompletion(result);
  };
  const check = () => {
    poll = undefined;
    const live = alive();
    if (closed && !live) { finish(true); return; }
    const elapsed = Date.now() - terminationStarted;
    if (!killed && elapsed >= CURSOR_FOREGROUND_SHELL_TERM_GRACE_MS) {
      killed = true;
      kill("SIGKILL");
    }
    if (elapsed >= CURSOR_FOREGROUND_SHELL_TERM_GRACE_MS + CURSOR_FOREGROUND_SHELL_KILL_GRACE_MS) {
      // A descendant outside our group can retain an inherited pipe. Release the local
      // descriptors within the deadline but retain unconfirmed ownership for diagnosis.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(false);
      return;
    }
    poll = setTimeout(check, 25);
  };
  function stop(message: string): void {
    if (settled || reason) return;
    reason = message;
    stdoutBytes = stderrBytes = 0;
    if (timeout) clearTimeout(timeout);
    terminationStarted = Date.now();
    child.stdin?.destroy();
    kill("SIGTERM");
    poll = setTimeout(check, 0);
  }
  const ingest = (stream: "stdout" | "stderr", chunk: Buffer) => {
    if (reason || settled) return; // Continue draining without retaining late output.
    if (chunk.byteLength > CURSOR_FOREGROUND_SHELL_MAX_BYTES - stdoutBytes - stderrBytes) {
      stop(`Cursor shell output exceeded the combined stdout/stderr limit of ${CURSOR_FOREGROUND_SHELL_MAX_BYTES} bytes.`);
      return;
    }
    if (stream === "stdout") { chunk.copy(stdout, stdoutBytes); stdoutBytes += chunk.byteLength; }
    else { chunk.copy(stderr, stderrBytes); stderrBytes += chunk.byteLength; }
  };
  child.stdout?.on("data", (chunk: Buffer) => ingest("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => ingest("stderr", chunk));
  child.on("error", () => stop("Cursor shell process error."));
  child.stdin?.on("error", () => stop("Cursor shell input pipe error."));
  child.stdout?.on("error", () => stop("Cursor shell output pipe error."));
  child.stderr?.on("error", () => stop("Cursor shell output pipe error."));
  child.once("close", (code, sig) => {
    closed = true;
    exitCode = code ?? 1;
    exitSignal = sig ?? "";
    if (!reason) {
      if (alive()) stop("Cursor foreground shell left running descendants.");
      else finish(true);
    } else if (settled && !alive()) owner.release(owned);
  });
  owner.register(owned);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  if (!reason) timeout = setTimeout(() => stop("Cursor shell timed out."), hardTimeout > 0 ? hardTimeout : 120_000);
  // Foreground execution has no stdin-write handle; commands waiting for EOF must finish.
  child.stdin?.end();
  return completion;
}
