/**
 * `waitForSubprocessExit` must not call a child dead before it is.
 *
 * The helper used to kill at the deadline and resolve in the same tick. Every caller then
 * believed it had waited for its child, which is the guarantee `flushConfigDirHardening` is built
 * on -- shutdown owning every `icacls.exe` it started. On Windows the handle an abandoned child
 * holds keeps a directory unremovable, so the caller proceeded to remove a tree that was still
 * locked and got EPERM. Three separate fixes aimed at the removal retry instead (#4789 raised the
 * budget, #4796 made it exponential over 15s, a later change awaited the hardening flight) and all
 * three failed identically on Windows shard 1/6, because none of them made the child exit.
 *
 * These cases use a fake subprocess rather than a real one on purpose: the contract is about WHEN
 * the promise resolves relative to the child's death, and that is observable without spawning
 * anything, on every platform, deterministically.
 */
import { describe, expect, test } from "bun:test";
import {
  flushRequiredSubprocessReapsForTests,
  waitForSubprocessExit,
  type KillableSubprocess,
} from "../../src/lib/bounded-subprocess";

const DEADLINE_MS = 10;
const REAP_REQUIRED = 1;

interface FakeSubprocess extends KillableSubprocess {
  readonly killCount: () => number;
  readonly unrefCount: () => number;
  readonly settle: (exitCode: number) => void;
  readonly fail: (reason: Error) => void;
}

function fakeSubprocess(): FakeSubprocess {
  let kills = 0;
  let unrefs = 0;
  let settleExited: (code: number) => void = () => {};
  let failExited: (reason: Error) => void = () => {};
  const exited = new Promise<number>((resolve, reject) => {
    settleExited = resolve;
    failExited = reject;
  });
  // An unobserved rejection here would fail the file rather than the assertion under test.
  void exited.catch(() => {});
  return {
    exited,
    kill: () => { kills += 1; },
    unref: () => { unrefs += 1; },
    killCount: () => kills,
    unrefCount: () => unrefs,
    settle: code => settleExited(code),
    fail: reason => failExited(reason),
  };
}

function manualDeadline() {
  let callback: (() => void) | undefined;
  let cancelled = false;
  return {
    schedule(next: () => void): () => void {
      callback = next;
      return () => { cancelled = true; };
    },
    fire(): void {
      if (!callback) throw new Error("deadline was not scheduled");
      callback();
    },
    cancelled: () => cancelled,
  };
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  return settled;
}

describe("waitForSubprocessExit", () => {
  test("a child that exits before the deadline is never killed", async () => {
    const proc = fakeSubprocess();
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(proc, 10_000, REAP_REQUIRED, deadline.schedule);
    proc.settle(0);
    expect(await pending).toEqual({ exitCode: 0, timedOut: false });
    expect(proc.killCount()).toBe(0);
    expect(proc.unrefCount()).toBe(0);
    expect(deadline.cancelled()).toBe(true);
  });

  test("a nonzero exit before the deadline is reported, not treated as a timeout", async () => {
    const proc = fakeSubprocess();
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(proc, 10_000, REAP_REQUIRED, deadline.schedule);
    proc.settle(5);
    expect(await pending).toEqual({ exitCode: 5, timedOut: false });
  });

  test("the deadline kills the child and then WAITS for it to actually die", async () => {
    // The regression. Before this, the promise resolved in the same tick as kill().
    const proc = fakeSubprocess();
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, REAP_REQUIRED, deadline.schedule);

    deadline.fire();
    expect(await promiseSettled(pending)).toBe(false);
    expect(proc.killCount()).toBe(1);
    expect(proc.unrefCount()).toBe(0);

    proc.settle(1);
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
    expect(proc.unrefCount()).toBe(0);
  });

  test("a child that dies after the deadline is still classified as timed out", async () => {
    // The caller's classification must not move: it DID miss its deadline. Only the moment of
    // resolution changes, and `hardenSecretPath` keys its ETIMEDOUT memo on exactly this flag.
    const proc = fakeSubprocess();
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, REAP_REQUIRED, deadline.schedule);
    deadline.fire();
    proc.settle(0);
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
  });

  test("a child that outlives its kill keeps both the caller and teardown drain pending", async () => {
    const proc = fakeSubprocess();
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, REAP_REQUIRED, deadline.schedule);
    deadline.fire();
    const drain = flushRequiredSubprocessReapsForTests();

    expect(await promiseSettled(pending)).toBe(false);
    expect(await promiseSettled(drain)).toBe(false);
    expect(proc.killCount()).toBe(1);
    expect(proc.unrefCount()).toBe(0);

    proc.settle(1);
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
    await drain;
  });

  test("a rejected exit before the deadline is not a timeout", async () => {
    const proc = fakeSubprocess();
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(proc, 10_000, REAP_REQUIRED, deadline.schedule);
    proc.fail(new Error("spawn lost"));
    expect(await pending).toEqual({ exitCode: null, timedOut: false });
  });

  test("a rejected exit after the deadline stays a timeout", async () => {
    const proc = fakeSubprocess();
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, REAP_REQUIRED, deadline.schedule);
    deadline.fire();
    proc.fail(new Error("already gone"));
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
  });

  test("a subprocess without unref is still reaped", async () => {
    const base = fakeSubprocess();
    const withoutUnref: KillableSubprocess = { exited: base.exited, kill: base.kill };
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(
      withoutUnref,
      DEADLINE_MS,
      REAP_REQUIRED,
      deadline.schedule,
    );
    deadline.fire();
    expect(await promiseSettled(pending)).toBe(false);
    base.settle(1);
    expect(await pending)
      .toEqual({ exitCode: null, timedOut: true });
  });

  test("a zero grace opts out and abandons in the same tick as the kill", async () => {
    // The grace buys one thing: a handle released before somebody removes the path holding it.
    // A caller whose child holds no such path should not pay for it, and `windows-user-principal`
    // is that caller -- its PowerShell lookup runs during `ocx start`, where the composed
    // acceptance cases measure real startups at up to 38.8s against a bounded watchdog.
    const proc = fakeSubprocess();
    const deadline = manualDeadline();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, 0, deadline.schedule);
    deadline.fire();
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
    expect(proc.killCount()).toBe(1);
    // Abandoned immediately rather than after a grace it was told not to take.
    expect(proc.unrefCount()).toBe(1);
  });
});
