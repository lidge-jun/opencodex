import {
  TRANSLATOR_MAX_SSE_EVENT_BYTES,
  TranslatorBudgetExceededError,
  type TranslatorBudget,
} from "./translator-budget";

export interface ServerSentEvent {
  event?: string;
  data: string;
}

export type SseRecord =
  | { kind: "event"; event?: string; data: string }
  | { kind: "comment"; comment: string };

/**
 * Extract one SSE field value from a single line, or null when the line is a different field.
 *
 * The space after the colon is OPTIONAL in text/event-stream: `data:{"a":1}` is as valid as
 * `data: {"a":1}`. Parsers that hardcoded `startsWith("data: ")` silently dropped every frame
 * from a producer that omits it, which surfaced as a completed turn with no content (#1170).
 *
 * Strips at most ONE leading space — the same rule `decodeServerSentEvents` applies below — so a
 * payload that legitimately begins with whitespace keeps the rest of it. Does not trim the value:
 * callers own that choice, and some of them intentionally keep trailing bytes.
 */
export function sseFieldValue(line: string, field: string): string | null {
  if (!line.startsWith(field)) return null;
  const rest = line.slice(field.length);
  // A colonless field line is the field with an empty value per the SSE rules, and
  // `decodeServerSentEvents` below treats it that way (`colon < 0` -> valueStart = line.length).
  // These helpers must not disagree with the decoder they mirror.
  if (rest.length === 0) return "";
  if (!rest.startsWith(":")) return null;
  return rest.startsWith(": ") ? rest.slice(2) : rest.slice(1);
}

/**
 * Offset-only variant of {@link sseFieldValue} for parsers that index into a larger buffer.
 *
 * Returns the index where the field's value begins within `text`, or -1 when the line at
 * `[lineStart, lineEnd)` is a different field. Slicing nothing matters for the live Claude relay,
 * whose translator-budget accounting reserves bytes by offset — materializing the line first would
 * allocate the very string the budget exists to bound.
 */
export function sseFieldOffset(text: string, lineStart: number, lineEnd: number, field: string): number {
  if (!text.startsWith(field, lineStart)) return -1;
  let valueStart = lineStart + field.length;
  // Colonless field line: empty value, positioned at end-of-line (matches the decoder).
  if (valueStart >= lineEnd) return lineEnd;
  if (text[valueStart] !== ":") return -1;
  valueStart += 1;
  if (valueStart < lineEnd && text[valueStart] === " ") valueStart += 1;
  return valueStart;
}

/**
 * Decode text/event-stream records across arbitrary fetch chunk boundaries.
 *
 * The final record is dispatched at EOF even when the upstream omits the trailing blank line or
 * final newline. That matters for compatible APIs that place a terminal event in the last bytes of
 * the body: dropping that record turns a successful response into an adapter_eof failure.
 */
export function decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options: { includeComments: true; signal?: AbortSignal; translatorBudget: TranslatorBudget },
): AsyncGenerator<SseRecord>;
export function decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options: { includeComments?: false; signal?: AbortSignal; translatorBudget: TranslatorBudget },
): AsyncGenerator<ServerSentEvent>;
export async function* decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options: { includeComments?: boolean; signal?: AbortSignal; translatorBudget: TranslatorBudget },
): AsyncGenerator<ServerSentEvent | SseRecord> {
  const translatorBudget = options.translatorBudget;
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let lineRawBytes = 0;
  let lineRetainedBytes = 0;
  let event: string | undefined;
  let eventBytes = 0;
  let dataLines: string[] = [];
  let dataLinesBytes = 0;
  const scope = { kind: "live_transient" as const };

  const utf8SliceBytes = (value: string, start: number, end: number): number => {
    let bytes = 0;
    for (let index = start; index < end; index++) {
      const codePoint = value.codePointAt(index)!;
      if (codePoint <= 0x7f) bytes += 1;
      else if (codePoint <= 0x7ff) bytes += 2;
      else if (codePoint <= 0xffff) bytes += 3;
      else {
        bytes += 4;
        index += 1;
      }
    }
    return bytes;
  };

  const linePrefixAfter = (sourceValue: string, start: number, end: number): string => {
    if (lineBuffer.length >= 6) return lineBuffer.slice(0, 6);
    return (lineBuffer + sourceValue.slice(start, Math.min(end, start + 6 - lineBuffer.length))).slice(0, 6);
  };

  const accountedLineBytes = (rawBytes: number, prefix: string): number => {
    if (prefix.length < 5 && "data:".startsWith(prefix)) return 0;
    if (!prefix.startsWith("data:")) return rawBytes;
    return Math.max(0, rawBytes - (prefix[5] === " " ? 6 : 5));
  };

  const appendLine = (sourceValue: string, start: number, end: number): void => {
    if (start >= end) return;
    const nextRawBytes = lineRawBytes + utf8SliceBytes(sourceValue, start, end);
    const prefix = linePrefixAfter(sourceValue, start, end);
    const nextRetainedBytes = accountedLineBytes(nextRawBytes, prefix);
    if (prefix.startsWith("data:")) {
      const logicalEventBytes = dataLinesBytes + dataLines.length + nextRetainedBytes;
      if (logicalEventBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
        throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
      }
    }
    const reservation = translatorBudget.reserveTransient(nextRawBytes, scope);
    try {
      const fragment = sourceValue.slice(start, end);
      lineBuffer += fragment;
      reservation.commitRetained();
      translatorBudget.releaseRetained(lineRetainedBytes, scope);
      lineRawBytes = nextRawBytes;
      lineRetainedBytes = nextRawBytes;
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  // Prompt cancellation channel: an abort cancels the underlying reader directly, which
  // settles any in-flight read() so a consumer's iterator.return() cannot hang behind an
  // idle upstream (a plain generator return waits for the pending await first).
  const signal = options?.signal;
  const onAbort = () => { reader.cancel(signal?.reason).catch(() => { /* already closed */ }); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const includeComments = options?.includeComments === true;

  const dispatch = (): { record: ServerSentEvent | SseRecord; bytes: number } | undefined => {
    if (dataLines.length === 0) {
      translatorBudget.releaseRetained(eventBytes, scope);
      event = undefined;
      eventBytes = 0;
      return undefined;
    }
    const payloadBytes = dataLinesBytes + Math.max(0, dataLines.length - 1);
    if (payloadBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
      throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
    }
    let data: string;
    if (dataLines.length === 1) {
      data = dataLines[0]!;
    } else {
      const reservation = translatorBudget.reserveTransient(payloadBytes, scope);
      try {
        data = dataLines.join("\n");
        reservation.commitRetained();
        translatorBudget.releaseRetained(dataLinesBytes, scope);
      } catch (error) {
        reservation.release();
        throw error;
      }
    }
    const record = { ...(event ? { event } : {}), data };
    const retainedRecordBytes = payloadBytes + eventBytes;
    event = undefined;
    eventBytes = 0;
    dataLines = [];
    dataLinesBytes = 0;
    return {
      record: includeComments ? { kind: "event", ...record } : record,
      bytes: retainedRecordBytes,
    };
  };

  const acceptLine = (): { record: ServerSentEvent | SseRecord; bytes: number } | undefined => {
    let line = lineBuffer;
    let retainedLineBytes = lineRetainedBytes;
    let lineOwned = true;
    const releaseLine = (): void => {
      if (!lineOwned) return;
      lineOwned = false;
      translatorBudget.releaseRetained(retainedLineBytes, scope);
    };
    lineBuffer = "";
    lineRawBytes = 0;
    lineRetainedBytes = 0;
    try {
      if (line.endsWith("\r")) {
        const nextLineBytes = retainedLineBytes - 1;
        const reservation = translatorBudget.reserveTransient(nextLineBytes, scope);
        try {
          const nextLine = line.slice(0, -1);
          reservation.commitRetained();
          translatorBudget.releaseRetained(retainedLineBytes, scope);
          line = nextLine;
          retainedLineBytes = nextLineBytes;
        } catch (error) {
          reservation.release();
          throw error;
        }
      }
      if (line === "") {
        releaseLine();
        return dispatch();
      }
      if (line.startsWith(":")) {
        if (!includeComments) {
          releaseLine();
          return undefined;
        }
        const commentStart = line[1] === " " ? 2 : 1;
        const commentBytes = utf8SliceBytes(line, commentStart, line.length);
        translatorBudget.chargeRetained(commentBytes, scope);
        try {
          const comment = line.slice(commentStart);
          releaseLine();
          return { record: { kind: "comment", comment }, bytes: commentBytes };
        } catch (error) {
          translatorBudget.releaseRetained(commentBytes, scope);
          throw error;
        }
      }

      const colon = line.indexOf(":");
      const fieldEnd = colon < 0 ? line.length : colon;
      const fieldBytes = utf8SliceBytes(line, 0, fieldEnd);
      const fieldReservation = translatorBudget.reserveTransient(fieldBytes, scope);
      let field = "";
      try {
        field = line.slice(0, fieldEnd);
        fieldReservation.commitRetained();
      } catch (error) {
        fieldReservation.release();
        throw error;
      }
      try {
        let valueStart = colon < 0 ? line.length : colon + 1;
        if (line[valueStart] === " ") valueStart += 1;
        const valueBytes = utf8SliceBytes(line, valueStart, line.length);

        if (field === "event") {
          const reservation = translatorBudget.reserveTransient(valueBytes, scope);
          try {
            const value = line.slice(valueStart);
            reservation.commitRetained();
            translatorBudget.releaseRetained(eventBytes, scope);
            event = value;
            eventBytes = valueBytes;
            releaseLine();
          } catch (error) {
            reservation.release();
            throw error;
          }
        }
        else if (field === "data") {
          const nextEventBytes = dataLinesBytes + valueBytes + dataLines.length;
          if (nextEventBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
            throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
          }
          // The extracted value is a distinct retained allocation while the source line is still
          // live. Admit that insertion before slicing/pushing, then release the source owner.
          translatorBudget.chargeRetained(valueBytes, scope);
          try {
            const value = line.slice(valueStart);
            dataLines.push(value);
            dataLinesBytes += valueBytes;
            releaseLine();
          } catch (error) {
            translatorBudget.releaseRetained(valueBytes, scope);
            throw error;
          }
        } else {
          releaseLine();
        }
      } finally {
        translatorBudget.releaseRetained(fieldBytes, scope);
      }
      return undefined;
    } catch (error) {
      releaseLine();
      throw error;
    }
  };

  const consumeDecoded = async function* (
    decoded: string,
  ): AsyncGenerator<ServerSentEvent | SseRecord> {
    let offset = 0;
    while (offset < decoded.length) {
      const newline = decoded.indexOf("\n", offset);
      if (newline < 0) {
        appendLine(decoded, offset, decoded.length);
        return;
      }
      appendLine(decoded, offset, newline);
      const accepted = acceptLine();
      if (accepted) {
        try {
          yield accepted.record;
        } finally {
          translatorBudget.releaseRetained(accepted.bytes, scope);
        }
      }
      offset = newline + 1;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        const sourceBytes = value.byteLength;
        const sourceReservation = translatorBudget.reserveTransient(sourceBytes, scope);
        let sourceCommitted = false;
        try {
          const decoded = decoder.decode(value, { stream: !done });
          sourceReservation.commitRetained();
          sourceCommitted = true;
          yield* consumeDecoded(decoded);
        } finally {
          if (sourceCommitted) translatorBudget.releaseRetained(sourceBytes, scope);
          else sourceReservation.release();
        }
      }
      if (!done) continue;
      const finalDecoded = decoder.decode();
      yield* consumeDecoded(finalDecoded);
      if (lineBuffer.length > 0) {
        const accepted = acceptLine();
        if (accepted) {
          try {
            yield accepted.record;
          } finally {
            translatorBudget.releaseRetained(accepted.bytes, scope);
          }
        }
      }
      const finalRecord = dispatch();
      if (finalRecord) {
        try {
          yield finalRecord.record;
        } finally {
          translatorBudget.releaseRetained(finalRecord.bytes, scope);
        }
      }
      break;
    }
  } finally {
    translatorBudget.releaseRetained(lineRetainedBytes + dataLinesBytes + eventBytes, scope);
    signal?.removeEventListener("abort", onAbort);
    try { await reader.cancel(); } catch { /* already closed/errored */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
