import { sseFieldValue } from "../../lib/sse-decoder";
import type { NormalizedEvent } from "./types";

/** CL-00 §5 SSE normalization for assertion observations. */
export function normalizeSseBytes(bytes: Uint8Array, sourceProtocol: string): NormalizedEvent[] {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const events: NormalizedEvent[] = [];
  let ordinal = 0;
  const frames = text.split("\n\n");
  for (const rawFrame of frames) {
    if (!rawFrame.trim()) continue;
    const lines = rawFrame.split("\n");
    const dataLines: string[] = [];
    let eventName: string | undefined;
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      const eventValue = sseFieldValue(line, "event");
      if (eventValue !== null) {
        eventName = eventValue;
        continue;
      }
      const dataValue = sseFieldValue(line, "data");
      if (dataValue !== null) dataLines.push(dataValue);
    }
    if (dataLines.length === 0) continue;
    const joined = dataLines.join("\n");
    if (sourceProtocol === "openai-chat" && joined === "[DONE]") {
      events.push({ event: "[DONE]", data: "[DONE]", ordinal: ordinal++ });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(joined);
    } catch {
      events.push({ event: eventName ?? "malformed", data: joined, ordinal: ordinal++ });
      continue;
    }
    // Protocol V1 treats null, scalar, and array data values as padding.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const inferred = eventName ?? (typeof (parsed as { type?: unknown }).type === "string"
      ? (parsed as { type: string }).type
      : "message");
    events.push({ event: inferred, data: parsed, ordinal: ordinal++ });
  }
  return events;
}

export function eventsFromBridgeFrames(
  frames: Array<{ event?: string; data: Record<string, unknown> }>,
): NormalizedEvent[] {
  return frames.map((frame, ordinal) => ({
    event: frame.event ?? (typeof frame.data.type === "string" ? frame.data.type : "message"),
    data: frame.data,
    ordinal,
  }));
}
