/** A fetch-shaped SSE body: aborting the request also settles its pending body
 * read. Throw inside pull so the stream observes the rejection, including when
 * cancellation races it; an escaped controller.error can become an orphan. */
export function abortableSseUpstream(
  chunk: string,
  signal: AbortSignal | null | undefined,
  onAbort: () => void,
): Response {
  const aborted = Promise.withResolvers<void>();
  const abort = () => { onAbort(); aborted.resolve(); };
  const dispose = () => signal?.removeEventListener("abort", abort);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(chunk)); },
    async pull() {
      await aborted.promise;
      dispose();
      throw signal?.reason ?? new DOMException("fixture upstream aborted", "AbortError");
    },
    cancel() { dispose(); abort(); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
