import { MIN_COMPRESS_SIZE, RAW_CAP } from "./constants";
import { autoDetectFilter } from "./autodetect";
import { safeApply } from "./apply-filter";
import type { RtkStats } from "./types";
import type { OcxParsedRequest } from "../types/request";

export function compressText(text: string, stats?: RtkStats, shape?: string): string {
  const bytesIn = text.length;
  if (stats) stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    if (stats) stats.bytesAfter += bytesIn;
    return text;
  }

  const fn = autoDetectFilter(text);
  if (!fn) {
    if (stats) stats.bytesAfter += bytesIn;
    return text;
  }

  const out = safeApply(fn, text);

  // Safety: never return empty, never grow the input
  if (!out || out.length === 0 || out.length >= bytesIn) {
    if (stats) stats.bytesAfter += bytesIn;
    return text;
  }

  if (stats) {
    stats.bytesAfter += out.length;
    const filterName = (fn as any).filterName || fn.name || "filter";
    stats.hits.push({ shape, filter: filterName, saved: bytesIn - out.length });
  }
  return out;
}

export function compressParsedMessages(parsed: OcxParsedRequest, enabled = true): RtkStats | null {
  if (!enabled) return null;
  const messages = parsed.context?.messages;
  if (!Array.isArray(messages)) return null;

  const stats: RtkStats = { bytesBefore: 0, bytesAfter: 0, hits: [] };

  try {
    for (const msg of messages) {
      if (!msg) continue;
      if (msg.role === "toolResult") {
        if (msg.isError) continue;
        if (typeof msg.content === "string") {
          msg.content = compressText(msg.content, stats, "ocx-tool-string");
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "ocx-tool-part");
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("[RTK] compressParsedMessages error:", (err as any)?.message || err);
    return null;
  }

  return stats;
}

export function compressRawBody(body: unknown, enabled = true): RtkStats | null {
  if (!enabled || !body || typeof body !== "object") return null;
  const stats: RtkStats = { bytesBefore: 0, bytesAfter: 0, hits: [] };

  const raw = body as Record<string, unknown>;
  const items = Array.isArray(raw.messages) ? raw.messages
    : Array.isArray(raw.input) ? raw.input
    : null;

  if (!items) return null;

  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg || typeof msg !== "object") continue;

      if (msg.type === "function_call_output" || msg.type === "custom_tool_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "responses-call-output");
        } else if (Array.isArray(msg.output)) {
          for (const part of msg.output) {
            if (part && (part.type === "input_text" || part.type === "text") && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "responses-input-text");
            }
          }
        }
        continue;
      }

      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressText(msg.content, stats, "openai-tool-string");
        continue;
      }

      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-part");
          }
        }
        continue;
      }

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || block.type !== "tool_result") continue;
          if (block.is_error === true) continue;
          if (typeof block.content === "string") {
            block.content = compressText(block.content, stats, "claude-tool-string");
          } else if (Array.isArray(block.content)) {
            for (const part of block.content) {
              if (part && part.type === "text" && typeof part.text === "string") {
                part.text = compressText(part.text, stats, "claude-tool-part");
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("[RTK] compressRawBody error:", (err as any)?.message || err);
    return null;
  }

  return stats;
}

export function formatRtkLog(stats: RtkStats | null): string | null {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return "[RTK] saved " + saved + "B / " + stats.bytesBefore + "B (" + pct + "%) via [" + filters + "] hits=" + stats.hits.length;
}
