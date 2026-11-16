import {
  MESSAGES_SSE_ERROR_HOLD_BYTES, MessagesSseFrameContext, messagesSseErrorPayload, messagesSseOversizePayload,
} from "../lib/messages-sse-error-presentation";
import { sseFieldValue } from "../lib/sse-decoder";

const encoder = new TextEncoder();
type Newline = "\n" | "\r" | "\r\n";
/** Final errors emit only data fields after the already-public, closed error declaration. */
function ownedSuffix(bytes: Uint8Array, space: boolean, newline: Newline): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const lines = [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter(match => match[0] !== "");
  const data = lines.map(line => sseFieldValue(line[1]!, "data")).filter(value => value !== null).join("\n");
  // An empty named error still dispatches the SDK's generic APIError; add no parseable data.
  if (data === "") return encoder.encode(lines.filter(line => sseFieldValue(line[1]!, "data") !== null).map(line => line[0]).join(""));
  const payload = messagesSseErrorPayload(data);
  let replaced = false;
  return encoder.encode(lines.map(line => {
    if (sseFieldValue(line[1]!, "data") === null) return "";
    if (replaced) return "";
    replaced = true;
    return `data:${space ? " " : ""}${payload}${line[2] ? newline : ""}`;
  }).join(""));
}

export interface MessagesSseErrorFilter {
  push(value: Uint8Array, emit: (bytes: Uint8Array) => void): void;
  finish(emit: (bytes: Uint8Array) => void): void;
  dispose(): void;
}
/** Final client-only delivery on the existing enqueue turn; no new queue, pump or admission. */
export function createMessagesSseErrorFilter(context = new MessagesSseFrameContext()): MessagesSseErrorFilter {
  let disposed = false;
  let hold: Uint8Array | undefined, held = 0, oversize = false;
  let eligibility: "unseen" | "first" | "pass" | "error" = "unseen";
  let lastError = false, headerSpace = true, newline: Newline = "\n";
  let lineLength = 0, comment = false, namePosition = 0, nameMatches = true;
  let inValue = false, eventField = false, optionalSpace = true, valuePosition = 0, valueMatches = true, fieldSpace = false;
  let skipLf = false, headerCr = false, suppressLf = false;
  let bomPosition = 0, atStreamStart = true;
  const clearHold = () => { hold = undefined; held = 0; oversize = false; };
  const resetLine = () => {
    lineLength = 0; comment = false; namePosition = 0; nameMatches = true;
    inValue = false; eventField = false; optionalSpace = true; valuePosition = 0; valueMatches = true; fieldSpace = false;
  };
  const resetBlock = () => { eligibility = "unseen"; lastError = false; clearHold(); };
  const retain = (byte: number) => {
    if (oversize) return;
    if (held === MESSAGES_SSE_ERROR_HOLD_BYTES) { hold = undefined; held = 0; oversize = true; return; }
    hold ??= new Uint8Array(MESSAGES_SSE_ERROR_HOLD_BYTES);
    hold[held++] = byte;
  };
  const fieldByte = (byte: number) => {
    if (lineLength++ === 0) {
      comment = byte === 58;
      if (!comment && eligibility === "unseen") eligibility = "first";
    }
    if (comment) return;
    if (!inValue) {
      if (byte === 58) { inValue = true; eventField = nameMatches && namePosition === 5; }
      else { nameMatches &&= byte === "event".charCodeAt(namePosition); namePosition = Math.min(6, namePosition + 1); }
    } else {
      if (optionalSpace) { optionalSpace = false; if (byte === 32) { fieldSpace = true; return; } }
      valueMatches &&= byte === "error".charCodeAt(valuePosition);
      valuePosition = Math.min(6, valuePosition + 1);
    }
    // Mismatching first fields become permanently ordinary immediately.
    if (eligibility === "first" && (!nameMatches || inValue && (!eventField || !valueMatches))) eligibility = "pass";
  };
  const finishField = (ending: number) => {
    if (comment) return;
    const error = eventField && valueMatches && valuePosition === 5;
    if (eligibility === "first") {
      eligibility = error ? "error" : "pass";
      if (error) {
        lastError = true; headerSpace = fieldSpace; newline = ending === 13 ? "\r" : "\n";
        headerCr = ending === 13;
      }
    } else if (eligibility === "error" && (eventField || !inValue && nameMatches && namePosition === 5)) lastError = error;
  };
  const finishError = (emit: (bytes: Uint8Array) => void, delimiter: boolean, ending?: number): boolean => {
    const forced = oversize;
    if (forced) {
      emit(encoder.encode(`data:${headerSpace ? " " : ""}${messagesSseOversizePayload()}${delimiter ? newline + newline : ""}`));
    } else {
      const suffix = hold?.subarray(0, held) ?? new Uint8Array();
      emit(lastError ? ownedSuffix(suffix, headerSpace, newline) : suffix);
      if (delimiter) emit(lastError ? encoder.encode(newline) : new Uint8Array([ending!]));
    }
    const suppressContinuation = delimiter && (forced || lastError);
    resetBlock();
    return suppressContinuation;
  };
  const scan = (value: Uint8Array, emit: (bytes: Uint8Array) => void) => {
    let start = 0;
    const forward = (end: number) => { if (end > start) emit(start === 0 && end === value.length ? value : value.subarray(start, end)); start = end; };
    for (let i = 0; i < value.length; i++) {
      const byte = value[i]!;
      if (atStreamStart) {
        const bom = [239, 187, 191];
        if (byte === bom[bomPosition]) { bomPosition++; if (bomPosition === 3) atStreamStart = false; continue; }
        atStreamStart = false;
        if (bomPosition > 0) eligibility = "pass";
      }
      if (skipLf) {
        skipLf = false;
        if (byte === 10) {
          const declarationLf = headerCr;
          if (headerCr) { newline = "\r\n"; headerCr = false; }
          if (suppressLf) { forward(i); start = i + 1; suppressLf = false; }
          else if (eligibility === "error" && !declarationLf) {
            // The first declaration's optional LF is already public; suffix CRLF belongs to the hold.
            forward(i); retain(byte); start = i + 1;
          }
          continue;
        }
        headerCr = false; suppressLf = false;
      }
      const holding = eligibility === "error";
      if (byte === 10 || byte === 13) {
        skipLf = byte === 13;
        if (lineLength === 0) {
          if (holding) {
            forward(i); suppressLf = finishError(emit, true, byte); start = i + 1;
          } else resetBlock();
        } else {
          if (holding) { forward(i); retain(byte); start = i + 1; }
          finishField(byte);
          // A just-confirmed declaration remains part of this original public prefix.
          if (!holding && eligibility === "error") forward(i + 1);
        }
        resetLine();
      } else {
        if (holding) { forward(i); retain(byte); start = i + 1; }
        fieldByte(byte);
      }
    }
    forward(value.length);
  };
  return {
    push(value, deliver) {
      if (disposed) return;
      if (value.length === 0 && eligibility !== "error") { deliver(value); return; }
      const emit = (bytes: Uint8Array) => { if (bytes.length) deliver(bytes); };
      try {
        const origin = context.take(value);
        if (origin && "client" in origin) {
          const prefix = value[0] === 10 && value[1] === 10 ? 2 : 0;
          const ordinary = eligibility !== "error";
          if (prefix) scan(value.subarray(0, prefix), ordinary ? () => {} : emit);
          emit(ordinary ? origin.client : origin.client.subarray(prefix));
          resetBlock(); resetLine(); skipLf = false;
        } else if (origin?.echoRenamedError) {
          const header = encoder.encode("event: message_start\n");
          if (eligibility !== "unseen" || lineLength || !header.every((byte, index) => value[index] === byte)
            || value.at(-1) !== 10 || value.at(-2) !== 10) throw new Error("The proxy could not reach or read the provider.");
          emit(value.subarray(0, header.length));
          const suffix = value.subarray(header.length, value.length - 1);
          emit(suffix.length > MESSAGES_SSE_ERROR_HOLD_BYTES ? encoder.encode(`data: ${messagesSseOversizePayload()}\n`) : ownedSuffix(suffix, true, "\n"));
          emit(encoder.encode("\n"));
          resetBlock(); resetLine(); skipLf = false;
        } else scan(value, emit);
      } catch (error) { clearHold(); disposed = true; throw error; }
    },
    finish(emit) {
      if (disposed) return;
      try {
        if (eligibility === "error") {
          if (lineLength) finishField(10);
          finishError(bytes => { if (bytes.length) emit(bytes); }, false);
        }
      } finally { clearHold(); disposed = true; }
    },
    dispose() { disposed = true; resetBlock(); resetLine(); skipLf = false; headerCr = false; suppressLf = false; },
  };
}

/** Standalone reader adapter for callers without an existing final enqueue stage. */
export function filterMessagesSseErrors(source: ReadableStream<Uint8Array>, context?: MessagesSseFrameContext): ReadableStream<Uint8Array> {
  const reader = source.getReader(), filter = createMessagesSseErrorFilter(context);
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let emitted = false;
      const emit = (bytes: Uint8Array) => { controller.enqueue(bytes); emitted = true; };
      try {
        do {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) { filter.finish(emit); controller.close(); return; }
          filter.push(value, emit);
        } while (!emitted);
      } catch (error) {
        filter.dispose();
        if (!cancelled) { cancelled = true; void reader.cancel(error).catch(() => {}); controller.error(error); }
      }
    },
    cancel(reason) { cancelled = true; filter.dispose(); return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}
