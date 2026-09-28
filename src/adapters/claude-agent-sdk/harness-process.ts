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
 * Finally, ownership has to bound the work and outlive the turn that started it. The bounded cleanup
 * lease is reserved before the process is spawned, not after the ladder has begun: a harness this
 * process cannot account for is never started, and a turn that would exceed the bound is refused
 * instead of adding to the pile. The lease is held until that child's `close` proves the exit, and a
 * survivor that never closes keeps holding it. A client can cancel the response and core returns the
 * turn's own admission on that cancel - the harness is not the turn's, so nothing about it comes back
 * on a timer, on an eviction, or because its local pipes were closed.
 *
 * One `close` is not even the parent's own: taking this turn's side of the pipes back is what makes
 * Node emit it for a child whose stdio a descendant inherited, so the event can arrive for a process
 * that died with a tree this ladder could not reach - or for one the ladder never saw die at all.
 * Returning the capacity there would hand out a slot for a descendant that is still using the working
 * directory. A child whose tree call was refused therefore keeps its lease past that `close`, and
 * only the platform's answer that no member of the group is left - `kill(-pid, 0)` on POSIX, nothing
 * at all on Windows - hands it back. The reason on the quarantine entry keeps naming what the ladder
 * saw of the direct parent (`running`, `pipes-held`, `unresolved-tree`); the lease is the part that
 * speaks for the tree.
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
   * A child that is itself still running keeps `running` rather than the tree verdict: a live process
   * this turn can name already fails `allExited`, which is the same conclusion by a shorter route.
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
  /** Survivors handed to the bounded quarantine; each still holds its own cleanup lease. */
  quarantined: number;
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
 * How many harness processes this adapter owns at once. The lease is reserved before the spawn, so the
 * number bounds the work rather than describing it afterwards: the process that would be the next
 * harness is not started, and its turn is refused with `HARNESS_CAPACITY_CODE` instead of piling on.
 * The number is deliberately above any realistic concurrency for a subscription route, so reaching it
 * means harnesses are not dying - and then refusing new work is the honest answer.
 */
export const MAX_ACTIVE_HARNESS_TEARDOWNS = 32;

/**
 * When a quarantined survivor is old enough to be called out. It is only a warning: the entry and its
 * lease stay, because a process that has not reported `close` has not been shown to be gone, and the
 * accounting is the one thing about it this process can still keep true.
 */
const QUARANTINE_STALE_MS = 120_000;

/** Error code for a turn refused because the bounded harness ownership is exhausted. */
export const HARNESS_CAPACITY_CODE = "harness_capacity_exhausted";

/** Thrown from the spawn hook when no cleanup lease is free; the turn is refused, not started. */
export class HarnessCapacityError extends Error {
  readonly code: string = HARNESS_CAPACITY_CODE;
  constructor(readonly limit: number) {
    super(
      `Claude Agent SDK harness capacity reached (${limit} owned processes); refusing to start another`,
    );
    this.name = "HarnessCapacityError";
  }
}

/** Recreated by the test seam, so a case that fills the bound does not leak it into the next one. */
let harnessTeardownGate = createAdmissionGate("harness_teardowns", MAX_ACTIVE_HARNESS_TEARDOWNS);

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
  /** Set once the age warning has been emitted, so a long-lived survivor is named once, not every turn. */
  warned: boolean;
}

const quarantine: HarnessQuarantineEntry[] = [];

/**
 * True while any member of the process group this child led is still present.
 *
 * `kill(-pid, 0)` delivers nothing, so it can only answer the question and can never harm whoever is
 * behind the answer - which matters, because a group id outlives its leader and can be reused
 * afterwards. ESRCH is the group being empty, the one answer that establishes a tree is gone.
 * Windows has no such question to ask: a dead parent's tree cannot be enumerated there, so the
 * ownership stays instead of being guessed away.
 */
export type HarnessTreeProbeFn = (pid: number) => boolean;

function defaultTreeMemberAlive(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

/**
 * Recreated by the test seam, like the gate above: a case that pins what a survivor keeps when its
 * tree cannot be reached decides the answer itself instead of probing the machine it runs on.
 */
let harnessTreeProbe: HarnessTreeProbeFn = defaultTreeMemberAlive;

/** Test seam: the probe is process state, so a case that asserts on it sets its own answer. */
export function setHarnessTreeProbeForTests(probe?: HarnessTreeProbeFn): void {
  harnessTreeProbe = probe ?? defaultTreeMemberAlive;
}

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
 * Sweep the quarantine: drop teardowns that settled, ask the platform about the ones whose tree was
 * never reached, and retry the one thing that is still safe to retry for the rest. Called from the
 * turn path, so the sweep costs nothing while the quarantine is empty and needs no timer of its own.
 */
export function reapHarnessQuarantine(now = Date.now()): number {
  for (let index = quarantine.length - 1; index >= 0; index -= 1) {
    const entry = quarantine[index]!;
    // A closed handle is not a settled one while the tree behind it was never reached: the `close`
    // the ladder's own pipe reclamation produced says the parent's stdio is gone and nothing else.
    // The probe is asked here, and only an answer that no member of the group is left clears it.
    for (const child of entry.children) if (child.treeOwnershipUnresolved) child.settleTreeOwnership();
    const live = entry.children.filter(child => child.ownsUnsettledProcess);
    if (live.length === 0) {
      // Either the survivor's `close` arrived between turns - an observation on a handle pinned to
      // that process, not a pid that could have been recycled - or the tree probe found the group
      // empty. The entry is only the record now, so it can go.
      quarantine.splice(index, 1);
      continue;
    }
    const ageMs = now - entry.since;
    if (ageMs > QUARANTINE_STALE_MS && !entry.warned) {
      // Named once. The entry and its lease stay, because a process that has not reported `close`
      // has not been shown to be gone: returning its capacity here would put the leak back where it
      // started, this time behind a count that says the harness is free.
      entry.warned = true;
      console.warn(
        `opencodex: claude-agent-sdk harness ${entry.pid ?? "?"}:${entry.reason} is still owned after `
        + `${Math.round(ageMs / 1000)}s; its capacity stays reserved until it reports an exit`,
      );
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

/** Test seam: the accounting is process state, so a case that asserts on it starts from empty. */
export function resetHarnessQuarantineForTests(): void {
  for (const entry of quarantine) for (const child of entry.children) child.releaseTeardownLease();
  quarantine.length = 0;
  harnessTreeProbe = defaultTreeMemberAlive;
  harnessTeardownGate = createAdmissionGate("harness_teardowns", MAX_ACTIVE_HARNESS_TEARDOWNS);
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
  } catch (err) {
    // ESRCH is the group being empty, not the signal being refused: the group id this spawn created
    // stays usable while any member lives, so "no such process group" means there is no descendant
    // left to reach. Reporting it as a failure would mark a settled tree as unreachable.
    return (err as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
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
  /**
   * The bounded cleanup lease reserved for this child before it was spawned. It is returned when the
   * child's `close` proves it is gone, and it is what keeps a survivor out of the next turn's pile:
   * the lease is not the turn's, so nothing about the turn ending releases it.
   */
  private readonly teardownLease: AdmissionLease | null;
  private leaseReleased = false;
  private closedFlag = false;
  private exitedFlag = false;
  private signalFailures = 0;
  private treeFailures = 0;
  /**
   * Set by the ladder when this child is handed to the quarantine as an unresolved tree. It is what
   * keeps the direct child's `close` from returning the capacity afterwards: that event can be the
   * ladder's own pipe reclamation talking, and it says nothing about the descendant behind it.
   */
  private treeOwnershipUnsettled = false;
  private resolveClosed: () => void = () => undefined;
  private readonly closeBarrier = new Promise<void>(resolve => { this.resolveClosed = resolve; });

  constructor(child: ChildProcess, onStderr: (chunk: string) => void, teardownLease: AdmissionLease | null = null) {
    const { stdin, stdout } = child;
    if (stdin === null || stdout === null) {
      throw new Error("the harness process was spawned without piped stdio");
    }
    this.child = child;
    this.teardownLease = teardownLease;
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
   * Give the reserved capacity back. Called when this child's `close` is observed - the one event
   * that says the process is gone - and by the test seam that resets the module's accounting.
   */
  releaseTeardownLease(): void {
    if (this.leaseReleased) return;
    this.leaseReleased = true;
    this.teardownLease?.release();
  }

  /**
   * The ladder could not deliver the tree call for this child, so what stands behind it is unproven -
   * whether the direct process was already gone at the deadline or is only the one that goes away
   * later. Ownership is latched before the local pipes are reclaimed, because reclaiming them is
   * itself what makes Node emit the `close` that would otherwise hand the capacity to a descendant
   * that is still there.
   */
  markTreeOwnershipUnsettled(): void {
    this.treeOwnershipUnsettled = true;
  }

  /** True while this handle owns something the platform has not yet shown to be gone. */
  get ownsUnsettledProcess(): boolean {
    return !this.closedFlag || this.treeOwnershipUnsettled;
  }

  /** True while a descendant behind a gone parent may still be alive, and nothing has disproved it. */
  get treeOwnershipUnresolved(): boolean {
    return this.treeOwnershipUnsettled;
  }

  /**
   * Ask the platform whether anything behind this child is left, and return the capacity only on an
   * answer that says no. A child whose process is still running keeps its own answer - the probe is
   * for the case where the parent's `close` already arrived and the ownership survived it.
   */
  settleTreeOwnership(probe: HarnessTreeProbeFn = harnessTreeProbe): boolean {
    if (!this.treeOwnershipUnsettled) return true;
    if (!this.closedFlag) return false;
    const pid = this.child.pid;
    if (pid !== undefined && probe(pid)) return false;
    this.treeOwnershipUnsettled = false;
    this.releaseTeardownLease();
    return true;
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
   * The exception is the one that matters: a refused tree call is not "nothing left to signal". It is
   * a descendant still holding this child's pipes and using its working directory, with nothing here
   * that can reach it - and that is true whether the parent was already gone when the call was made
   * or exits later in the ladder. Recording it only in the first case would lose exactly the timing
   * that matters: TERM and KILL reach no tree, the direct KILL ends the parent, the descendant keeps
   * the pipes, and the teardown reads `pipes-held` with "everything exited" for a tree it never
   * touched.
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
    if (!treeDelivered && killTree !== undefined && pid !== undefined) this.treeFailures += 1;
    return treeDelivered || directDelivered;
  }

  /**
   * Release this side of the child's stdio.
   *
   * A descendant that inherited the harness's pipes keeps `close` withheld after the harness itself
   * is gone; those pipes have no other owner, so the turn takes them back rather than awaiting a
   * `close` that cannot arrive. Destroying the write end also hands a lingering harness the stdin
   * EOF it is waiting for. Taking the pipes back is itself what makes Node emit that `close`, which
   * is why the ladder latches its tree verdict before this runs.
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
    // `close` proves this process's stdio is released. For a tree the ladder could not reach it does
    // not prove the descendant is gone, and the lease is exactly the accounting for "may still be
    // alive": it comes back from the probe, not from an event the ladder produced itself.
    if (!this.treeOwnershipUnsettled) this.releaseTeardownLease();
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
 * Hand a teardown's survivors to the quarantine.
 *
 * They arrive holding their own cleanup leases, because a lease belongs to the child it was reserved
 * for and comes back when that child's `close` proves the exit. That is also why nothing is evicted
 * here: the spawn hook refuses the process that would exceed the bound, so there is no entry to make
 * room for, and releasing a live survivor's lease to make room would be the leak again.
 */
function quarantineSurvivors(children: HarnessChild[], reason: HarnessUnresolvedChild["reason"]): void {
  quarantine.push({ children, pid: children[0]?.pid, reason, since: Date.now(), warned: false });
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
      // Reserved before the spawn, not in `terminate` afterwards: the bound has to decide whether
      // this harness exists at all. A turn that cannot get a lease is refused here, and `sdk-turn.ts`
      // answers it with `HARNESS_CAPACITY_CODE` instead of starting a process it cannot account for.
      const lease = harnessTeardownGate.tryAcquire();
      if (lease === null) throw new HarnessCapacityError(MAX_ACTIVE_HARNESS_TEARDOWNS);
      let child: HarnessChild;
      try {
        child = new HarnessChild(
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
          lease,
        );
      } catch (err) {
        // A launch failure leaves no process to account for, so the reserved capacity goes back.
        lease.release();
        throw err;
      }
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
        return { confirmed: true, allExited: true, unresolved: [], quarantined: 0 };
      }
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
      const settlement = live
        .filter(child => !child.closed)
        .map(child => ({
          child,
          entry: {
            pid: child.pid,
            // A child that is itself still running is the stronger fact and stays named as such; the
            // tree question only decides what an *exited* child leaves behind, which is exactly the
            // case where a descendant holding the inherited pipes can outlive its parent unseen.
            reason: !child.exited
              ? "running" as const
              : child.treeUnreachable ? "unresolved-tree" as const : "pipes-held" as const,
            signalFailed: child.signalFailed,
          },
        }));
      // Ownership is latched before the pipes go back, because reclaiming them is itself what makes
      // Node emit the `close` for a child whose stdio a descendant inherited. A `close` that arrives
      // that way must not return the capacity of a tree this ladder never reached - and "never
      // reached" is the tree call being refused, not the label on the direct parent. A child that
      // shrugged off every signal is still `running` at the deadline with exactly the same refused
      // tree behind it, and the `close` that arrives later proves only that the parent is gone.
      for (const item of settlement) {
        if (item.child.treeUnreachable) item.child.markTreeOwnershipUnsettled();
      }
      for (const child of live) if (!child.closed) child.reclaimPipes();
      const unresolved: HarnessUnresolvedChild[] = settlement.map(item => item.entry);
      // Whatever is left stays owned: each child still holds the lease reserved for it at spawn, and
      // the handles move to the quarantine where the next turn observes them. Capacity is not
      // returned here - a child that closed already returned it through its own `close`, and a tree
      // that could not be reached keeps it until the probe says the group is empty.
      if (unresolved.length > 0) {
        quarantineSurvivors(settlement.map(item => item.child), unresolved[0]!.reason);
      }
      return {
        confirmed: unresolved.length === 0,
        // "pipes-held" is a process this turn saw end; its stdio was taken back, and where the tree
        // could be signalled the descendants behind it were killed with the group. "running" and
        // "unresolved-tree" are the two states in which something this turn started may still be
        // alive, and those are the ones that must not release the scratch cwd.
        allExited: unresolved.every(entry => entry.reason === "pipes-held"),
        unresolved,
        quarantined: settlement.length,
      };
    },
  };
}
