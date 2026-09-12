import { Buffer } from "node:buffer";

export function truncateRemoteWorkspaceUtf8(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("invalid remote workspace UTF-8 limit");
  }
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let low = 0;
  let high = Math.min(value.length, maximumBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  if (
    low > 0
    && low < value.length
    && value.charCodeAt(low - 1) >= 0xd800
    && value.charCodeAt(low - 1) <= 0xdbff
    && value.charCodeAt(low) >= 0xdc00
    && value.charCodeAt(low) <= 0xdfff
  ) low -= 1;
  return value.slice(0, low);
}
