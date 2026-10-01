import { rewriteAppServerLine } from "./app-server-rewrite";

/** Byte-preserving stdout filter; unexpected rewrite machinery failures disable filtering. */
const NEWLINE = 0x0a;
/**
 * Gate messages are a few kilobytes. A line longer than this is passed through raw instead of
 * being buffered, so a runaway line without a newline cannot grow the filter's memory unbounded.
 */
export const MAX_FILTERED_LINE_BYTES = 8 * 1024 * 1024;

function concatParts(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Splits a byte stream into lines and rewrites the ones that need it. Returns the bytes to write
 * for each chunk; a partial trailing line is held back until its newline arrives (or `flush`).
 * The held-back pieces are kept as a list and joined once when the line ends, so a long line
 * spread over many pipe chunks costs linear copying rather than recopying its prefix per chunk.
 * A line over `maxLineBytes` is emitted raw as it arrives and never parsed.
 */
export function createRpcLineFilter(
  rewrite: (line: string) => string | null = rewriteAppServerLine,
  maxLineBytes = MAX_FILTERED_LINE_BYTES,
): { push(chunk: Uint8Array): Uint8Array[]; flush(): Uint8Array[] } {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending: Uint8Array[] = [];
  let pendingLength = 0;
  let passthrough = false;
  // Inside an oversized line: bytes pass through raw until its newline.
  let skippingLine = false;

  // `line` excludes the newline, `whole` includes it when there is one. An untouched line is
  // returned as the very bytes that arrived; only a rewritten one is re-encoded.
  const emit = (line: Uint8Array, whole: Uint8Array, terminated: boolean): Uint8Array => {
    let rewritten: string | null;
    try {
      rewritten = rewrite(decoder.decode(line));
    } catch {
      return whole;
    }
    if (rewritten === null) return whole;
    const body = encoder.encode(rewritten);
    if (!terminated) return body;
    const out = new Uint8Array(body.length + 1);
    out.set(body, 0);
    out[body.length] = NEWLINE;
    return out;
  };

  return {
    push(chunk) {
      if (passthrough) return [chunk];
      const previous = pending;
      const previousLength = pendingLength;
      try {
        const out: Uint8Array[] = [];
        let start = 0;
        if (skippingLine) {
          const end = chunk.indexOf(NEWLINE);
          if (end === -1) return [chunk];
          out.push(chunk.subarray(0, end + 1));
          skippingLine = false;
          start = end + 1;
        }
        let held = previous;
        let heldLength = previousLength;
        for (let i = chunk.indexOf(NEWLINE, start); i !== -1; i = chunk.indexOf(NEWLINE, start)) {
          const tail = chunk.subarray(start, i + 1);
          const whole = heldLength === 0 ? tail : concatParts([...held, tail], heldLength + tail.length);
          out.push(emit(whole.subarray(0, whole.length - 1), whole, true));
          held = [];
          heldLength = 0;
          start = i + 1;
        }
        if (start < chunk.length) {
          const rest = chunk.slice(start);
          if (heldLength + rest.length > maxLineBytes) {
            // Too long to be a gate message: release what is held and stream the rest raw.
            out.push(...held, rest);
            held = [];
            heldLength = 0;
            skippingLine = true;
          } else {
            // Appending in place is safe: nothing after this point can throw back to `previous`.
            held.push(rest);
            heldLength += rest.length;
          }
        }
        pending = held;
        pendingLength = heldLength;
        return out;
      } catch {
        pending = [];
        pendingLength = 0;
        passthrough = true;
        return [...previous, chunk];
      }
    },
    flush() {
      if (pendingLength === 0) return [];
      const parts = pending;
      const last = concatParts(parts, pendingLength);
      pending = [];
      pendingLength = 0;
      if (passthrough) return parts;
      try { return [emit(last, last, false)]; } catch { return [last]; }
    },
  };
}

/** Copy `input` to `write`, rewriting gate lines on the way. Resolves when `input` ends. */
export async function runStdoutFilter(
  input: AsyncIterable<Uint8Array>,
  write: (bytes: Uint8Array) => Promise<unknown> | unknown,
  rewrite?: (line: string) => string | null,
): Promise<void> {
  let filter: ReturnType<typeof createRpcLineFilter> | undefined;
  try { filter = createRpcLineFilter(rewrite); } catch { /* Raw passthrough if setup fails. */ }
  for await (const chunk of input) {
    for (const out of filter ? filter.push(chunk) : [chunk]) await write(out);
  }
  for (const out of filter?.flush() ?? []) await write(out);
}

/** Hidden CLI entry; the self-test emits no stdout so the launcher can probe it safely. */
export async function runChatgptAppServerFilter({ selfTest = false }: { selfTest?: boolean } = {}): Promise<number> {
  if (selfTest) {
    try {
      const fixture = JSON.stringify({ id: 1, result: {
        ordinaryUsageAllowed: false,
        rateLimits: { rateLimitReachedType: "rate_limit_reached", primary: { usedPercent: 100 } },
      } });
      const rewritten = rewriteAppServerLine(fixture);
      if (!rewritten) return 1;
      const result = JSON.parse(rewritten).result;
      return result.ordinaryUsageAllowed === true
        && result.rateLimits.rateLimitReachedType === null
        && result.rateLimits.primary.usedPercent === 100 ? 0 : 1;
    } catch { return 1; }
  }
  await runStdoutFilter(Bun.stdin.stream(), bytes => Bun.write(Bun.stdout, bytes));
  return 0;
}
