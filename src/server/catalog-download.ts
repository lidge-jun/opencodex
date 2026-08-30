/**
 * Shared serialization for the model catalog, used by both the management route
 * (`GET /api/catalog`) and the least-privilege data-plane route
 * (`GET|HEAD /v1/catalog`, issue #809).
 *
 * The point of the shared module is that the two routes must emit the *same
 * bytes*. A remote Codex client previously had to be handed an admin token just
 * to read the catalog, which is the least-privilege violation #809 is about; the
 * fix is a second route on the data plane, never a widened management boundary.
 * If each route serialized independently they would drift, and the data-plane
 * copy is the one nobody looks at in the dashboard.
 */
import { createHash } from "node:crypto";

/**
 * Upper bound on a serialized catalog we are willing to hold in memory and hand
 * to a remote client. A materialized catalog is a few hundred KiB; anything past
 * this is a corrupt or hostile file, and streaming it would be worse than
 * refusing it.
 */
export const MAX_REMOTE_CATALOG_BYTES = 32 * 1024 * 1024;

export interface SerializedCatalog {
  /** Serialized catalog JSON, or null when no catalog could be materialized. */
  body: string | null;
  /** Strong ETag over `body`, present only when `body` is. */
  etag?: string;
  /** Byte length of `body`, present only when `body` is. */
  bytes?: number;
  /** True when the catalog materialized but exceeds `MAX_REMOTE_CATALOG_BYTES`. */
  tooLarge?: boolean;
}

export function catalogEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}

/**
 * Read and serialize the persisted catalog once.
 *
 * Returns `{ body: null }` for every unreadable case — absent file, unreadable
 * file, malformed JSON — because `readCatalog` already collapses those into
 * `null` and the routes render them identically as a 404. Distinguishing them
 * here would invite one route to leak a filesystem path in an error message.
 */
export async function serializePersistedCatalog(): Promise<SerializedCatalog> {
  const { readCatalog, readCodexCatalogPath } = await import("../codex/catalog");
  const catalog = readCatalog(readCodexCatalogPath());
  if (!catalog) return { body: null };
  const body = JSON.stringify(catalog);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_REMOTE_CATALOG_BYTES) return { body: null, tooLarge: true, bytes };
  return { body, etag: catalogEtag(body), bytes };
}

/**
 * The authoritative Codex version for a catalog response, or undefined.
 *
 * Never fabricated: when no runtime is persisted the header is omitted rather
 * than guessed, so a client cannot mistake "unknown" for a specific version.
 */
export async function persistedCodexVersion(): Promise<string | undefined> {
  const { loadPersistedCodexRuntime } = await import("../codex/runtime");
  return loadPersistedCodexRuntime()?.selectedVersion ?? undefined;
}
