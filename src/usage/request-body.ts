/**
 * The request body as the proxy received it (#3023): its bytes on the wire, its Content-Encoding and
 * the bytes it decoded to. Carried on request-log rows and usage.jsonl as `requestBody` so a reader
 * can see what a client actually sent, for example a Remote Link Child's bytes per input token.
 * Only bodies the shared JSON reader decoded completely are recorded, so the encoding is one of the
 * codings it accepts. A row written before this field existed has none; a malformed value is dropped
 * on read rather than guessed.
 */
export type RequestBodyEncoding = "identity" | "zstd" | "gzip" | "deflate";

export interface RequestBodyFacts {
  /** Bytes as received, before any decoding. */
  wireBytes: number;
  encoding: RequestBodyEncoding;
  /** Bytes after decoding; equal to wireBytes for identity. */
  decodedBytes: number;
}

const ENCODINGS: ReadonlySet<string> = new Set(["identity", "zstd", "gzip", "deflate"]);

function byteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Validate a stored or recorded value; anything else is absent. */
export function normalizeRequestBodyFacts(value: unknown): RequestBodyFacts | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!byteCount(row.wireBytes) || !byteCount(row.decodedBytes) || typeof row.encoding !== "string" || !ENCODINGS.has(row.encoding)) return undefined;
  return { wireBytes: row.wireBytes, encoding: row.encoding as RequestBodyEncoding, decodedBytes: row.decodedBytes };
}

/** The persisted/row field, or nothing. */
export function requestBodyField(value: unknown): { requestBody?: RequestBodyFacts } {
  const requestBody = normalizeRequestBodyFacts(value);
  return requestBody ? { requestBody } : {};
}
