export const MAX_RESPONSE_LOG_INSPECTION_BYTES = 32 * 1024 * 1024;
export const MAX_NON_JSON_ERROR_INSPECTION_BYTES = 8 * 1024;

export type ResponseLogBodyOutcome = "eof" | "error" | "cancel";

export type ResponseLogBodyOptions = {
  isJson: boolean;
  onFinalize(outcome: ResponseLogBodyOutcome, text: string | undefined): void;
  /** Test seam; production uses the JSON / non-JSON byte ceilings above. */
  inspectionLimit?: number;
};

/**
 * Forward original bytes on demand, retaining only a bounded log-inspection copy.
 * JSON is inspected only after clean EOF and only when the complete body fits.
 * Other error bodies keep a diagnostic prefix, including on error/cancellation.
 * This is not an SSE observer and never owns a second, eagerly drained tee branch.
 */
export function relayResponseLogBody(
  source: ReadableStream<Uint8Array>,
  options: ResponseLogBodyOptions,
): ReadableStream<Uint8Array> {
  const limit = options.inspectionLimit ?? (options.isJson
    ? MAX_RESPONSE_LOG_INSPECTION_BYTES
    : MAX_NON_JSON_ERROR_INSPECTION_BYTES);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Response log inspection limit must be a non-negative safe integer");
  }
  const reader = source.getReader();
  let retained: Uint8Array = new Uint8Array(0);
  let retainedBytes = 0;
  let inspectionUnavailable = false;
  let finalized = false;
  let released = false;

  const discard = () => {
    retained = new Uint8Array(0);
    retainedBytes = 0;
  };
  const release = () => {
    if (released) return;
    try {
      reader.releaseLock();
      released = true;
    } catch {
      // Some runtimes defer settling a cancelled read; its continuation retries.
      return;
    }
  };
  const retain = (chunk: Uint8Array) => {
    if (inspectionUnavailable || chunk.byteLength === 0) return;
    const remaining = limit - retainedBytes;
    if (options.isJson && chunk.byteLength > remaining) {
      inspectionUnavailable = true;
      discard();
      return;
    }
    const count = Math.min(chunk.byteLength, remaining);
    if (count === 0) return;
    const required = retainedBytes + count;
    if (required > retained.byteLength) {
      // One geometrically grown allocation bounds both bytes and object count;
      // retaining a separate slice per tiny chunk would still grow metadata.
      const capacity = Math.min(limit, Math.max(required, retained.byteLength * 2, 4096));
      const grown = new Uint8Array(capacity);
      grown.set(retained.subarray(0, retainedBytes));
      retained = grown;
    }
    retained.set(chunk.subarray(0, count), retainedBytes);
    retainedBytes = required;
  };
  const finalize = (outcome: ResponseLogBodyOutcome) => {
    if (finalized) return;
    finalized = true;
    const inspect = !inspectionUnavailable && (!options.isJson || outcome === "eof");
    const bytes = retained.subarray(0, retainedBytes);
    discard();
    let text: string | undefined;
    try {
      if (inspect) text = new TextDecoder().decode(bytes);
    } catch {
      // A diagnostic decoding failure must still finalize the request log.
      text = undefined;
    }
    try {
      options.onFinalize(outcome, text);
    } catch {
      // Optional logging must neither corrupt delivery nor prevent cancellation.
      return;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finalized) {
          release();
          return;
        }
        if (done) {
          finalize("eof");
          release();
          controller.close();
          return;
        }
        try {
          retain(value);
        } catch {
          // Inspection allocation is not a reason to drop client bytes.
          inspectionUnavailable = true;
          discard();
        }
        controller.enqueue(value);
      } catch (error) {
        if (finalized) {
          release();
          return;
        }
        finalize("error");
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      if (finalized) return;
      finalize("cancel");
      // Never await tee cancellation: it can wait for the other branch's EOF.
      // Cancelling settles our pending read; no retained inspection bytes remain.
      void reader.cancel(reason).catch(() => undefined);
      release();
    },
  }, { highWaterMark: 0 });
}
