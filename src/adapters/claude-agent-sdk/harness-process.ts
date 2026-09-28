/**
 * Ownership of the harness child process for one Agent SDK turn.
 *
 * The SDK's own spawn is not enough to hold this row's promise. `spawnClaudeCodeProcess` replaces
 * `ProcessTransport.spawnLocalProcess`, and the local spawn is the only place in the bundle that
 * reads the child's stderr (`options.stderr` appears nowhere else) and the only place that sees the
 * real process exit. Replacing it without taking both over would darken the harness's stderr
 * evidence, so this module reproduces the pump and keeps the exit.
 *
 * What the SDK cannot report is that the process is gone. `Query.performCleanup` waits at most
 * 2000 ms for `transport.waitForExit()`, while `ProcessTransport.close` schedules SIGTERM 2000 ms
 * out and SIGKILL 5000 ms after that, both timers unref'd. `query.return()` therefore settles while
 * a TERM-resistant harness is still running: a turn that deleted its scratch cwd and answered the
 * client on that signal would leave the process, its pipes and its working directory behind, and
 * repeated cancellations would accumulate them.
 *
 * Owning the child turns "the SDK gave up" into "the process is confirmed gone": a bounded
 * TERM -> grace -> KILL ladder that awaits the child's `close` before the caller may clean up. The
 * ceiling bounds the observation, not the kill - SIGKILL cannot be refused, so a child that never
 * reports `close` is still dead when the ceiling elapses, it just cannot be watched any longer.
 *
 * `close` is not the same event as "the process ended", though. Node emits `exit` when the process
 * is gone and `close` once its stdio is released, and a launcher hands its pipes to a descendant:
 * the harness ends, the pipe stays open, `close` never arrives - and a ladder that watches only
 * `close` waits out its entire ceiling and then calls an unresolved teardown a confirmed one. The
 * two events are kept apart here, the stdio this turn owns is destroyed when the drain cannot finish
 * on its own, the process tree is signalled where the platform gives us one, and whatever remains
 * unresolved comes back as such instead of being rounded to "gone".
 */
import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

/**
 * Terminate the child's process tree where the platform supports it and report whether a signal
 * reached anything. The direct child is signalled separately, so `false` here is a degraded path,
 * not a dead end.
 */
export type HarnessTreeKillFn = (signal: NodeJS.Signals, pid: number) => boolean;

/** Injectable spawn for tests; production uses `node:child_process`, as the sibling CLI turn does. */
export type HarnessSpawnFn = (command: string, args: readonly string[], options: NodeSpawnOptions) => ChildProcess;

/**
 * The SDK's spawn request, kept structural so the adapter imports no SDK value at runtime. The
 * fields are the ones the SDK documents for `spawnClaudeCodeProcess`.
 */
export interface HarnessSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: { [name: string]: string | undefined };
  /** The SDK's forwarded abort signal; see the second net in `createHarnessProcessSupervisor`. */
  signal: AbortSignal;
}

export interface HarnessProcessSupervisorOptions {
  /**
   * Bounded stderr sink. A custom spawner switches the SDK's stderr pump off, so the harness's own
   * error text has to be read here or a dead harness reports nothing about why it died.
   */
  onStderr: (chunk: string) => void;
  /** Injectable spawn for tests. */
  spawn?: HarnessSpawnFn;
  /** Grace between SIGTERM and SIGKILL (ms). */
  killGraceMs?: number;
  /** Ceiling for a child that never reports close after SIGKILL (ms). */
  reapTimeoutMs?: number;
  /** Platform seam for the tree terminator and the process-group decision (tests). */
  platform?: NodeJS.Platform;
  /** Test seam for the tree terminator; see `defaultKillProcessTree`. */
  killProcessTree?: HarnessTreeKillFn;
}

/** One child the ladder could not settle, named rather than rounded to "gone". */
export interface HarnessUnresolvedChild {
  pid: number | undefined;
  /**
   * `pipes-held`: the process exited, but a descendant inherited its stdout/stderr, so `close` was
   * withheld and the stdio had to be reclaimed instead of awaited. `running`: no exit was observed
   * inside the ladder's ceilings, which in the presence of SIGKILL also means the signal never
   * reached it.
   */
  reason: "pipes-held" | "running";
  /** True when a signal the ladder sent was refused for a child that was not already gone. */
  signalFailed: boolean;
}

/** What `terminate` could establish about the processes this turn started. */
export interface HarnessCleanupOutcome {
  /** Every child closed on its own: the process is gone and its stdio was released without help. */
  confirmed: boolean;
  /** No process this turn started is still running. Only false while a survivor is alive. */
  allExited: boolean;
  /** The unresolved remainder; empty exactly when `confirmed`. */
  unresolved: HarnessUnresolvedChild[];
}

export interface HarnessProcessSupervisor {
  /** The SDK's spawn hook; every harness process this turn starts registers here. */
  spawn: (request: HarnessSpawnRequest) => SpawnedProcess;
  /** Bounded TERM -> KILL for everything still alive; reports what it could and could not settle. */
  terminate: () => Promise<HarnessCleanupOutcome>;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_REAP_TIMEOUT_MS = 5_000;

/**
 * Terminate the child and the descendants it leads.
 *
 * POSIX gets the process group the spawn created for the harness, which is how a child of the
 * harness is reached when only the harness's own pid is known. Windows gets `taskkill /T /F`, the
 * same tree terminator the spawned-CLI turn uses, because a `.cmd` shim there would otherwise leave
 * the real CLI running. A runtime that refuses either call leaves the direct-child signal below,
 * which is why this returns a verdict instead of throwing.
 */
function defaultKillProcessTree(signal: NodeJS.Signals, pid: number): boolean {
  if (process.platform === "win32") {
    try {
      execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"], {
        stdio: "pipe",
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;
interface ExitEntry { listener: ExitListener; once: boolean }
interface ErrorEntry { listener: ErrorListener; once: boolean }

/**
 * One harness process, owned by this adapter rather than by the SDK.
 *
 * `SpawnedProcess` is the SDK's own interface, so the SDK drives this object exactly as it drives
 * the local spawn it would otherwise use. Two additions carry the turn: `closed` is the real
 * teardown signal (the child's `close`, i.e. exit plus drained stdio) and the listener entries are
 * kept here so the ladder can still reach listeners the SDK registered.
 */
class HarnessChild implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly child: ChildProcess;
  private readonly exitEntries = new Set<ExitEntry>();
  private readonly errorEntries = new Set<ErrorEntry>();
  private closedFlag = false;
  private exitedFlag = false;
  private signalFailures = 0;
  private resolveClosed: () => void = () => undefined;
  private readonly closeBarrier = new Promise<void>(resolve => { this.resolveClosed = resolve; });

  constructor(child: ChildProcess, onStderr: (chunk: string) => void) {
    const { stdin, stdout } = child;
    if (stdin === null || stdout === null) {
      throw new Error("the harness process was spawned without piped stdio");
    }
    this.child = child;
    this.stdin = stdin;
    this.stdout = stdout;
    // The ladder signals the child as soon as the turn ends, while the SDK may still be writing into
    // a pipe whose process is already gone. An EPIPE with no listener is an uncaught exception, so
    // both ends are absorbed here; the exit still reaches the turn through `close` and the stderr
    // tail, exactly as the sibling spawned-CLI turn handles the same race.
    stdin.on("error", () => { /* the harness is gone; carried by close and the stderr tail */ });
    stdout.on("error", () => { /* the read end went away with the process */ });
    this.pumpStderr(child, onStderr);
    // The process ending and its stdio being released are two events. Node withholds `close` while a
    // descendant still holds the write end of a pipe, so `exit` is the only carrier of "this pid is
    // gone" and the ladder needs it to tell a drain failure from a live process.
    child.once("exit", () => { this.exitedFlag = true; });
    child.once("close", (code, signal) => this.deliverExit(code, signal));
    child.once("error", error => {
      // A launch failure has no process to reap and is not guaranteed to emit `close` on every
      // runtime, so it counts as gone here; otherwise the ladder would wait on a process that never
      // existed. The same allowance the spawned-CLI turn makes for a synchronous spawn failure.
      if (child.pid === undefined) this.deliverExit(null, null);
      for (const entry of [...this.errorEntries]) {
        if (entry.once) this.errorEntries.delete(entry);
        entry.listener(error);
      }
    });
  }

  /** True once the child has closed, which is the only signal that its stdio is released too. */
  get closed(): boolean {
    return this.closedFlag;
  }

  /** True once the process itself is gone, whether or not its stdio has been released. */
  get exited(): boolean {
    return this.exitedFlag;
  }

  /** True once a signal was refused for a child that was not already gone. */
  get signalFailed(): boolean {
    return this.signalFailures > 0;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get closedWait(): Promise<void> {
    return this.closeBarrier;
  }

  get killed(): boolean {
    return this.child.killed;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode;
  }

  kill(signal: NodeJS.Signals): boolean {
    return this.child.kill(signal);
  }

  /**
   * Signal this child and, where the platform supports it, the tree it leads.
   *
   * The direct signal is sent either way: the group call is how the harness's own children are
   * reached, and the direct call is what still works when that path is unavailable. A refusal is
   * only a failure while the child is not known to be gone - every runtime returns `false` for a pid
   * that no longer exists, which is the outcome the ladder wanted.
   */
  requestTermination(signal: NodeJS.Signals, killTree: HarnessTreeKillFn | undefined): boolean {
    const pid = this.child.pid;
    let treeDelivered = false;
    if (killTree !== undefined && pid !== undefined) {
      try {
        treeDelivered = killTree(signal, pid) === true;
      } catch {
        treeDelivered = false;
      }
    }
    let directDelivered = false;
    try {
      directDelivered = this.child.kill(signal);
    } catch {
      directDelivered = false;
    }
    if (!treeDelivered && !directDelivered && !this.gone) this.signalFailures += 1;
    return treeDelivered || directDelivered;
  }

  /**
   * Release this side of the child's stdio.
   *
   * A descendant that inherited the harness's pipes keeps `close` withheld after the harness itself
   * is gone; those pipes have no other owner, so the turn takes them back rather than awaiting a
   * `close` that cannot arrive. Destroying the write end also hands a lingering harness the stdin
   * EOF it is waiting for.
   */
  reclaimPipes(): void {
    for (const stream of [this.stdin, this.stdout, this.child.stderr]) {
      try {
        stream?.destroy();
      } catch {
        /* already released */
      }
    }
  }

  private get gone(): boolean {
    return this.exitedFlag
      || this.closedFlag
      || this.child.exitCode !== null
      || this.child.signalCode !== null
      || this.child.pid === undefined;
  }

  on(event: "exit", listener: ExitListener): void;
  on(event: "error", listener: ErrorListener): void;
  on(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    if (event === "exit") this.exitEntries.add({ listener: listener as ExitListener, once: false });
    else this.errorEntries.add({ listener: listener as ErrorListener, once: false });
  }

  once(event: "exit", listener: ExitListener): void;
  once(event: "error", listener: ErrorListener): void;
  once(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    if (event === "exit") this.exitEntries.add({ listener: listener as ExitListener, once: true });
    else this.errorEntries.add({ listener: listener as ErrorListener, once: true });
  }

  off(event: "exit", listener: ExitListener): void;
  off(event: "error", listener: ErrorListener): void;
  off(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    if (event === "exit") this.removeEntry(this.exitEntries, listener as ExitListener);
    else this.removeEntry(this.errorEntries, listener as ErrorListener);
  }

  private removeEntry<TEntry extends { listener: unknown }>(entries: Set<TEntry>, listener: unknown): void {
    for (const entry of entries) if (entry.listener === listener) entries.delete(entry);
  }

  /**
   * The SDK's local spawn pumped the child's stderr into `Options.stderr` through a `StringDecoder`,
   * because a chunk boundary can split a UTF-8 sequence and a code-unit cut would corrupt the text.
   * A custom spawner switches that pump off, so both halves are reproduced here.
   */
  private pumpStderr(child: ChildProcess, onStderr: (chunk: string) => void): void {
    const stderr = child.stderr;
    if (stderr === null) return;
    const decoder = new StringDecoder("utf8");
    stderr.on("data", chunk => onStderr(decoder.write(chunk)));
    stderr.once("close", () => {
      const tail = decoder.end();
      if (tail.length > 0) onStderr(tail);
    });
    stderr.on("error", () => {
      /* A read error ends the tail; the exit code and signal still reach the turn through close. */
    });
  }

  /**
   * Report the exit to the SDK's listeners. `close` is the carrier rather than `exit`, which is the
   * ordering the SDK's own local spawn keeps: exit errors carry the harness's stderr tail because the
   * exit is not reported before stderr has drained. Listeners are not replayed for a later
   * registration, exactly as a real child process that exits once behaves.
   */
  private deliverExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.resolveClosed();
    const entries = [...this.exitEntries];
    this.exitEntries.clear();
    for (const entry of entries) entry.listener(code, signal);
  }
}

/** Wait for every child to close, bounded by `ms`; the ladder's observation ceiling. */
async function waitForClose(children: readonly HarnessChild[], ms: number): Promise<void> {
  if (children.every(child => child.closed)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(children.map(child => child.closedWait)),
    new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/**
 * Create the per-turn owner of the harness process.
 *
 * `terminate` is the teardown the turn runs before it deletes its scratch cwd: SIGTERM, the grace
 * window, SIGKILL for whatever survived it, and then one more bounded wait for the survivors to
 * report `close`. A turn whose harness exits on stdin EOF never reaches the later stages, so the
 * ordinary path costs nothing beyond the close it was waiting for anyway.
 *
 * What comes back is evidence, not a formality: `confirmed` means every child closed by itself,
 * `allExited` survives a teardown where the stdio of a descendant had to be reclaimed, and a child
 * that is still running is named instead of being reported as a clean exit. The caller deletes the
 * working directory only on `allExited` and reports the rest.
 */
export function createHarnessProcessSupervisor(options: HarnessProcessSupervisorOptions): HarnessProcessSupervisor {
  const spawnFn = options.spawn ?? nodeSpawn;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const reapTimeoutMs = options.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  const killTree = options.killProcessTree ?? defaultKillProcessTree;
  const children = new Set<HarnessChild>();

  return {
    spawn: request => {
      const child = new HarnessChild(
        spawnFn(request.command, request.args, {
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          env: request.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // POSIX: a process group of its own, so the harness's children are reachable by signal when
          // the only pid we are handed is the harness's. The child is never `unref`'d, so this changes
          // which processes a signal reaches, not whether the turn is held to the child.
          detached: platform !== "win32",
        }),
        options.onStderr,
      );
      children.add(child);
      // The SDK documents its forwarded `signal` as the thing to hang teardown on: it aborts only
      // after the graceful stdin-EOF window. It is wired as a second net here rather than passed to
      // `spawn()`, so termination does not depend on a runtime forwarding that option.
      if (request.signal.aborted) child.requestTermination("SIGTERM", killTree);
      else request.signal.addEventListener("abort", () => child.requestTermination("SIGTERM", killTree), { once: true });
      return child;
    },
    terminate: async () => {
      const live = [...children].filter(child => !child.closed);
      if (live.length === 0) return { confirmed: true, allExited: true, unresolved: [] };
      for (const child of live) child.requestTermination("SIGTERM", killTree);
      await waitForClose(live, killGraceMs);
      // A child that reported `exit` without `close` is not a live process: its stdio is held open by
      // something that inherited the pipes, and no further signal will close it. Those handles are
      // this turn's, so they are taken back here instead of being waited out.
      const piped = live.filter(child => !child.closed && child.exited);
      for (const child of piped) child.reclaimPipes();
      const running = live.filter(child => !child.closed && !child.exited);
      if (running.length > 0) {
        for (const child of running) child.requestTermination("SIGKILL", killTree);
        await waitForClose(running, reapTimeoutMs);
      }
      const unresolved: HarnessUnresolvedChild[] = [
        ...piped.map(child => ({ pid: child.pid, reason: "pipes-held" as const, signalFailed: child.signalFailed })),
        // A survivor of the KILL window may have exited inside it without a `close` of its own; that
        // is the same drain situation, and only a child with no `exit` at all is still running.
        ...running
          .filter(child => !child.closed)
          .map(child => ({
            pid: child.pid,
            reason: child.exited ? "pipes-held" as const : "running" as const,
            signalFailed: child.signalFailed,
          })),
      ];
      return {
        confirmed: unresolved.length === 0,
        allExited: running.every(child => child.exited || child.closed),
        unresolved,
      };
    },
  };
}
