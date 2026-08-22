/**
 * Shared visibility-aware interval for the dashboard's raw pollers.
 *
 * The client-resource layer already suspends its store timers while hidden; raw
 * setInterval pollers (log viewers, settings cards, OAuth status) hand-rolled the
 * same pattern nine different ways — most without any visibility handling, so a
 * background tab kept paying full poll cost. This helper is the one place that
 * owns the rule: while document.hidden there is no interval and no callback; on
 * visible-again one make-up tick fires immediately, then the cadence resumes.
 */

export type VisibilityPollOptions = {
  /**
   * Default true: hidden tabs neither tick nor hold a timer. Set false only for
   * polls whose whole purpose is noticing something happening off-screen (a
   * restarted server answering, for instance).
   */
  pauseWhenHidden?: boolean;
  /** Fire the callback once on start. Default false. */
  immediate?: boolean;
};

function hiddenNow(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Schedule through `window` when it exists. Every migrated poller used
 * `window.setInterval`, and their tests intercept it there — the bare global binds
 * to a different timer scope than the code this helper replaced, which both hides
 * the poll from that instrumentation and changes its lifetime semantics.
 */
function scheduleInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    return window.setInterval(fn, ms) as unknown as ReturnType<typeof setInterval>;
  }
  return setInterval(fn, ms);
}

function cancelInterval(handle: ReturnType<typeof setInterval>): void {
  if (typeof window !== "undefined" && typeof window.clearInterval === "function") {
    window.clearInterval(handle as unknown as number);
    return;
  }
  clearInterval(handle);
}

/**
 * Start an interval that exists only while the tab is visible (unless opted out).
 * Returns stop(), which removes the timer and the visibility listener in any state.
 */
export function startVisibilityPoll(
  callback: () => void,
  intervalMs: number,
  options?: VisibilityPollOptions,
): () => void {
  const pauseWhenHidden = options?.pauseWhenHidden !== false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // A synchronously throwing callback must not kill the poll: without the guard a
  // make-up tick that throws would skip arm() and never tick again.
  const tick = () => {
    try {
      callback();
    } catch (error) {
      console.error("[visibility-poll]", error);
    }
  };

  const arm = () => {
    if (timer !== null || stopped) return;
    timer = scheduleInterval(tick, intervalMs);
  };
  const disarm = () => {
    if (timer === null) return;
    cancelInterval(timer);
    timer = null;
  };

  const onVisibility = () => {
    if (!pauseWhenHidden) return;
    if (hiddenNow()) {
      disarm();
      return;
    }
    // Make-up tick: the user comes back to fresh data immediately, then cadence.
    tick();
    arm();
  };

  if (pauseWhenHidden && hiddenNow()) {
    // Mounted while already hidden: no timer, but the listener must still be there
    // or nothing would ever resume this poll.
  } else {
    arm();
  }
  if (pauseWhenHidden && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  if (options?.immediate) tick();

  return () => {
    stopped = true;
    disarm();
    if (pauseWhenHidden && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}
