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
  SUBPROCESS_KILL_GRACE_MS,
  waitForSubprocessExit,
  type KillableSubprocess,
} from "../../src/lib/bounded-subprocess";

const DEADLINE_MS = 10;
const GRACE_MS = 40;

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

/** Resolve once the pending promise settles, or report that it is still pending. */
async function raceSettled<T>(promise: Promise<T>, afterMs: number): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), afterMs)),
  ]);
}

describe("waitForSubprocessExit", () => {
  test("a child that exits before the deadline is never killed", async () => {
    const proc = fakeSubprocess();
    const pending = waitForSubprocessExit(proc, 10_000, GRACE_MS);
    proc.settle(0);
    expect(await pending).toEqual({ exitCode: 0, timedOut: false });
    expect(proc.killCount()).toBe(0);
    expect(proc.unrefCount()).toBe(0);
  });

  test("a nonzero exit before the deadline is reported, not treated as a timeout", async () => {
    const proc = fakeSubprocess();
    const pending = waitForSubprocessExit(proc, 10_000, GRACE_MS);
    proc.settle(5);
    expect(await pending).toEqual({ exitCode: 5, timedOut: false });
  });

  test("the deadline kills the child and then WAITS for it to actually die", async () => {
    // The regression. Before this, the promise resolved in the same tick as kill().
    const proc = fakeSubprocess();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, GRACE_MS);

    expect(await raceSettled(pending, DEADLINE_MS * 3)).toBe("pending");
    expect(proc.killCount()).toBe(1);
    // Still held: abandoning is the fallback, not the first move.
    expect(proc.unrefCount()).toBe(0);

    proc.settle(1);
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
    // Reaped within the grace, so it was never abandoned.
    expect(proc.unrefCount()).toBe(0);
  });

  test("a child that dies during the grace is still classified as timed out", async () => {
    // The caller's classification must not move: it DID miss its deadline. Only the moment of
    // resolution changes, and `hardenSecretPath` keys its ETIMEDOUT memo on exactly this flag.
    const proc = fakeSubprocess();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, GRACE_MS);
    await new Promise(resolve => setTimeout(resolve, DEADLINE_MS * 2));
    proc.settle(0);
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
  });

  test("a child that outlives its own kill is abandoned, bounded by the grace", async () => {
    const proc = fakeSubprocess();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, GRACE_MS);
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
    expect(proc.killCount()).toBe(1);
    expect(proc.unrefCount()).toBe(1);
  });

  test("a rejected exit before the deadline is not a timeout", async () => {
    const proc = fakeSubprocess();
    const pending = waitForSubprocessExit(proc, 10_000, GRACE_MS);
    proc.fail(new Error("spawn lost"));
    expect(await pending).toEqual({ exitCode: null, timedOut: false });
  });

  test("a rejected exit after the deadline stays a timeout", async () => {
    const proc = fakeSubprocess();
    const pending = waitForSubprocessExit(proc, DEADLINE_MS, GRACE_MS);
    await new Promise(resolve => setTimeout(resolve, DEADLINE_MS * 2));
    proc.fail(new Error("already gone"));
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
  });

  test("the default grace is long enough to be a real wait, and short enough to be bounded", () => {
    // A grace under a few hundred milliseconds would not survive a loaded Windows runner, which is
    // the only environment where this has ever mattered; one over a few seconds would turn a hung
    // icacls into a hung shutdown, which is what abandonment exists to prevent.
    expect(SUBPROCESS_KILL_GRACE_MS).toBeGreaterThanOrEqual(500);
    expect(SUBPROCESS_KILL_GRACE_MS).toBeLessThanOrEqual(5_000);
  });

  test("a subprocess without unref is abandoned without throwing", async () => {
    const base = fakeSubprocess();
    const withoutUnref: KillableSubprocess = { exited: base.exited, kill: base.kill };
    expect(await waitForSubprocessExit(withoutUnref, DEADLINE_MS, GRACE_MS))
      .toEqual({ exitCode: null, timedOut: true });
  });
});
