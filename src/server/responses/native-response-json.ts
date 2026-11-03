import { createHash } from "node:crypto";

/** Narrow JSON object envelopes independently of either native control owner. */
export function nativeResponseRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const canonical = (item: unknown): string => Array.isArray(item) ? `[${item.map(canonical).join(",")}]`
  : nativeResponseRecord(item) ? `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`
  : JSON.stringify(item) ?? "null";
const fingerprint = (json: string): string => createHash("sha256").update(json).digest("hex");

/** Compare JSON content by value: object-key order is irrelevant, array order is not. */
export function nativeResponseFingerprint(value: unknown): string {
  return fingerprint(canonical(value));
}

/** Keep transient body keys within the existing 64-byte digest payload bound. */
export function nativeResponseOutputIdentity(item: Record<string, unknown>): string {
  if (typeof item.id === "string") return `id:${item.id}`;
  const json = canonical(item);
  return Buffer.byteLength(json, "utf8") <= 64 ? `json:${json}` : `body:${fingerprint(json)}`;
}
