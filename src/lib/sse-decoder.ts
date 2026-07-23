export interface ServerSentEvent {
  event?: string;
  data: string;
}

/**
 * Decode text/event-stream records across arbitrary fetch chunk boundaries.
 *
 * The final record is dispatched at EOF even when the upstream omits the trailing blank line or
 * final newline. That matters for compatible APIs that place a terminal event in the last bytes of
 * the body: dropping that record turns a successful response into an adapter_eof failure.
 */
export async function* decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): ServerSentEvent | undefined => {
    if (dataLines.length === 0) {
      event = undefined;
      return undefined;
    }
    const record = { ...(event ? { event } : {}), data: dataLines.join("\n") };
    event = undefined;
    dataLines = [];
    return record;
  };

  const acceptLine = (rawLine: string): ServerSentEvent | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const record = acceptLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (record) yield record;
      }

      if (!done) continue;
      buffer += decoder.decode();
      if (buffer.length > 0) {
        const record = acceptLine(buffer);
        buffer = "";
        if (record) yield record;
      }
      const finalRecord = dispatch();
      if (finalRecord) yield finalRecord;
      break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed/errored */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
