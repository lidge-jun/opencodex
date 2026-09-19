import { cpus, release } from "node:os";

/**
 * Monotonic phase timing for the cases in issue #4997.
 *
 * Those cases exceed their own budgets only when the suite runs unsharded, and pass in the
 * sharded lanes running the same files. Three control dispatches produced three DISJOINT failing
 * sets, so the shared factor is elapsed time in a process holding 1367 files rather than any one
 * subsystem. A single per-test duration cannot separate the possibilities that implies: cold
 * fixture setup, a wait the assertion actually needs, slow contended execution, and a teardown
 * still reaping a child all arrive as one number.
 *
 * This splits that number. `prepare` is everything done before the contract is observable,
 * `execute` is the part the assertion is about, and `teardown` is release plus child reap. A
 * reader comparing a control log against a sharded log can then say WHICH phase grew, which is
 * the question every disposition in that issue is blocked on.
 *
 * ## Why it also ticks
 *
 * A budget overrun kills the test, so the closing line of the phase that overran is exactly the
 * line that never prints. With nothing emitted DURING a phase, an overrun and a wedge are the
 * same observation: a log that stops mid-phase. So an open phase emits progress ticks on an
 * exponential schedule, and each tick reports whether the case's own progress counter moved since
 * the previous one. A truncated record ending in `moving=yes` is slow execution under contention;
 * one ending in `moving=no` is a stall with no work happening. Those are different defects and
 * the per-test duration cannot tell them apart.
 *
 * ## What it does not collect
 *
 * Runtime and host identity only. A control lane and a shard differ in load rather than in
 * configuration, so an environment dump would be noise that still has to be audited; `privacy:scan`
 * reads this tree, and a diagnostic needing redaction is one nobody will leave enabled.
 *
 * ## Reading it
 *
 * The job log is the only channel the `macos control` lane has: `.github/workflows/ci.yml` tees
 * the suite and uploads no artifact. Grep a job log for `[test-phase]`.
 *
 * `at` is milliseconds since process start from `performance.now()`, monotonic and unaffected by a
 * clock step, matching the timing convention already used across this suite. It doubles as
 * position-in-run: sorting every emitted line by `at` recovers the order the runner selected these
 * cases in, so no file has to restate an ordering it would then have to keep correct.
 */

/** One prefix for the whole record, so a single grep over a job log finds all of it. */
const TAG = "[test-phase]";

/** First tick delay; each later gap doubles until it reaches TICK_MAX_MS. */
const TICK_FIRST_MS = 1_000;
const TICK_MAX_MS = 15_000;

/**
 * How long one phase may keep reporting. The bound matters because a phase killed by a test
 * timeout never closes, and `unref` keeps the process from being held open without cancelling
 * anything, so an unbounded chain would outlive its case and write into an unrelated part of the
 * log. Two minutes is past every budget in #4997, the largest of which is 60s, and ends long
 * before the job does.
 */
const TICK_WINDOW_MS = 120_000;

let envEmitted = false;
let seq = 0;

function emit(fields: string[]): void {
  console.info([TAG, ...fields].join(" "));
}

/** Milliseconds since process start, monotonic, to a tenth of a millisecond. */
function nowMs(): string {
  return performance.now().toFixed(1);
}

/**
 * Runtime and host, once per isolate. `bun test --isolate` reclaims the realm at file boundaries,
 * so this runs once per instrumented file rather than once per process, which is what makes it
 * usable as a per-file anchor when lines from several files interleave in one log.
 */
function emitEnvOnce(): void {
  if (envEmitted) return;
  envEmitted = true;
  emit([
    "env",
    "bun=" + Bun.version,
    "platform=" + process.platform,
    "release=" + release(),
    "arch=" + process.arch,
    "cpus=" + cpus().length,
    "pid=" + process.pid,
  ]);
}

/**
 * A tick fires from the event loop while the case is parked on an `await`, so the case itself
 * cannot push a count at that moment. A probe is therefore the only way a tick can observe work
 * that is happening inside the awaited call: give it something externally readable and monotonic,
 * such as the normalizer's encode counter, and a frozen reading becomes evidence of a stall rather
 * than of the test simply not being scheduled.
 */
export type ProgressProbe = () => number;

export interface PhaseTimer {
  /**
   * Run `fn` as a named phase. The opening line is emitted before `fn` starts, so a phase that
   * never returns still appears in the log with the ticks that followed it.
   */
  phase<T>(name: string, fn: () => T): Promise<Awaited<T>>;
  /**
   * Close the open segment and start a named one. For a long linear case body, where wrapping
   * each part in a closure would re-indent hundreds of lines of assertions and bury the real
   * change, this marks the same boundaries in place.
   */
  split(name: string): void;
  /** Close the open segment without starting another. Safe to call when none is open. */
  end(): void;
  /** Advance the built-in counter. Ignored when a probe was supplied. */
  progress(): void;
}

/**
 * Instrument one case. `label` should identify the case well enough to grep on its own, because
 * these lines land in a log holding 26k other tests.
 */
export function phaseTimer(label: string, probe?: ProgressProbe): PhaseTimer {
  emitEnvOnce();
  const base = ["case=" + JSON.stringify(label), "seq=" + seq++];
  let progressCount = 0;
  const read = (): number => {
    if (probe === undefined) return progressCount;
    // A probe reaches into the code under test, so a throw here must never become the case's
    // failure: the diagnostic reports what it can see and the assertion keeps its own verdict.
    try { return probe(); } catch { return -1; }
  };

  /** Open a named segment and return the function that closes it. */
  const open = (name: string): (() => void) => {
    const startedAt = performance.now();
    const openMs = (): string => (performance.now() - startedAt).toFixed(1);
    emit([...base, "phase=" + name, "state=start", "at=" + nowMs()]);

    let gap = TICK_FIRST_MS;
    let seenAtLastTick = read();
    let handle: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const scheduleTick = (): void => {
      if (closed || performance.now() - startedAt >= TICK_WINDOW_MS) return;
      handle = setTimeout(() => {
        if (closed) return;
        const seen = read();
        const moved = seen !== seenAtLastTick;
        seenAtLastTick = seen;
        emit([
          ...base,
          "phase=" + name,
          "state=tick",
          "at=" + nowMs(),
          "openMs=" + openMs(),
          "progress=" + seen,
          "moving=" + (moved ? "yes" : "no"),
        ]);
        gap = Math.min(gap * 2, TICK_MAX_MS);
        scheduleTick();
      }, gap);
      // A diagnostic must never be the reason a process stays alive.
      (handle as unknown as { unref?: () => void }).unref?.();
    };
    scheduleTick();

    return () => {
      if (closed) return;
      closed = true;
      if (handle !== undefined) clearTimeout(handle);
      emit([
        ...base,
        "phase=" + name,
        "state=end",
        "at=" + nowMs(),
        "durMs=" + openMs(),
        "progress=" + read(),
      ]);
    };
  };

  let closeCurrent: (() => void) | undefined;
  const end = (): void => {
    closeCurrent?.();
    closeCurrent = undefined;
  };

  return {
    async phase<T>(name: string, fn: () => T): Promise<Awaited<T>> {
      const close = open(name);
      try {
        return await fn();
      } finally {
        close();
      }
    },
    split(name: string): void {
      end();
      closeCurrent = open(name);
    },
    end,
    progress: () => { progressCount += 1; },
  };
}
