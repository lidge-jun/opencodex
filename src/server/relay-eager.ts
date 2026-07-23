/**
 * Eager bounded single-reader SSE relay (#314 mitigation, WP2).
 *
 * Replaces the tee()+background-inspection passthrough shape on runtimes where
 * the Bun#32111 async-pull cancel fix is present (src/lib/bun-stream-caps.ts):
 * ONE eager producer loop reads upstream, feeds every chunk through the shared
 * SSE inspector (terminal outcome, quota, request log, context cache), and
 * enqueues it into a byte-bounded client queue. When the queue is full the
 * producer pauses — no unbounded tee branch queue can build up behind a slow
 * client.
 *
 * Honesty caveats (audit M5): full leak relief additionally assumes the
 * runtime carries the Bun#29831 fetch receive-backpressure fix and that Bun's
 * native Response sink pull-paces a JS ReadableStream. Neither is provable in
 * bun:test (a JS reader always paces); both remain "awaiting Windows user
 * verification".
 *
 * #44 cancel semantics: after client cancel the relay keeps reading upstream in
 * DISCARD-DRAIN mode (inspection only) until a terminal is seen or the bounded
 * drain window (ms/bytes) expires — a genuinely reached terminal records as
 * completed/failed, never downgraded to cancel. Only when no terminal arrives
 * within bounds does onClientCancel fire. This bounds today's unbounded tee
 * drain; the tradeoff is that client-cancel log finalization may be delayed by
 * up to the drain window.
 */

export type EagerRelayHooks = {
  /** Feed one upstream chunk through SSE inspection (createSseInspector.feed). */
  inspectChunk: (chunk: Uint8Array) => void;
  /** Flush inspection at upstream end (createSseInspector.finish). */
  finishInspection: () => void;
  /** True once inspection has reported a protocol terminal (inspector.reported). */
  sawTerminal: () => boolean;
  /** Record a synthetic terminal (caller decides incomplete vs failed-502). */
  onSynthetic: (kind: "incomplete" | "failed") => void;
  /** Client cancelled and NO terminal arrived within the drain bounds. */
  onClientCancel: () => void;
  /** Exactly once, after the producer fully stops (unregisterTurn parity). */
  onDone: () => void;
};

export type EagerRelayOptions = {
  /** Bounded client queue in bytes; producer pauses above it. Default 8 MiB. */
  maxQueueBytes?: number;
  /** Post-cancel discard-drain wall-clock bound. Default 15 000 ms. */
  postCancelDrainMs?: number;
  /** Post-cancel discard-drain byte bound. Default 32 MiB. */
  postCancelDrainBytes?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_DRAIN_MS = 15_000;
const DEFAULT_DRAIN_BYTES = 32 * 1024 * 1024;

/**
 * Relay `body` to the returned stream with eager bounded reading and inline
 * inspection. `upstream` is aborted on cancel-drain expiry and observed for
 * shutdown teardown (its abort wakes a paused producer and suppresses
 * synthetic terminals — audit M3).
 */
export function relaySseEagerBounded(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
  hooks: EagerRelayHooks,
  opts?: EagerRelayOptions,
): ReadableStream<Uint8Array> {
  const maxQueueBytes = opts?.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
  const drainMs = opts?.postCancelDrainMs ?? DEFAULT_DRAIN_MS;
  const drainBytes = opts?.postCancelDrainBytes ?? DEFAULT_DRAIN_BYTES;
  const now = opts?.now ?? Date.now;

  const reader = body.getReader();
  let queuedBytes = 0;
  let cancelled = false;
  let done = false;
  // Pause gate: resolved by client pull, client cancel, or upstream abort so a
  // paused producer ALWAYS resumes (audit blocker 2 — no deadlock; onDone and
  // turn unregistration stay reachable, drainAndShutdown never hangs).
  let wake: (() => void) | null = null;
  const wakeUp = () => { const w = wake; wake = null; w?.(); };
  const paused = () => new Promise<void>(resolve => { wake = resolve; });
  upstream.signal.addEventListener("abort", wakeUp, { once: true });

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let doneFired = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const fireDone = () => {
    if (doneFired) return;
    doneFired = true;
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    try { hooks.onDone(); } catch { /* lifecycle callbacks must not break teardown */ }
  };
  // A silent upstream after cancel would park the drain loop in reader.read();
  // the wall-clock bound must fire regardless, so cancel arms a hard timer that
  // aborts upstream at the deadline (the abort wakes the read).
  const armDrainTimer = () => {
    if (drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      upstream.abort(new Error("post-cancel drain window expired"));
    }, drainMs);
    (drainTimer as { unref?: () => void }).unref?.();
  };

  const producer = async () => {
    let syntheticKind: "incomplete" | "failed" | null = null;
    // reader.read() is not intrinsically tied to the upstream AbortController
    // (a fetch body usually rejects on abort, but that coupling is the fetch
    // implementation's, not the stream's). Race every read against the abort
    // signal so cancel-drain expiry and shutdown teardown ALWAYS break the
    // loop even on a silent upstream.
    const aborted: Promise<"aborted"> = new Promise(resolve => {
      if (upstream.signal.aborted) resolve("aborted");
      else upstream.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    try {
      for (;;) {
        const result = await Promise.race([reader.read(), aborted]);
        if (result === "aborted") break;
        const { done: upstreamDone, value } = result;
        if (upstreamDone) {
          hooks.finishInspection();
          if (!hooks.sawTerminal() && !cancelled && !upstream.signal.aborted) {
            syntheticKind = "incomplete";
          }
          break;
        }
        hooks.inspectChunk(value);
        if (cancelled) {
          // Discard-drain: inspection only, nothing queued. Stop at terminal
          // or when the bounded window expires.
          drainedBytes += value.byteLength;
          if (hooks.sawTerminal() || drainedBytes >= drainBytes || now() >= drainDeadline) {
            break;
          }
          continue;
        }
        queuedBytes += value.byteLength;
        try {
          controllerRef?.enqueue(value);
        } catch {
          // Controller already torn down (client went away without cancel()).
          cancelled = true;
          drainDeadline = now() + drainMs;
          armDrainTimer();
          continue;
        }
        while (queuedBytes > maxQueueBytes && !cancelled && !upstream.signal.aborted) {
          await paused();
        }
      }
    } catch {
      // Upstream read failure. Distinguish genuine mid-stream reset from
      // abort-driven teardown (shutdown/cancel-expiry) — audit M3.
      if (!hooks.sawTerminal() && !cancelled && !upstream.signal.aborted) {
        syntheticKind = "failed";
        try { controllerRef?.error(new Error("upstream stream failed")); } catch { /* torn down */ }
      }
    } finally {
      if (syntheticKind) hooks.onSynthetic(syntheticKind);
      if (cancelled && !hooks.sawTerminal()) {
        hooks.onClientCancel();
      }
      if (cancelled || upstream.signal.aborted) {
        upstream.abort();
        reader.cancel().catch(() => {});
      }
      if (!cancelled) {
        try { controllerRef?.close(); } catch { /* already closed/errored */ }
      }
      fireDone();
    }
  };

  let drainedBytes = 0;
  let drainDeadline = Number.POSITIVE_INFINITY;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      void producer();
    },
    pull() {
      // The client consumed from the queue; approximate accounting: reset on
      // pull below cap. desiredSize reflects internal queue in chunks, not
      // bytes, so we track bytes ourselves and drain optimistically.
      queuedBytes = 0;
      wakeUp();
    },
    cancel() {
      cancelled = true;
      drainDeadline = now() + drainMs;
      armDrainTimer();
      wakeUp();
    },
  });
}
