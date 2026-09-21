/**
 * An SSE upstream body that resets mid-stream on demand, where the reset is raised somewhere
 * the stream itself observes rather than somewhere nothing is listening (#5073).
 *
 * The direct way to write this fixture is to leak the stream's controller out of `start()`
 * and call `controller.error()` from the test body. That is what
 * `tests/server/server-auth.test.ts` did, and under load the fixture's own error escaped as
 * an unhandled error instead of being delivered to the code under test, failing the whole
 * file on four unrelated heads (#4989, #5024, `dev` at ecd3adae75, #5085).
 *
 * The reason is that a leaked controller can be errored at a moment of the test's choosing,
 * which is not necessarily a moment when anything is reading. Between the server sink's
 * reads there is no pending read request to reject, so the rejection's only subscriber is
 * whatever the runtime attaches next — and on a busy runner the unhandled-rejection report
 * can win that race. The test cannot see or control that window from outside the stream.
 *
 * So the reset is raised from inside `pull()` instead. Two properties come from that, and
 * they are worth separating because only the first one is absolute:
 *
 * The pull algorithm's promise is always observed. `CallPullIfNeeded` attaches its own
 * rejection handler and routes the failure into `ReadableStreamDefaultControllerError`, so a
 * throw from `pull()` cannot be an orphaned rejection whatever the consumer is doing. That is
 * the guarantee this fixture rests on.
 *
 * `highWaterMark: 0` then keeps the reset in a faithful place. The queue is never stocked
 * ahead of demand, so `shouldCallPull` is true only while a read request is outstanding, and
 * `pull()` runs if and only if a consumer has asked for the next chunk. The stream is never
 * errored before anything has attached to it, which is the state where the error has nowhere
 * to go. It is not a promise that a read request is still pending at the instant of the
 * throw — a consumer that cancels in between removes its own request — only that the error is
 * raised in response to demand and is consumed by the stream either way.
 *
 * The enqueued opening chunks are unaffected: `enqueue()` ignores the high-water mark, and the
 * first read is still served from the queue.
 *
 * What the code under test sees is unchanged: one SSE chunk, then a mid-stream body error.
 */

/** The reset every body from this helper raises, so assertions can name it. */
export const DEFERRED_RESET_MESSAGE = "fixture upstream connection reset";

export type DeferredResetSseUpstream = {
  /** A fresh body for one upstream attempt; a retried dispatch gets its own stream. */
  response: (init?: ResponseInit) => Response;
  /** Reset every body this helper has handed out, and every later one. */
  reset: () => void;
};

/**
 * Build an SSE upstream that emits `chunks` and then resets when `reset()` is called.
 *
 * `reset()` is idempotent and order-independent: calling it before the first attempt is
 * dispatched arms the reset for that attempt rather than losing it.
 */
export function deferredResetSseUpstream(...chunks: string[]): DeferredResetSseUpstream {
  const encoder = new TextEncoder();
  const requested = Promise.withResolvers<void>();
  return {
    reset: () => requested.resolve(),
    response: (init = { headers: { "content-type": "text/event-stream" } }) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        },
        async pull() {
          await requested.promise;
          throw new Error(DEFERRED_RESET_MESSAGE);
        },
      }, { highWaterMark: 0 }),
      init,
    ),
  };
}
