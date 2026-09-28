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
 *
 * The direct parent is not the tree either, and the difference decides whether the scratch cwd may
 * be deleted. When the launcher exits but a descendant inherited its pipes, the pid this turn holds
 * is gone while the descendant is not: `taskkill /T` on Windows then has no process left to walk
 * from, and a ladder that skips the tree signal because "the parent exited" leaves that descendant
 * running against a directory the turn is about to delete. So the tree signal runs for every child
 * that has not closed, the group is signalled on POSIX even when the leader is gone, and a tree the
 * platform would not signal is reported as an unresolved tree rather than folded into "gone".
 *
 * Finally, ownership has to outlive the turn that started it. A client can cancel the response, and
 * the turn's own admission is core's to return; the harness is not. A bounded cleanup lease is taken
 * while a teardown runs and is handed to the quarantine - together with the survivor - so a process
 * that outlives its turn stays accounted for, bounded, and visible, instead of accumulating behind
 * an admission count that has already been returned.
 */
import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { createAdmissionGate, type AdmissionLease, type AdmissionMetrics } from "../../lib/admission";

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
   * reached it. `unresolved-tree`: the direct process is gone while the tree it led could not be
   * signalled, so a descendant behind it may still be alive - the one case where the working
   * directory must not be released, because nothing here can name what is still using it.
   */
  reason: "pipes-held" | "running" | "unresolved-tree";
  /** True when a signal the ladder sent was refused for a child that was not already gone. */
  signalFailed: boolean;
}

/** What `terminate` could establish about the processes this turn started. */
export interface HarnessCleanupOutcome {
  /** Every child closed on its own: the process is gone and its stdio was released without help. */
  confirmed: boolean;
  /**
   * Nothing this turn started can still be running: no child without an observed exit, and no tree
   * that could not be reached. This is the gate for releasing the scratch cwd, so an unreachable
   * tree counts as "not established" instead of as gone.
   */
  allExited: boolean;
  /** The unresolved remainder; empty exactly when `confirmed`. */
  unresolved: HarnessUnresolvedChild[];
  /** Survivors handed to the bounded quarantine; owned and visible after this call returns. */
  quarantined: number;
  /** The bounded cleanup lease was already taken: this teardown sits outside the accounting. */
  overCapacity: boolean;
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
 * Ceiling for teardowns that are still running. One lease is held per teardown, from the moment the
 * turn stops to the moment every process it started is confirmed gone - or handed to the quarantine,
 * which keeps holding it. The number is deliberately above any realistic number of concurrent turns
 * on a subscription route: reaching it means this process already owns that many harnesses which did
 * not die, and a teardown that cannot be accounted for must not be reported as a clean one.
 */
export const MAX_ACTIVE_HARNESS_TEARDOWNS = 32;

/**
 * How long a survivor stays quarantined before it is dropped, with a warning, as unobservable. Two
 * minutes is many turns of SIGKILL retries for a process that already survived the group signal;
 * past that it is not going to be observed by this process, and pinning the bound on it would make
 * the accounting itself the problem.
 */
const QUARANTINE_TTL_MS = 120_000;

/** How many quarantined teardowns are kept at once; the oldest is evicted first. */
const MAX_QUARANTINED_TEARDOWNS = 32;

const harnessTeardownGate = createAdmissionGate("harness_teardowns", MAX_ACTIVE_HARNESS_TEARDOWNS);

/**
 * One teardown that did not settle, owned here rather than by the turn that started it.
 *
 * A turn's admission is released when its response body ends, and a client that cancels ends that
 * body while the teardown is still running. Holding the lease and the child handles here is what
 * separates "the turn is over" from "the harness is gone": the lease is not returned while an owned
 * process is still alive, a later turn sweeps the survivors, and nothing is dropped silently.
 */
interface HarnessQuarantineEntry {
  readonly children: HarnessChild[];
  readonly pid: number | undefined;
  readonly reason: HarnessUnresolvedChild["reason"];
  readonly since: number;
  /** The bounded cleanup lease of the teardown this entry belongs to, if one could be taken. */
  readonly lease: AdmissionLease | null;
}

const quarantine: HarnessQuarantineEntry[] = [];

/** One quarantined teardown, as reported to tests and diagnostics. */
export interface HarnessQuarantineSnapshot {
  pid: number | undefined;
  reason: HarnessUnresolvedChild["reason"];
  /** Milliseconds since the teardown was quarantined. */
  ageMs: number;
}

/** What the bounded cleanup accounting currently holds. */
export function harnessTeardownMetrics(): Readonly<AdmissionMetrics> {
  return harnessTeardownGate.metrics();
}

/** The survivors this process still owns after their turns gave up. */
export function harnessQuarantineSnapshot(now = Date.now()): HarnessQuarantineSnapshot[] {
  return quarantine.map(entry => ({ pid: entry.pid, reason: entry.reason, ageMs: now - entry.since }));
}

/**
 * Sweep the quarantine: drop teardowns that settled, retry the one thing that is still safe to retry
 * for the rest. Called from the turn path, so the sweep costs nothing while the quarantine is empty
 * and needs no timer of its own.
 */
export function reapHarnessQuarantine(now = Date.now()): number {
  for (let index = quarantine.length - 1; index >= 0; index -= 1) {
    const entry = quarantine[index]!;
    const live = entry.children.filter(child => !child.closed);
    if (live.length === 0) {
      // The survivor closed on its own between turns. The handle was pinned to that process, so
      // this is an observation and not a pid that could have been recycled. The lease it held comes
      // back here - that is the whole point of holding it past the turn.
      quarantine.splice(index, 1);
      entry.lease?.release();
      continue;
    }
    const ageMs = now - entry.since;
    if (ageMs > QUARANTINE_TTL_MS) {
      console.warn(
        `opencodex: claude-agent-sdk harness quarantine drops ${entry.pid ?? "?"}:${entry.reason} after `
        + `${Math.round(ageMs / 1000)}s without an exit; it is out of this process's reach`,
      );
      quarantine.splice(index, 1);
      entry.lease?.release();
      continue;
    }
    // The last thing this turn knows how to do, retried where a later turn can see the result. Only
    // the direct handle is signalled: it is pinned to the process that was spawned, so it cannot
    // reach a recycled pid, and the tree was already signalled while the ladder still had it.
    for (const child of live) {
      try { child.kill("SIGKILL"); } catch { /* the process is gone; `close` carries it */ }
    }
  }
  return quarantine.length;
}

/** Test seam: the quarantine is process state, so a case that asserts on it starts from empty. */
export function resetHarnessQuarantineForTests(): void {
  for (const entry of quarantine) entry.lease?.release();
  quarantine.length = 0;
}

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
  private treeFailures = 0;
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

  /**
   * True when the tree could not be signalled while this child was already gone: the descendants
   * behind a dead pid are then neither named nor reachable from here.
   */
  get treeUnreachable(): boolean {
    return this.treeFailures > 0;
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
   *
   * The exception is the one that matters: a refused tree call while the direct child is already
   * gone is not "nothing left to signal". It is a descendant still holding this child's pipes and
   * using its working directory, with nothing here that can reach it.
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
    const directGone = this.gone;
    let directDelivered = false;
    try {
      directDelivered = this.child.kill(signal);
    } catch {
      directDelivered = false;
    }
    if (!treeDelivered && !directDelivered && !this.gone) this.signalFailures += 1;
    if (!treeDelivered && killTree !== undefined && directGone) this.treeFailures += 1;
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
 * Hand a teardown's survivors - and its cleanup lease - to the bounded quarantine.
 *
 * The bound is the point: an unlimited list of processes this process cannot kill would be the same
 * leak with extra steps. When the quarantine is full the oldest entry is dropped with a warning,
 * which releases its lease and stops pretending to observe it; the survivor is still named in that
 * warning, so nothing about it becomes silent.
 */
function quarantineSurvivors(
  children: HarnessChild[],
  reason: HarnessUnresolvedChild["reason"],
  lease: AdmissionLease | null,
): void {
  while (quarantine.length >= MAX_QUARANTINED_TEARDOWNS) {
    const evicted = quarantine.shift()!;
    console.warn(
      `opencodex: claude-agent-sdk harness quarantine is full; dropping ${evicted.pid ?? "?"}:${evicted.reason}`,
    );
    evicted.lease?.release();
  }
  quarantine.push({ children, pid: children[0]?.pid, reason, since: Date.now(), lease });
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
      if (live.length === 0) {
        return { confirmed: true, allExited: true, unresolved: [], quarantined: 0, overCapacity: false };
      }
      // The bounded cleanup lease is taken before the ladder starts, not after it: a client cancel
      // ends the turn's own admission while this teardown is still running, so the harness needs an
      // owner that is not the turn. A lease that cannot be taken is reported, never ignored - an
      // unaccounted teardown is exactly what must not look like a clean one.
      const lease = harnessTeardownGate.tryAcquire();
      for (const child of live) child.requestTermination("SIGTERM", killTree);
      await waitForClose(live, killGraceMs);
      // The grace window is over, and every child that has not closed is a tree question now rather
      // than a parent question. A child that reported `exit` without `close` had its pipes inherited,
      // and the process group (POSIX) or the launcher's own tree (Windows) is the only handle left on
      // whoever holds them - a descendant whose parent is already gone is still reachable that way,
      // which is why the KILL pass covers all of them and not only the ones whose pid is still alive.
      const survivors = live.filter(child => !child.closed);
      if (survivors.length > 0) {
        for (const child of survivors) child.requestTermination("SIGKILL", killTree);
        await waitForClose(survivors, reapTimeoutMs);
      }
      // Handles are taken back after both observation windows, never between them: a child that
      // exited inside the KILL window would otherwise keep this turn's stdio open to no purpose, and
      // one that is still running gets the stdin EOF it may be waiting for.
      for (const child of live) if (!child.closed) child.reclaimPipes();
      const unresolved: HarnessUnresolvedChild[] = live
        .filter(child => !child.closed)
        .map(child => ({
          pid: child.pid,
          reason: child.treeUnreachable
            ? "unresolved-tree" as const
            : child.exited ? "pipes-held" as const : "running" as const,
          signalFailed: child.signalFailed,
        }));
      // Whatever is left stays owned. The lease and the child handles move to the quarantine, where
      // the next turn observes them, so the accounting for this harness does not end with its turn.
      if (unresolved.length === 0) {
        lease?.release();
      } else {
        quarantineSurvivors(
          live.filter(child => !child.closed),
          unresolved[0]!.reason,
          lease,
        );
      }
      return {
        confirmed: unresolved.length === 0,
        // "pipes-held" is a process this turn saw end; its stdio was taken back, and where the tree
        // could be signalled the descendants behind it were killed with the group. "running" and
        // "unresolved-tree" are the two states in which something this turn started may still be
        // alive, and those are the ones that must not release the scratch cwd.
        allExited: unresolved.every(entry => entry.reason === "pipes-held"),
        unresolved,
        quarantined: unresolved.length === 0 ? 0 : live.filter(child => !child.closed).length,
        overCapacity: lease === null,
      };
    },
  };
}
