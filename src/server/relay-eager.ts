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

import { buildFailedTailPayload, createSseTerminalOutputBoundary } from "./relay";
import {
  nextSseBlock,
  payloadRewriteAsBlockRewrite,
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
  type SsePayloadRewrite,
} from "./sse-payload-rewrite";
import type { TranslatorBudget } from "../lib/translator-budget";

export type EagerRelayHooks = {
  /** Feed one upstream chunk through SSE inspection (createSseInspector.feed). */
  inspectChunk: (chunk: Uint8Array) => void;
  /**
   * Optional inline client-facing payload rewrite, framed to complete SSE
   * blocks inside the single reader. This is what lets win32 rewrite traffic
   * (image_gen restore, item-id repair) use this relay instead of the
   * Bun#32111-unsafe tee()+JS-pull chain (#864).
   */
  rewritePayload?: SsePayloadRewrite;
  /**
   * Optional block-level rewrite (zero or more blocks out per upstream
   * block) for lifecycle event injection (#893). Takes precedence over
   * rewritePayload when both are set.
   */
  rewriteBlocks?: SseBlockRewrite;
  /** Flush inspection at upstream end (createSseInspector.finish). */
  finishInspection: () => void;
  /** Drop inspector-owned frame/item state during producer teardown. */
  disposeInspection?: () => void;
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
  /** Transient-budget owner for the inline-rewrite frame buffer. */
  rewriteBudget?: TranslatorBudget;
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
  const terminalBoundary = createSseTerminalOutputBoundary();
  const activeRewrite: SseBlockRewrite | undefined = hooks.rewriteBlocks
    ?? (hooks.rewritePayload ? payloadRewriteAsBlockRewrite(hooks.rewritePayload) : undefined);
  const rewriteDecoder = activeRewrite ? new TextDecoder() : null;
  const rewriteEncoder = activeRewrite ? new TextEncoder() : null;
  const rewriteBudget = opts?.rewriteBudget;
  let frameBuffer = "";
  let frameBufferBytes = 0;
  /** Frame complete SSE blocks and rewrite each block's data payload in place. */
  const rewriteOutbound = (value: Uint8Array): Uint8Array => {
    let out = "";
    const fragment = rewriteDecoder!.decode(value, { stream: true });
    if (rewriteBudget) {
      const nextBytes = frameBufferBytes + rewriteEncoder!.encode(fragment).byteLength;
      const reservation = rewriteBudget.reserveTransient(nextBytes, { kind: "live_transient" });
      try {
        frameBuffer += fragment;
        reservation.commitRetained();
        rewriteBudget.releaseRetained(frameBufferBytes, { kind: "live_transient" });
        frameBufferBytes = nextBytes;
      } catch (error) {
        reservation.release();
        throw error;
      }
    } else {
      frameBuffer += fragment;
      frameBufferBytes += value.byteLength;
    }
    for (;;) {
      const next = nextSseBlock(frameBuffer);
      if (!next) break;
      for (const outBlock of activeRewrite!(next.block)) {
        out += outBlock + next.delimiter;
      }
      frameBuffer = next.rest;
    }
    if (rewriteBudget) {
      const remaining = rewriteEncoder!.encode(frameBuffer).byteLength;
      rewriteBudget.releaseRetained(frameBufferBytes - remaining, { kind: "live_transient" });
      frameBufferBytes = remaining;
    } else {
      frameBufferBytes = rewriteEncoder!.encode(frameBuffer).byteLength;
    }
    return rewriteEncoder!.encode(out);
  };
  /** Flush any trailing partial block at upstream end (rewrite applied, matching the pull relay). */
  const flushRewriteTail = (): Uint8Array => {
    if (!activeRewrite) return new Uint8Array(0);
    // Decoder-flushed bytes logically follow everything already decoded.
    let tail = frameBuffer + rewriteDecoder!.decode();
    const rewritten = activeRewrite(tail);
    // Multiple emitted blocks must stay separately framed (#893 review);
    // join places the delimiter only between blocks, never after the last.
    tail = rewritten.join(tail.includes("\r\n") ? "\r\n\r\n" : "\n\n");
    frameBuffer = "";
    if (rewriteBudget && frameBufferBytes > 0) {
      rewriteBudget.releaseRetained(frameBufferBytes, { kind: "live_transient" });
    }
    frameBufferBytes = 0;
    return rewriteEncoder!.encode(tail);
  };
  let queuedBytes = 0;
  let cancelled = false;
  let done = false;
  const terminalSentinel = new TextEncoder().encode("data: [DONE]\n\n");
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
    // implementation's, not the stream's), so abort must break a parked read on
    // a silent upstream. Cancelling the reader does that: the pending read
    // settles and the loop observes the abort. This is deliberately NOT a
    // shared `Promise.race([reader.read(), aborted])` companion — racing every
    // read against one never-settled promise retains a reaction per chunk, and
    // that is the exact retention class relay.ts avoids at its own drain.
    const wakeParkedRead = () => { reader.cancel(upstream.signal.reason).catch(() => {}); };
    if (upstream.signal.aborted) wakeParkedRead();
    else upstream.signal.addEventListener("abort", wakeParkedRead, { once: true });
    try {
      for (;;) {
        const result = await reader.read();
        const { done: upstreamDone, value } = result;
        // A chunk that already settled is INSPECTED before abort is honored. A read
        // can settle with a real chunk in the same tick the signal fires (post-cancel
        // drain: the terminal frame arrives, then the drain timer aborts upstream).
        // Checking the signal first discarded that frame, so the terminal was never
        // recorded and the turn was accounted as a plain cancel.
        if (!upstreamDone && value !== undefined) hooks.inspectChunk(value);
        if (upstream.signal.aborted) break;
        if (upstreamDone) {
          hooks.finishInspection();
          const boundedTail = terminalBoundary.finish();
          if (activeRewrite) {
            const rewritten = rewriteOutbound(boundedTail);
            const tail = joinUint8Arrays(rewritten, flushRewriteTail());
            if (tail.byteLength > 0 && !cancelled) {
              queuedBytes += tail.byteLength;
              try { controllerRef?.enqueue(tail); } catch { /* client already gone */ }
            }
          } else if (boundedTail.byteLength > 0 && !cancelled) {
            queuedBytes += boundedTail.byteLength;
            try { controllerRef?.enqueue(boundedTail); } catch { /* client already gone */ }
          }
          if (!hooks.sawTerminal() && !cancelled && !upstream.signal.aborted) {
            syntheticKind = "incomplete";
          }
          break;
        }
        if (cancelled) {
          // Discard-drain: inspection only, nothing queued. Stop at terminal
          // or when the bounded window expires.
          drainedBytes += value.byteLength;
          if (hooks.sawTerminal() || drainedBytes >= drainBytes || now() >= drainDeadline) {
            break;
          }
          continue;
        }
        const terminalBounded = terminalBoundary.feed(value);
        const outbound = activeRewrite ? rewriteOutbound(terminalBounded) : terminalBounded;
        if (outbound.byteLength > 0) {
          queuedBytes += outbound.byteLength;
          try {
            controllerRef?.enqueue(outbound);
          } catch {
            // Controller already torn down (client went away without cancel()).
            cancelled = true;
            drainDeadline = now() + drainMs;
            armDrainTimer();
            continue;
          }
        }
        if (terminalBoundary.terminalSeen()) {
          // The Responses terminal event ends the turn even when a compatible
          // gateway keeps its HTTP connection alive. Add the conventional
          // sentinel and stop the single-reader relay at that protocol boundary.
          if (!terminalBoundary.doneSeen()) {
            queuedBytes += terminalSentinel.byteLength;
            try { controllerRef?.enqueue(terminalSentinel); } catch { /* client already gone */ }
          }
          reader.cancel("Responses terminal event received").catch(() => {});
          break;
        }
        while (queuedBytes > maxQueueBytes && !cancelled && !upstream.signal.aborted) {
          await paused();
        }
      }
    } catch (err) {
      // Upstream read failure. Distinguish genuine mid-stream reset from
      // abort-driven teardown (shutdown/cancel-expiry) — audit M3.
      if (!hooks.sawTerminal() && !cancelled && !upstream.signal.aborted) {
        // Serializing `err` can run user-defined accessors (Error.message
        // getters, toString) that re-entrantly cancel the client or abort the
        // upstream. Build the tail FIRST, then re-check eligibility before
        // committing to the synthetic terminal (adversarial review blocker).
        const tail = new TextEncoder().encode(
          `\n\nevent: response.failed\ndata: ${buildFailedTailPayload(err)}\n\ndata: [DONE]\n\n`,
        );
        if (!hooks.sawTerminal() && !cancelled && !upstream.signal.aborted) {
          syntheticKind = "failed";
          queuedBytes += tail.byteLength;
          try { controllerRef?.enqueue(tail); } catch { /* client already torn down */ }
          try { controllerRef?.close(); } catch { /* client already torn down */ }
        }
      }
    } finally {
      // Release any retained rewrite-buffer bytes on every teardown path
      // (error, cancel, upstream abort) — consumption/EOF release alone
      // leaves them charged.
      if (rewriteBudget && frameBufferBytes > 0) {
        try { rewriteBudget.releaseRetained(frameBufferBytes, { kind: "live_transient" }); } catch { /* teardown must not throw */ }
        frameBufferBytes = 0;
      }
      terminalBoundary.dispose();
      if (syntheticKind) hooks.onSynthetic(syntheticKind);
      if (cancelled && !hooks.sawTerminal()) {
        hooks.onClientCancel();
      }
      if (cancelled || upstream.signal.aborted || syntheticKind === "failed") {
        upstream.abort();
        reader.cancel().catch(() => {});
      }
      if (!cancelled) {
        try { controllerRef?.close(); } catch { /* already closed/errored */ }
      }
      try { hooks.disposeInspection?.(); } catch { /* inspection teardown must not block lifecycle cleanup */ }
      try { activeRewrite?.dispose?.(); } catch { /* rewrite teardown must not block lifecycle cleanup */ }
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

function joinUint8Arrays(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.byteLength === 0) return second;
  if (second.byteLength === 0) return first;
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first);
  joined.set(second, first.byteLength);
  return joined;
}
