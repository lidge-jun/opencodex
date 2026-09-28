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
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

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
}

export interface HarnessProcessSupervisor {
  /** The SDK's spawn hook; every harness process this turn starts registers here. */
  spawn: (request: HarnessSpawnRequest) => SpawnedProcess;
  /** Bounded TERM -> KILL for everything still alive; resolves once each child has closed. */
  terminate: () => Promise<void>;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_REAP_TIMEOUT_MS = 5_000;

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
    this.pumpStderr(child, onStderr);
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

  /** Send a signal to a process that may already be gone; every runtime either returns or throws. */
  sendSignal(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
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
 */
export function createHarnessProcessSupervisor(options: HarnessProcessSupervisorOptions): HarnessProcessSupervisor {
  const spawnFn = options.spawn ?? nodeSpawn;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const reapTimeoutMs = options.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;
  const children = new Set<HarnessChild>();

  return {
    spawn: request => {
      const child = new HarnessChild(
        spawnFn(request.command, request.args, {
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
          env: request.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }),
        options.onStderr,
      );
      children.add(child);
      // The SDK documents its forwarded `signal` as the thing to hang teardown on: it aborts only
      // after the graceful stdin-EOF window. It is wired as a second net here rather than passed to
      // `spawn()`, so termination does not depend on a runtime forwarding that option.
      if (request.signal.aborted) child.sendSignal("SIGTERM");
      else request.signal.addEventListener("abort", () => child.sendSignal("SIGTERM"), { once: true });
      return child;
    },
    terminate: async () => {
      const live = [...children].filter(child => !child.closed);
      if (live.length === 0) return;
      for (const child of live) child.sendSignal("SIGTERM");
      await waitForClose(live, killGraceMs);
      const survivors = live.filter(child => !child.closed);
      if (survivors.length === 0) return;
      for (const child of survivors) child.sendSignal("SIGKILL");
      await waitForClose(survivors, reapTimeoutMs);
    },
  };
}
