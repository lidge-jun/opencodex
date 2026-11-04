import { Buffer } from "node:buffer";
import type { OcxConfig } from "../../types";
import { isPlainObject } from "../../adapters/openai-responses/internal";
import { isCanonicalCodexResponsesUrl } from "./request-compression";

/**
 * Shorten stale screenshots and fat tool outputs on the outbound ChatGPT Codex
 * body. The local session and previous_response_id cache keep the originals;
 * only the string about to be sent is replaced.
 *
 * Full-context HTTP turns repeat prior inline images, which barely shrink
 * under transport compression. This optional policy changes only outbound
 * history before the latest user message; it is not a lossless image cache.
 */
export type UpstreamHistorySlim = "off" | "codex";

const TEXT_LIMIT = 32 * 1024;
const TEXT_HEAD = 2 * 1024;
const TEXT_TAIL = 1024;
/** Inline image payloads only. A file id or a short URL is not the metered cost. */
const IMAGE_INLINE_MIN_BYTES = 1024;
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const TEXT_KEYS = new Set(["text", "output", "content", "refusal"]);
const STRUCTURAL_KEYS = new Set(["call_id", "id", "name", "type", "status", "role", "file_id"]);

let boundConfig: Pick<OcxConfig, "upstreamHistorySlim"> | null = null;
let slimmedRequests = 0;
let slimmedBytes = 0;

/** Scalar counters only. They do not retain request text or image bytes. */
export function upstreamHistorySlimCounters(): { requests: number; bytes: number } {
  return { requests: slimmedRequests, bytes: slimmedBytes };
}

export function bindUpstreamHistorySlimConfig(config: Pick<OcxConfig, "upstreamHistorySlim"> | null): void {
  boundConfig = config;
}

export function resolveUpstreamHistorySlim(value: unknown): UpstreamHistorySlim {
  return value === "codex" ? "codex" : "off";
}

export function currentUpstreamHistorySlim(): UpstreamHistorySlim {
  return resolveUpstreamHistorySlim(boundConfig?.upstreamHistorySlim);
}

function utf8(text: string, start: number, end: number): string {
  const bytes = Buffer.from(text, "utf8");
  let from = Math.max(0, Math.min(start, bytes.length));
  let to = Math.max(from, Math.min(end, bytes.length));
  if (from > 0) {
    while (from < to && (bytes[from]! & 0xc0) === 0x80) from += 1;
  }
  if (to < bytes.length) {
    while (to > from && (bytes[to]! & 0xc0) === 0x80) to -= 1;
  }
  return bytes.subarray(from, to).toString("utf8");
}

function imageInlineBytes(part: Record<string, unknown>): number {
  const url = part.image_url;
  const value = typeof url === "string" ? url : isPlainObject(url) ? url.url : undefined;
  return typeof value === "string" && /^data:/i.test(value) ? Buffer.byteLength(value) : 0;
}

function imageStub(bytes: number): Record<string, unknown> {
  return {
    type: "input_text",
    text: `[image omitted, ${bytes} bytes, original remains in the local session]`,
  };
}

/** Replace inline images. Returns whether any part changed. */
function stripInlineImages(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(entry => {
      const stripped = stripInlineImages(entry);
      changed ||= stripped.changed;
      return stripped.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };
  if (value.type === "input_image") {
    const bytes = imageInlineBytes(value);
    if (bytes > IMAGE_INLINE_MIN_BYTES) return { value: imageStub(bytes), changed: true };
    return { value, changed: false };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (STRUCTURAL_KEYS.has(key) && typeof entry !== "object") {
      next[key] = entry;
      continue;
    }
    const stripped = stripInlineImages(entry);
    changed ||= stripped.changed;
    next[key] = stripped.value;
  }
  return changed ? { value: next, changed } : { value, changed: false };
}

type TextSlot = { parent: Record<string, unknown>; key: string; bytes: number };

function collectTextSlots(value: unknown, slots: TextSlot[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectTextSlots(entry, slots);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    if (typeof entry === "string" && TEXT_KEYS.has(key)) {
      slots.push({ parent: value, key, bytes: Buffer.byteLength(entry) });
    } else if (entry && typeof entry === "object") {
      collectTextSlots(entry, slots);
    }
  }
}

function excerptText(text: string, size: number): string {
  const head = utf8(text, 0, TEXT_HEAD);
  const tail = utf8(text, Math.max(0, size - TEXT_TAIL), size);
  return `[tool output shortened, original ${size} bytes, full output remains in the local session]\n${head}\n[${size} bytes omitted]\n${tail}`;
}

/**
 * Budget against the whole serialized tool output, not one field: an output split into many
 * text parts below 32 KiB each still has its largest parts excerpted until the item fits.
 */
function trimToolOutput(item: Record<string, unknown>): boolean {
  if (typeof item.type !== "string" || !TOOL_OUTPUT_TYPES.has(item.type)) return false;
  let total = Buffer.byteLength(JSON.stringify(item));
  if (total <= TEXT_LIMIT) return false;
  const slots: TextSlot[] = [];
  collectTextSlots(item, slots);
  slots.sort((a, b) => b.bytes - a.bytes);
  let changed = false;
  for (const slot of slots) {
    if (total <= TEXT_LIMIT) break;
    const current = slot.parent[slot.key];
    if (typeof current !== "string") continue;
    const next = excerptText(current, slot.bytes);
    const saved = Buffer.byteLength(JSON.stringify(current)) - Buffer.byteLength(JSON.stringify(next));
    if (saved <= 0) continue;
    slot.parent[slot.key] = next;
    total -= saved;
    changed = true;
  }
  return changed;
}

function isUserMessage(item: unknown): boolean {
  if (!isPlainObject(item) || item.role !== "user") return false;
  return item.type === undefined || item.type === "message";
}

/**
 * Returns a new JSON body when a prefix item was shortened, or null when the
 * outbound body should be sent unchanged. Null keeps the caller's bytes intact
 * so an unchanged turn does not get a fresh serialization.
 */
export function slimCodexHistoryJson(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.input)) return null;
  let lastUser = -1;
  for (let index = 0; index < parsed.input.length; index += 1) {
    if (isUserMessage(parsed.input[index])) lastUser = index;
  }
  if (lastUser <= 0) return null;
  let changed = false;
  const input = parsed.input.map((item, index) => {
    if (index >= lastUser) return item;
    const stripped = stripInlineImages(item);
    let next = stripped.value;
    changed ||= stripped.changed;
    if (isPlainObject(next) && trimToolOutput(next)) changed = true;
    return next;
  });
  if (!changed) return null;
  const next = JSON.stringify({ ...parsed, input });
  slimmedRequests += 1;
  slimmedBytes += Math.max(0, Buffer.byteLength(body) - Buffer.byteLength(next));
  return next;
}

/** Apply the live switch to one final HTTP init. Other destinations pass through. */
export function slimOutboundCodexHistory(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): RequestInit | undefined {
  if (!init || currentUpstreamHistorySlim() !== "codex" || typeof init.body !== "string") return init;
  const target = input instanceof Request ? input.url : String(input);
  if (!isCanonicalCodexResponsesUrl(target)) return init;
  const next = slimCodexHistoryJson(init.body);
  if (next === null) return init;
  return { ...init, body: next };
}
