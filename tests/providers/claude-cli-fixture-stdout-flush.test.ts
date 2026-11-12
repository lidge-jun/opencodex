import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readJsonLines } from "../../src/adapters/coding-agent/protocol";
import { fixturePath } from "../helpers/repo-root";

/**
 * The owned Claude CLI fixture answers the synthetic image replay with one JSONL frame whose text
 * is the whole replayed conversation. That frame exceeds what a pipe buffers, which is the shape
 * the fixture's original bug needed: it wrote the frame and then called `process.exit(0)`, and
 * `process.exit` terminates without draining stdout, so the tail of the frame was discarded and the
 * reader saw a malformed frame.
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
 *    the production reader, with a zero exit. This is the case that fails when only the production
 *    write-and-exit is reverted.
 *  - A blocked write is *observed*, not inferred from payload size. The fixture reports, in the
 *    write's own tick and again after one loop turn, whether the runtime accepted the bytes and
 *    whether the completion callback has run. With stdout deliberately unread a multi-megabyte
 *    write has neither; a control measured inside the portable pipe bound has both.
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
 * The control must fit *every* platform's pipe, so it is measured against the portable floor rather
 * than a number that happens to work here. POSIX guarantees only PIPE_BUF = 512 bytes for a write
 * that completes without blocking; a larger payload can block on a platform with a smaller buffer,
 * which would silently turn the control into a second copy of the case it contrasts with. The
 * fixture reports the byte count it actually wrote, and the control asserts against that rather
 * than against a character count.
 */
const PIPE_ATOMIC_MAX_BYTES = 512;
/** Frame overhead is fixed, so this many characters stays well inside that bound. */
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
  return {
    child,
    closed: done,
    isClosed: () => closed,
    exitCode: () => code ?? child.exitCode,
    spawnError: () => spawnError,
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

    // The payload really did exceed any pipe: this is the child's own byte count, not the test's.
    expect(returned.bytes as number).toBeGreaterThan(PIPE_ATOMIC_MAX_BYTES * 1000);
    // The runtime queued the bytes rather than accepting them, and one loop turn later the write's
    // own callback still has not run. Both are the child's state; neither is inferred from size.
    expect(returned.accepted).toBe(false);
    expect(turn.settled).toBe(false);
  } finally {
    await reap(probe);
  }
}, 60_000);

test("a payload inside the portable pipe bound settles with no reader, so the pending write is capacity", async () => {
  const probe = spawnProbe("observe", replayContent(CONTROL_CHARS));
  try {
    const returned = await probe.waitForMark("replay-returned");
    const turn = await probe.waitForMark("replay-turn");
    const settled = await probe.waitForMark("replay-settled");

    // The control is only a control if it is inside the bound every platform guarantees. The byte
    // count comes from the fixture, so a framing change cannot quietly push it past the floor.
    expect(returned.bytes as number).toBeLessThanOrEqual(PIPE_ATOMIC_MAX_BYTES);
    // Same statements, same code path, same absent reader. Only the byte count changed, so the
    // difference from the case above is pipe capacity: accepted, and settled within one turn.
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

    // The write is megabytes against a pipe nobody is draining, so it must be queued rather than
    // accepted whole. That is asserted, not assumed: it is the precondition for the failure below
    // coming from the pipe closing rather than the write having already finished.
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
