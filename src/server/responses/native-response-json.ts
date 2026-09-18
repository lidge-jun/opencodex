import { createHash } from "node:crypto";

/** Narrow JSON object envelopes independently of either native control owner. */
export function nativeResponseRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compare JSON content by value: object-key order is irrelevant, array order is not. */
export function nativeResponseFingerprint(value: unknown): string {
  const canonical = (item: unknown): string => Array.isArray(item) ? `[${item.map(canonical).join(",")}]`
    : nativeResponseRecord(item) ? `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`
    : JSON.stringify(item) ?? "null";
  return createHash("sha256").update(canonical(value)).digest("hex");
}
