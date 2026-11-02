const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Keep a worker alive until its synchronous installer and recovery finish. */
export function protectOrchestratedWorkerSignals() {
  for (const signal of process.platform === "win32" ? SIGNALS.slice(0, 2) : SIGNALS) process.on(signal, () => {});
}

/** Forward catchable signals and require a close event within 60 seconds after interruption. */
export function waitForOrchestratedChild(child, options = {}) {
  const signals = options.signals ?? process;
  const startTimer = options.setTimer ?? setTimeout;
  const stopTimer = options.clearTimer ?? clearTimeout;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise(resolve => {
    let timer;
    let overrunTimer;
    let settled = false;
    const handlers = new Map();
    const cleanupSignals = () => {
      for (const [signal, handler] of handlers) signals.removeListener(signal, handler);
      if (timer !== undefined) stopTimer(timer);
      if (overrunTimer !== undefined) stopTimer(overrunTimer);
    };
    const onClose = (code, signal) => {
      child.removeListener("error", onError);
      if (settled) return;
      settled = true;
      cleanupSignals();
      resolve({ confirmed: true, code, signal });
    };
    const armTimer = () => {
      if (timer !== undefined) return;
      timer = startTimer(() => {
        if (settled) return;
        settled = true;
        cleanupSignals();
        // Keep the child listeners until close: a late error must not become unhandled.
        resolve({ confirmed: false, code: null, signal: null });
      }, timeoutMs);
    };
    const onError = () => armTimer();
    child.once("close", onClose);
    child.on("error", onError);
    for (const signal of SIGNALS) {
      const handler = () => {
        armTimer();
        try { child.kill(signal); } catch { /* Wait for close or return uncertainty. */ }
      };
      handlers.set(signal, handler);
      signals.on(signal, handler);
    }
    if (options.overrunMs !== undefined) {
      let remaining = Math.max(0, options.overrunMs);
      const schedule = () => {
        const delay = Math.min(remaining, 2_147_483_647);
        overrunTimer = startTimer(() => {
          if (settled) return;
          remaining -= delay;
          if (remaining > 0) { schedule(); return; }
          settled = true;
          cleanupSignals();
          // Do not signal a transaction in progress. The caller must detach its
          // handles and leave the child's in-flight marker intact.
          resolve({ confirmed: false, code: null, signal: null, reason: "overrun" });
        }, delay);
      };
      schedule();
    }
  });
}
