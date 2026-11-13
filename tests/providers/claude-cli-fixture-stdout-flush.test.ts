import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readJsonLines } from "../../src/adapters/coding-agent/protocol";
import { fixturePath } from "../helpers/repo-root";

/**
 * The owned Claude CLI fixture answers the synthetic image replay with one JSONL frame whose text
 * is the whole replayed conversation. That frame is megabytes, which is the shape the fixture's
 * original bug needed: it wrote the frame and then called `process.exit(0)`, and `process.exit`
 * terminates without draining stdout, so whatever the runtime still held was discarded and the
 * reader saw a malformed frame. The size alone proves nothing here — Bun buffers internally — which
 * is why the observations below come from the write's own callback rather than from byte counts.
 *
 * The fix and the observation share one function. `writeReplayAndExit` in the fixture is the only
 * place the exit sequence exists, and the production run calls it with no hooks. An earlier version
 * of this regression kept a separate probe copy of that sequence, so reverting the production path
 * left every case green: the tests were watching code the adapter never ran. The default-path case
 * below therefore drives production `readJsonLines` against a fixture spawned exactly as the adapter
 * spawns it, with no probe environment at all, and the probe cases observe the same statements
 * rather than a twin.
 *
 * Claims measured here, kept separate on purpose:
 *
 *  - The contract, on the default path: all three frames and the whole replayed text arrive through
 *    the production reader, with a zero exit. This is the case that carries the fix: reverting only
 *    the production write-and-exit fails it, and also fails the reader-release case below, which
 *    waits for a mark the reverted sequence never emits.
 *  - The unsettled state is *observed*, not inferred from payload size. The fixture reports, in the
 *    write's own tick and again after one loop turn, whether the runtime took the bytes into its own
 *    queue and whether the completion callback had run by then. With stdout deliberately unread a
 *    multi-megabyte write has neither at that point; a small control has both. That contrast is
 *    buffering and size behavior on this platform — it is not a claim about a pipe threshold, and no
 *    later-turn behavior is asserted.
 *  - The narrowness is deliberate: the multi-megabyte case says the callback had not run within one
 *    turn, not that it can never run without a reader. Releasing the reader later does settle it,
 *    and that is the next case.
 *  - The failure paths fail: the pre-fix exit drops the frame, a malformed frame followed by a child
 *    that never exits surfaces the protocol error and is reaped, and a child that never reads stdin
 *    fails the parent's write with EPIPE instead of aborting an unrelated test.
 *
 * There is no command channel and no deadline. Marks ride stderr, so no spawn capability beyond the
 * three standard descriptors is involved and no case is skipped on a platform that cannot pass a
 * fourth one. The child's marks, its `close`, and the parent write's own failure are the only
 * signals; a child that dies early fails the wait that expected its mark instead of stalling.
 */
const REPLAY_CHARS = 3_000_000;
/**
 * The control is deliberately tiny: the point is only that a small write settles while the large one
 * has not, through the same statements. It is kept at a byte count no plausible destination can fail
 * to take in one piece, and the guard below applies only to the fixture's own reported byte count.
 * It is *not* a measured pipe threshold, and nothing here asserts that a write above it blocks or
 * that a write below it cannot: Bun's internal buffering means the runtime's return value describes
 * its own queue, not the kernel destination.
 */
const CONTROL_SIZE_GUARD_BYTES = 512;
/** Frame overhead is fixed, so this many characters stays well inside that guard. */
const CONTROL_CHARS = 64;
/** Marks are newline-delimited on stderr behind a sentinel, since stderr also carries diagnostics. */
const MARK_PREFIX = "OCXPROBE ";

const replayContent = (chars: number) => [{ type: "text", text: "x".repeat(chars) }];

interface Tracked {
  child: ChildProcess;
  /** Resolves at the child's `close`; subscribed at spawn, so a fast exit cannot be missed. */
  closed: Promise<void>;
  isClosed: () => boolean;
  /** Exit code once closed, matching `close`'s argument. */
  exitCode: () => number | null;
  spawnError: () => Error | undefined;
  /**
   * Stdin write failures recorded since spawn. A case that expects its request to arrive asserts
   * this is empty; the case that deliberately provokes EPIPE asserts the code it contains.
   */
  stdinErrors: () => NodeJS.ErrnoException[];
}

/**
 * Subscribe to termination immediately after `spawn`.
 *
 * Registering `close` later — in a cleanup helper — is racy: a child that has already closed never
 * emits it again, so the cleanup would wait forever for an event that is in the past.
 */
function track(child: ChildProcess): Tracked {
  let closed = false;
  let code: number | null = null;
  let spawnError: Error | undefined;
  let settle!: () => void;
  const done = new Promise<void>(resolve => { settle = resolve; });
  const finish = () => {
    if (closed) return;
    closed = true;
    settle();
  };
  child.once("close", exitCode => {
    code = exitCode;
    finish();
  });
  child.once("error", error => {
    spawnError = error;
    // A launch failure has no process to reap and is not guaranteed to emit `close`.
    if (child.pid === undefined) finish();
  });
  /**
   * Subscribe to stdin failures here, before any caller writes.
   *
   * A child that exits without draining stdin fails the outstanding write with EPIPE. With no
   * listener, Bun raises that as an uncaught error against whichever test happens to be running when
   * it fires — which can be a later, unrelated one. Subscribing at spawn keeps the failure
   * attributed to the test that owns the child, and the cases that expect their request to arrive
   * assert the list is empty, so this listener records rather than swallows.
   */
  const stdinErrors: NodeJS.ErrnoException[] = [];
  child.stdin?.on("error", error => { stdinErrors.push(error as NodeJS.ErrnoException); });
  return {
    child,
    closed: done,
    isClosed: () => closed,
    exitCode: () => code ?? child.exitCode,
    spawnError: () => spawnError,
    stdinErrors: () => stdinErrors,
  };
}

interface Probe extends Tracked {
  marks: Record<string, unknown>[];
  waitForMark: (phase: string) => Promise<Record<string, unknown>>;
}

/**
 * Spawn the fixture in a probe mode and collect its stderr marks.
 *
 * `OCX_REPLAY_PROBE` selects the mode and turns the marks on; the fixture ignores it when absent, so
 * the adapter, a direct run and every other test run the production path unchanged. The request is
 * written and stdin closed here, exactly as the adapter does it, so each probe case also exercises
 * production stdin handling.
 */
function spawnProbe(mode: string, content: Array<{ type: string; text: string }>): Probe {
  const child = spawn(process.execPath, [fixturePath("claude-efficiency-cli.ts"), "[]", "", "image-replay"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OCX_REPLAY_PROBE: mode },
  });
  const tracked = track(child);
  const marks: Record<string, unknown>[] = [];
  /**
   * Waiters that have not settled yet. A check removes itself when it resolves or rejects; dropping
   * the whole list on every event would lose a waiter whose mark is still in a later chunk, and the
   * marks of one write do arrive in separate chunks.
   */
  const waiting = new Set<() => void>();
  let buffered = "";
  let exited: Error | undefined;

  const notify = () => {
    for (const check of [...waiting]) check();
  };

  child.stderr!.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith(MARK_PREFIX)) continue; // ordinary CLI diagnostics, not this probe
      marks.push(JSON.parse(line.slice(MARK_PREFIX.length)) as Record<string, unknown>);
    }
    notify();
  });

  void tracked.closed.then(() => {
    exited = tracked.spawnError() ?? new Error(
      `fixture exited before the expected mark (exit=${String(tracked.exitCode())}); marks=${JSON.stringify(marks)}`,
    );
    notify();
  });

  const waitForMark = (phase: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const check = () => {
      const found = marks.find(mark => mark.phase === phase);
      if (found) {
        waiting.delete(check);
        return resolve(found);
      }
      if (exited) {
        waiting.delete(check);
        return reject(exited);
      }
    };
    waiting.add(check);
    check();
  });

  // The fixture reads stdin to EOF before it answers, and `no-read` never reads it at all; that case
  // deliberately leaves the request unwritten. Every other mode gets the request and EOF here.
  if (mode !== "no-read") child.stdin!.end(`${JSON.stringify({ message: { content } })}\n`);

  return { ...tracked, marks, waitForMark };
}

/** Drain a child through the production reader, collecting the frames or the failure. */
async function drain(child: ChildProcess) {
  const frames: Record<string, unknown>[] = [];
  let readError: Error | undefined;
  try {
    for await (const frame of readJsonLines(child.stdout!)) frames.push(frame);
  } catch (error) {
    readError = error as Error;
  }
  return { frames, readError };
}

/** Resolve the exit code from the `close` subscription taken at spawn. */
async function exitCodeOf(tracked: Tracked): Promise<number | null> {
  if (!tracked.isClosed()) await tracked.closed;
  return tracked.exitCode();
}

/** Terminate and reap, so a failing assertion cannot leave a live child behind. */
async function reap(tracked: Tracked): Promise<void> {
  if (tracked.isClosed()) return;
  tracked.child.kill("SIGKILL");
  await tracked.closed;
}

const replayText = (frames: Record<string, unknown>[]): string | undefined =>
  (frames.find(frame => frame.type === "stream_event") as
    { event?: { delta?: { text?: string } } } | undefined)?.event?.delta?.text;

/**
 * The production path, spawned the way `src/adapters/coding-agent/turn.ts` spawns it: three standard
 * descriptors, no probe environment, request on stdin, frames read through `readJsonLines`.
 *
 * This is the case the review asked for. It exercises no probe at all, so it cannot pass while the
 * statements a real turn depends on are reverted.
 */
test("the default fixture path delivers every frame and the whole replay through the production reader", async () => {
  const content = replayContent(REPLAY_CHARS);
  const expectedText = JSON.stringify(content);
  const env = { ...process.env };
  delete env.OCX_REPLAY_PROBE;
  const child = spawn(process.execPath, [fixturePath("claude-efficiency-cli.ts"), "[]", "", "image-replay"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const tracked = track(child);
  child.stdin!.end(`${JSON.stringify({ message: { content } })}\n`);
  try {
    const { frames, readError } = await drain(child);
    const exitCode = await exitCodeOf(tracked);

    expect(readError).toBeUndefined();
    expect(exitCode).toBe(0);
    // The request reached the child: a write the child never read would have failed here instead of
    // producing these frames, and this case would be reporting a pipe error as a parse error.
    expect(tracked.stdinErrors()).toEqual([]);
    expect(frames.map(frame => frame.type)).toEqual(["system", "stream_event", "result"]);
    // Exact equality against the requested text is the completeness proof: a truncated frame either
    // fails to parse or carries a prefix of it, and both are distinguished here.
    expect(replayText(frames)).toBe(expectedText);
  } finally {
    await reap(tracked);
  }
}, 60_000);

test("the fixture's replay write is still pending while stdout has no reader", async () => {
  const probe = spawnProbe("observe", replayContent(REPLAY_CHARS));
  try {
    const returned = await probe.waitForMark("replay-returned");
    const turn = await probe.waitForMark("replay-turn");

    // The payload is the same multi-megabyte frame the contract case uses; this is the child's own
    // byte count, not the test's.
    expect(returned.bytes as number).toBeGreaterThan(CONTROL_SIZE_GUARD_BYTES * 1000);
    // The runtime took the bytes into its own queue instead of handing them all over, and one loop
    // turn later the write's own callback still had not run. Both are the child's state, observed in
    // the child; neither is inferred from the payload size, and neither claims more than one turn.
    expect(returned.accepted).toBe(false);
    expect(turn.settled).toBe(false);
  } finally {
    await reap(probe);
  }
}, 60_000);

test("a small payload settles with no reader, which is the buffering and size contrast", async () => {
  const probe = spawnProbe("observe", replayContent(CONTROL_CHARS));
  try {
    const returned = await probe.waitForMark("replay-returned");
    const turn = await probe.waitForMark("replay-turn");
    const settled = await probe.waitForMark("replay-settled");

    // The byte count comes from the fixture, so a framing change cannot quietly push the control up
    // into the size range of the case it contrasts with. This is a guard on that count only.
    expect(returned.bytes as number).toBeLessThanOrEqual(CONTROL_SIZE_GUARD_BYTES);
    // Same statements, same code path, same absent reader; only the size changed. Observed on this
    // platform: the runtime accepted the bytes and the callback had run within one turn. The
    // specific size at which that flips is not asserted — Bun's buffering, not the pipe bound,
    // decides it.
    expect(returned.accepted).toBe(true);
    expect(turn.settled).toBe(true);
    // The state in the mark is the write's own callback result, not a field this test invented.
    expect(settled.replayError).toBeNull();
  } finally {
    await reap(probe);
  }
}, 60_000);

/**
 * Two independently observed things in one child: the frames the production reader receives, and
 * the mark the child writes from inside the replay write's completion callback. Nothing orders the
 * assertion on the mark against the reader, because the reader is the one draining the buffer that
 * keeps the write alive.
 */
test("releasing the reader delivers the whole replay frame and the callback orders the exit", async () => {
  const content = replayContent(REPLAY_CHARS);
  const expectedText = JSON.stringify(content);
  const probe = spawnProbe("observe", content);
  try {
    const returned = await probe.waitForMark("replay-returned");
    expect(returned.accepted).toBe(false);

    // The reader starts here, so the write that was queued now has somewhere to go. Its completion
    // callback runs only after every earlier byte has left the process, which is what lets the
    // fixture's `process.exit` follow without cutting the frame.
    const drained = drain(probe.child);
    const settled = await probe.waitForMark("replay-settled");
    const { frames, readError } = await drained;
    const exitCode = await exitCodeOf(probe);

    expect(settled.replayError).toBeNull();
    expect(readError).toBeUndefined();
    expect(exitCode).toBe(0);
    expect(frames.map(frame => frame.type)).toEqual(["system", "stream_event", "result"]);
    // Exact equality: a truncated frame either fails to parse or carries a prefix.
    expect(replayText(frames)).toBe(expectedText);
  } finally {
    await reap(probe);
  }
}, 60_000);

test("exiting before the replay write drains drops the frame, which the reader reports as malformed", async () => {
  const probe = spawnProbe("exit-before-flush", replayContent(REPLAY_CHARS));
  try {
    const { frames, readError } = await drain(probe.child);
    await probe.closed;

    // The pre-fix behavior, kept as the red case. Only the small init frame survives: the replay
    // frame is cut mid-JSON, so the reader rejects it rather than yielding a prefix, and the result
    // frame after it never arrives at all.
    expect(readError?.name).toBe("CodingAgentProtocolError");
    expect(readError?.message).toContain("Malformed stream-json frame");
    expect(frames.map(frame => frame.type)).toEqual(["system"]);
    expect(replayText(frames)).toBeUndefined();
  } finally {
    await reap(probe);
  }
}, 60_000);

test("a malformed frame from a child that never exits surfaces the error and is reaped", async () => {
  const probe = spawnProbe("malformed-hang", replayContent(REPLAY_CHARS));
  try {
    // The child's own mark says the corrupt frame reached the pipe; the failure below is then the
    // reader rejecting it rather than the read having started before anything was written.
    await probe.waitForMark("malformed-written");
    const { readError } = await drain(probe.child);

    // The read fails on its own: no deadline is involved, and the child is still running because
    // nothing has asked it to stop. That is what makes the reap below the thing under test.
    expect(readError?.name).toBe("CodingAgentProtocolError");
    expect(probe.isClosed()).toBe(false);

    await reap(probe);
    expect(probe.isClosed()).toBe(true);
  } finally {
    await reap(probe);
  }
}, 60_000);

test("a child that never reads stdin fails the parent's write with EPIPE instead of aborting an unrelated test", async () => {
  const probe = spawnProbe("no-read", replayContent(REPLAY_CHARS));
  const streamErrors: NodeJS.ErrnoException[] = [];
  try {
    // The child is alive and provably not reading stdin: it marked readiness before touching the
    // pipe. The write below therefore fails through the child's exit, not through a race with its
    // startup.
    await probe.waitForMark("ready");

    // The write is megabytes against a pipe nobody is draining, so the runtime queues it instead of
    // handing it all over. That return value is asserted, not assumed: it is the precondition for the
    // failure below coming from the pipe closing rather than the write having already finished.
    const accepted = probe.child.stdin!.write("z".repeat(REPLAY_CHARS) + "\n", () => {});
    expect(accepted).toBe(false);

    const writeFailed = new Promise<NodeJS.ErrnoException>(resolve => {
      // An unhandled stdin `error` does not abort the runner; Bun fails whichever test is running
      // when it fires, which can be a later, unrelated one. Handling it here keeps the failure
      // attributed to this test, and the error is still asserted below rather than swallowed.
      probe.child.stdin!.on("error", error => {
        streamErrors.push(error as NodeJS.ErrnoException);
        resolve(error as NodeJS.ErrnoException);
      });
    });

    probe.child.kill("SIGKILL");
    const writeError = await writeFailed;
    await probe.closed;

    // The queued write failed, and it failed as a closed pipe, not as an arbitrary error a
    // condition free assertion would also accept.
    expect(writeError.code).toBe("EPIPE");
    expect(streamErrors.map(error => error.code)).toContain("EPIPE");
  } finally {
    await reap(probe);
  }
}, 60_000);

/**
 * The early exit the writer cannot prevent: this child never reads stdin and leaves immediately, so
 * the request written in the spawn tick has no reader and the pipe closes under it. The failure is
 * asserted here, as a code, rather than left to surface wherever it happens to be noticed — an
 * unhandled stdin `error` fails whichever test is running when it fires, which can be a later one.
 *
 * The exit status is checked alongside the pipe error so the two claims stay separate: the child
 * really reached its exit point (9), and the outstanding write really failed as a closed pipe.
 */
test("an early child exit fails the request write with EPIPE in the case that wrote it", async () => {
  const probe = spawnProbe("exit-before-read", replayContent(REPLAY_CHARS));
  try {
    // The fixture marks the exit point before leaving, so an arriving mark rules out a child that
    // died on startup, which would be a different failure with its own listener.
    await probe.waitForMark("exiting");
    await probe.closed;

    expect(probe.exitCode()).toBe(9);
    expect(probe.stdinErrors().map(error => error.code)).toContain("EPIPE");
  } finally {
    await reap(probe);
  }
}, 60_000);
