/**
 * Per-response usage readings for a parse that spans several physical sends (#8902).
 *
 * An adapter parser can dispatch its own retry while it reads a response (Kiro's bounded
 * completion retry), and the terminal it yields then reports one usage for both sends. That sum
 * cannot be split after the fact: when the retry fails without metering, the terminal carries
 * only the first response's reading. Such a parser reports each physical response's reading here
 * instead, keyed by the response its parse was handed, as soon as that response is fully read.
 * The transport binds each reading to the send that produced it, and a send whose response
 * reported nothing stays unresolved at its reservation.
 *
 * A reading is what the provider reported for that response, never a local estimate. A parser
 * that only estimated a response's usage (for the client and the request log) reports undefined
 * for it: the send is then marked unmetered, and neither the estimate nor the aggregate fallback
 * that settles a request's last send with its terminal total can settle it.
 */
export interface ResponseSendReading {
  inputTokens?: number;
  outputTokens?: number;
}

type ReadingSink = (reading: ResponseSendReading | undefined) => void;
const sinks = new WeakMap<object, ReadingSink>();

/** Receive the readings the parse of `response` reports. Returns the release. */
export function observeResponseSendReadings(response: object, sink: ReadingSink): () => void {
  sinks.set(response, sink);
  return () => {
    if (sinks.get(response) === sink) sinks.delete(response);
  };
}

/**
 * Report the reading of the physical response the parse of `response` just finished reading, or
 * undefined when that response reported none of its own (an estimate is none). Call once per
 * physical response, in send order, before the parse dispatches its next send and before it
 * yields its terminal.
 */
export function reportResponseSendReading(response: object, reading: ResponseSendReading | undefined): void {
  sinks.get(response)?.(reading);
}
