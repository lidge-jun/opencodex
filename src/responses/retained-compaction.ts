/** Versioned, proxy-owned compaction data. This is encoding, never provider ciphertext. */
export const RETAINED_COMPACTION_PREFIX = "ocx2:";

export interface RetainedCompaction {
  version: 2;
  summary: string;
  /** Already framed historical context, preserved byte-for-byte on replay. */
  reasoning: string[];
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

/** Expand only our structured envelopes; callers retain their existing native/ocx1 policy. */
export function expandRetainedCompactionInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  if (!input.some(item => item && typeof item === "object" && ["compaction", "compaction_summary", "context_compaction"].includes(item.type)
    && typeof item.encrypted_content === "string" && item.encrypted_content.startsWith(RETAINED_COMPACTION_PREFIX))) return input;
  return input.flatMap(item => {
    if (!item || typeof item !== "object" || !["compaction", "compaction_summary", "context_compaction"].includes(item.type)
      || typeof item.encrypted_content !== "string" || !item.encrypted_content.startsWith(RETAINED_COMPACTION_PREFIX)) return [item];
    const data = decodeRetainedCompaction(item.encrypted_content);
    if (!data) throw new Error("Invalid OpenCodex retained compaction envelope");
    return [
      { ...item, encrypted_content: "ocx1:" + Buffer.from(data.summary, "utf-8").toString("base64") },
      ...data.reasoning.map(text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })),
    ];
  });
}
