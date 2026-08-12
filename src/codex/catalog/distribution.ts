import { readCatalog, readCodexCatalogPath } from "./parsing";

/**
 * The one place a stored Codex catalog becomes an HTTP-shippable document.
 *
 * Two routes distribute the catalog — management `GET /api/catalog` and data-plane
 * `GET /v1/catalog` (#809) — and the issue's hard requirement is that they consume the
 * same authority rather than each growing its own reader and serializer. Both call this
 * function and serialize nothing themselves, so a change to catalog materialization
 * cannot land on one surface and miss the other.
 *
 * What deliberately stays with the callers is transport: admission, CORS, cache policy,
 * and each plane's own error envelope. Those differ by design; the document does not.
 */

export const CATALOG_DISTRIBUTION_CONTENT_TYPE = "application/json";

/**
 * Codex version the running proxy selected, when it has an authoritative one.
 *
 * Absent is a real answer. The header is omitted rather than guessed when no runtime
 * record exists — a fabricated version is worse than none for a client comparing skew.
 */
export const CATALOG_CODEX_VERSION_HEADER = "x-opencodex-codex-version";

export interface MaterializedCatalog {
  readonly status: "ok";
  /** Exact bytes both routes send, so neither can reorder or re-shape the document. */
  readonly body: string;
  readonly byteLength: number;
  readonly codexVersion?: string;
}

export type CatalogDistribution = MaterializedCatalog | { readonly status: "missing" };

/**
 * Read and serialize the stored catalog, or report that it cannot be materialized.
 *
 * `readCatalog` already collapses "file absent", "unreadable", and "not a catalog
 * document" into one null. That collapse is kept: the distinction is a local filesystem
 * fact, and neither plane should describe the operator's disk to a caller.
 */
export async function materializeCatalogDistribution(): Promise<CatalogDistribution> {
  const catalog = readCatalog(readCodexCatalogPath());
  if (!catalog) return { status: "missing" };
  const body = JSON.stringify(catalog);
  // Imported here rather than at module scope: the runtime module pulls in Codex
  // process resolution, and the catalog routes are the only reason it would load.
  const { loadPersistedCodexRuntime } = await import("../runtime");
  const codexVersion = loadPersistedCodexRuntime()?.selectedVersion;
  return {
    status: "ok",
    body,
    byteLength: Buffer.byteLength(body, "utf8"),
    ...(codexVersion ? { codexVersion } : {}),
  };
}

/**
 * Content type and version metadata for a materialized catalog.
 *
 * Shared so the two routes cannot disagree about the document's declared type or its
 * version/skew header. Cache and security headers are per-plane and are added by the
 * caller.
 */
export function catalogDistributionHeaders(catalog: MaterializedCatalog): Record<string, string> {
  return {
    "Content-Type": CATALOG_DISTRIBUTION_CONTENT_TYPE,
    ...(catalog.codexVersion ? { [CATALOG_CODEX_VERSION_HEADER]: catalog.codexVersion } : {}),
  };
}
