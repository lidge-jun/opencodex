import { createHash } from "node:crypto";

/**
 * Strong ETag of a serialized catalog body: the quoted SHA-256 hex of its UTF-8 bytes. Pure, so both the Home's
 * catalog download (src/server) and the link layer's catalog freshness (src/link, which must not import server
 * modules) compute the same value.
 */
export function catalogEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}
