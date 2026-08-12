import {
  ACCOUNT_IMPORT_MAX_BYTES,
  ACCOUNT_IMPORT_MAX_EMAIL_LENGTH,
  ACCOUNT_IMPORT_MAX_RECORDS,
  ACCOUNT_IMPORT_MAX_REFRESH_TOKEN_BYTES,
  type ParsedCockpitRecord,
} from "./types";

const encoder = new TextEncoder();
const ALLOWED_RECORD_KEYS = new Set(["email", "refresh_token", "tags", "notes"]);

export type CockpitDocumentParseResult =
  | { ok: true; records: ParsedCockpitRecord[] }
  | { ok: false; code: "invalid_document" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedDocumentSize(document: unknown): number | null {
  try {
    const serialized = JSON.stringify(document);
    return serialized === undefined ? null : encoder.encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function validEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > ACCOUNT_IMPORT_MAX_EMAIL_LENGTH) return false;
  if (value !== value.trim() || /[\x00-\x20\x7f]/.test(value)) return false;
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
}

function validRefreshToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && encoder.encode(value).byteLength <= ACCOUNT_IMPORT_MAX_REFRESH_TOKEN_BYTES
    && !/[\s\x7f]/.test(value);
}

function validMetadata(record: Record<string, unknown>): boolean {
  if (record.tags !== undefined && (
    !Array.isArray(record.tags)
    || record.tags.some(tag => typeof tag !== "string")
  )) return false;
  return record.notes === undefined || typeof record.notes === "string";
}

function parseRecord(value: unknown, index: number): ParsedCockpitRecord {
  if (!isPlainRecord(value)) return { index, code: "invalid_record" };
  if (Object.keys(value).some(key => !ALLOWED_RECORD_KEYS.has(key))) return { index, code: "invalid_record" };
  if (!validEmail(value.email) || !validRefreshToken(value.refresh_token) || !validMetadata(value)) {
    return { index, code: "invalid_record" };
  }
  return {
    index,
    record: {
      email: value.email.toLowerCase(),
      refreshToken: value.refresh_token,
    },
  };
}

export function parseCockpitAccountDocument(document: unknown): CockpitDocumentParseResult {
  const size = serializedDocumentSize(document);
  if (size === null || size > ACCOUNT_IMPORT_MAX_BYTES) return { ok: false, code: "invalid_document" };
  if (!Array.isArray(document) || document.length === 0 || document.length > ACCOUNT_IMPORT_MAX_RECORDS) {
    return { ok: false, code: "invalid_document" };
  }
  const seen = new Set<string>();
  const records = document.map((value, index): ParsedCockpitRecord => {
    const parsed = parseRecord(value, index);
    if ("code" in parsed) return parsed;
    if (seen.has(parsed.record.email)) return { index, code: "invalid_record" };
    seen.add(parsed.record.email);
    return parsed;
  });
  return { ok: true, records };
}
