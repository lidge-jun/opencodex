/** Versioned, proxy-owned compaction data. This is encoding, never provider ciphertext. */
export const RETAINED_COMPACTION_PREFIX = "ocx2:";

export interface RetainedCompaction {
  version: 2;
  summary: string;
  /** Already framed historical context, preserved byte-for-byte on replay. */
  reasoning: string[];
}

/** Raised when a proxy-owned retained compaction envelope fails to decode. */
export class InvalidRetainedCompactionEnvelopeError extends Error {
  constructor() {
    super("Invalid OpenCodex retained compaction envelope");
    this.name = "InvalidRetainedCompactionEnvelopeError";
  }
}

export function encodeRetainedCompaction(summary: string, reasoning: string[]): string {
  return RETAINED_COMPACTION_PREFIX + Buffer.from(JSON.stringify({ version: 2, summary, reasoning }), "utf-8").toString("base64");
}

export function decodeRetainedCompaction(value: string): RetainedCompaction | null {
  if (!value.startsWith(RETAINED_COMPACTION_PREFIX)) return null;
  try {
    const payload = value.slice(RETAINED_COMPACTION_PREFIX.length);
    const bytes = Buffer.from(payload, "base64");
    if (bytes.toString("base64") !== payload) return null;
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const item = parsed as Record<string, unknown>;
    if (Object.keys(item).some(key => !["version", "summary", "reasoning"].includes(key))
      || item.version !== 2 || typeof item.summary !== "string" || !item.summary.trim()
      || !Array.isArray(item.reasoning) || !item.reasoning.every(text => typeof text === "string")) return null;
    return item as unknown as RetainedCompaction;
  } catch { return null; }
}

/** True when `item` carries a proxy-owned retained envelope marker, valid payload or not. */
function isRetainedCompactionEnvelopeItem(item: unknown): item is { type: string; encrypted_content: string } {
  if (!item || typeof item !== "object") return false;
  const candidate = item as { type?: unknown; encrypted_content?: unknown };
  return typeof candidate.type === "string"
    && ["compaction", "compaction_summary", "context_compaction"].includes(candidate.type)
    && typeof candidate.encrypted_content === "string"
    && candidate.encrypted_content.startsWith(RETAINED_COMPACTION_PREFIX);
}

/** First malformed proxy-owned retained envelope in `input`, if any. */
export function findInvalidRetainedCompactionEnvelope(input: unknown): InvalidRetainedCompactionEnvelopeError | null {
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    if (!isRetainedCompactionEnvelopeItem(item)) continue;
    if (!decodeRetainedCompaction(item.encrypted_content)) return new InvalidRetainedCompactionEnvelopeError();
  }
  return null;
}

/** Expand only our structured envelopes; callers retain their existing native/ocx1 policy. */
export function expandRetainedCompactionInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  if (!input.some(isRetainedCompactionEnvelopeItem)) return input;
  return input.flatMap(item => {
    if (!isRetainedCompactionEnvelopeItem(item)) return [item];
    const data = decodeRetainedCompaction(item.encrypted_content);
    if (!data) throw new InvalidRetainedCompactionEnvelopeError();
    return [
      { ...item, encrypted_content: "ocx1:" + Buffer.from(data.summary, "utf-8").toString("base64") },
      ...data.reasoning.map(text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })),
    ];
  });
}
