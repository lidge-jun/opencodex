import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";

const POLICY_TITLE = "Review Data Policy";
const POLICY_DETAIL = "You must acknowledge Claude Fable 5's data retention policy to use the model.";
const POLICY_REVIEW_URL = "https://cursor.com/dashboard/restricted_models/claude-fable-5";
const MAX_VALUE_CHARS = 16_384;
const MAX_FIELDS = 128;

/**
 * Minimal read-only projection of Cursor's aiserver.v1.ErrorDetails:
 * error=1 (MODEL_BLOCKED=58), details=2; CustomErrorDetails title=1, detail=2.
 * Verified against the native CLI schema and the #4508 Connect binary response.
 * Skip buttons, URLs, analytics and dashboardAction rather than interpreting them.
 */
function isFablePolicyError(bytes: Uint8Array, custom = false): boolean {
  const reader = new BinaryReader(bytes);
  let error: number | undefined;
  let details: Uint8Array | undefined;
  let title: string | undefined;
  let detail: string | undefined;
  let fields = 0;
  while (reader.pos < reader.len) {
    if (++fields > MAX_FIELDS) return false;
    const [field, wire] = reader.tag();
    // Groups are not part of this proto3 projection; avoid recursive unknown-field skips.
    if (wire === WireType.StartGroup || wire === WireType.EndGroup) return false;
    if (!custom && field === 1) {
      if (wire !== WireType.Varint || error !== undefined) return false;
      error = reader.uint32();
    } else if (!custom && field === 2) {
      if (wire !== WireType.LengthDelimited || details !== undefined) return false;
      details = reader.bytes();
    } else if (custom && (field === 1 || field === 2)) {
      if (wire !== WireType.LengthDelimited) return false;
      const value = reader.bytes();
      if (value.length > 256) return false;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
      if (field === 1) {
        if (title !== undefined) return false;
        title = text;
      } else {
        if (detail !== undefined) return false;
        detail = text;
      }
    } else {
      reader.skip(wire);
    }
  }
  return custom
    ? title === POLICY_TITLE && detail === POLICY_DETAIL
    : error === 58 && details !== undefined && isFablePolicyError(details, true);
}

/** Recognize this policy gate, but never forward arbitrary upstream text or consent actions. */
export function cursorPolicyErrorExplanation(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const envelope = error as { code?: unknown; details?: unknown };
  if (envelope.code !== "failed_precondition" || !Array.isArray(envelope.details)) return undefined;
  for (const entry of envelope.details.slice(0, 8)) {
    if (!entry || typeof entry !== "object") continue;
    const { type, value } = entry as { type?: unknown; value?: unknown };
    if (type !== "aiserver.v1.ErrorDetails" || typeof value !== "string"
      || value.length === 0 || value.length > MAX_VALUE_CHARS
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
    try {
      const bytes = Buffer.from(value, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) continue;
      if (isFablePolicyError(bytes)) {
        // Code-owned copy cannot inject credentials or alter downstream keyword classification.
        return `${POLICY_TITLE}: ${POLICY_DETAIL} Review and accept using the same Cursor account at ${POLICY_REVIEW_URL}, then retry.`;
      }
    } catch { /* Unknown/malformed details retain the existing generic Connect error. */ }
  }
  return undefined;
}
