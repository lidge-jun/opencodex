import { formatErrorResponse } from "../bridge";

/**
 * `GET`/`HEAD /v1/catalog` — the least-privilege projection of the catalog document
 * (#809).
 *
 * A remote Codex client already holds a data-plane credential for inference. Before this
 * route the only way to fetch the generated catalog was `GET /api/catalog`, which sits on
 * the management plane beside provider configuration, OAuth login, and proxy shutdown.
 * Handing that credential to every client machine to distribute model metadata is the
 * least-privilege violation this route removes; the management prefix is unchanged and
 * gains no data-plane exception.
 *
 * The document itself is not produced here. It comes from the same materialization
 * boundary `/api/catalog` uses — including the source read bound and the
 * safe-to-distribute verdict — so there is exactly one catalog reader and serializer.
 * What this module owns is the data-plane transport contract: read-only methods, a
 * declared response ceiling, cache policy, and the data-plane error envelope.
 */

/** Methods this surface serves. The catalog is read-only; no `/v1` mutation exists. */
export const DATA_PLANE_CATALOG_ALLOWED_METHODS = "GET, HEAD";

/**
 * Declared ceiling on the serialized catalog document this route will ship, measured in
 * UTF-8 response bytes.
 *
 * Not a memory guard — the source read bound in the shared materializer is what protects
 * parsing. This is a stated upper bound for the remote half of the workflow: a client
 * saving this route's output gets a bounded file or a deterministic refusal, never an
 * unbounded stream and never a truncated document. A real generated catalog is orders of
 * magnitude below this, so the bound refuses only a pathological document.
 *
 * The management route does not apply this response ceiling. The bound is specific to
 * the remotely reachable transport, which is the surface that needs one.
 */
export const DATA_PLANE_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Cache and content-hygiene headers for EVERY `/v1/catalog` outcome — success, HEAD, and
 * each error — applied as the last step so no branch can miss them.
 *
 * `no-store` matters on errors as much as on the document: a cached `404
 * catalog_not_found` would keep telling a client there is no catalog after the operator
 * generates one. The document itself additionally tracks live provider, visibility, and
 * account-selector state and is served per credential, so a shared intermediary must not
 * retain or replay any of it.
 */
export function withDataPlaneCatalogResponseHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function dataPlaneCatalogMethodNotAllowed(): Response {
  const response = formatErrorResponse(
    405,
    "method_not_allowed",
    `The catalog surface is read-only; use ${DATA_PLANE_CATALOG_ALLOWED_METHODS}`,
  );
  const headers = new Headers(response.headers);
  headers.set("Allow", DATA_PLANE_CATALOG_ALLOWED_METHODS);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Content-free refusal envelope for the two size limits.
 *
 * The codes are kept distinct because the messages make different claims and only one of
 * them can be true for a given file: a 33 MiB pretty-printed source may well compact
 * below 8 MiB, so answering the source refusal with the serialized-limit message would be
 * a false statement about the document. Whether `catalog_source_too_large` is the right
 * public code, and whether 500 is the right status for either, is flagged for maintainer
 * review in `structure/05_gui-and-management-api.md`.
 */
function catalogSizeRefusal(code: "catalog_too_large" | "catalog_source_too_large", message: string): Response {
  return new Response(JSON.stringify({
    error: { type: "server_error", code, message },
  }), { status: 500, headers: { "Content-Type": "application/json" } });
}

/**
 * Serve the catalog to an already-admitted data-plane caller.
 *
 * `HEAD` answers with the status and headers `GET` would produce, including the byte count
 * a `GET` would deliver, and no body — that is the whole point of offering it, so a client
 * can check size and version skew before downloading.
 *
 * The caller wraps every return value in {@link withDataPlaneCatalogResponseHeaders};
 * cache and hygiene headers are deliberately owned there rather than repeated per branch.
 */
export async function buildDataPlaneCatalogResponse(method: "GET" | "HEAD"): Promise<Response> {
  const { catalogDistributionHeaders, materializeCatalogDistribution } = await import("../codex/catalog/distribution");
  const catalog = await materializeCatalogDistribution();
  if (catalog.status === "missing") {
    // A distinct code, not the bare `not_found` an unknown /v1/* path returns: a client
    // script has to tell "this proxy has no such route" from "this proxy has no catalog
    // yet". Neither answer names a path on the operator's disk.
    return formatErrorResponse(404, "catalog_not_found", "Codex catalog is not materialized");
  }
  if (catalog.status === "unsafe") {
    // Content-free by contract: the shared safety walk returns only a verdict, so this
    // branch cannot echo the key or value that made the document unsafe.
    return new Response(JSON.stringify({
      error: {
        type: "server_error",
        code: "catalog_unsafe",
        message: "catalog document contains values that are not safe to distribute",
      },
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (catalog.status === "source-too-large") {
    // Says only what is known: the stored file was too large to read safely. Nothing was
    // parsed, so the serialized size is genuinely unknown here and must not be asserted.
    return catalogSizeRefusal(
      "catalog_source_too_large",
      "stored catalog exceeds the safe source read limit",
    );
  }
  if (catalog.byteLength > DATA_PLANE_CATALOG_MAX_BYTES) {
    return catalogSizeRefusal(
      "catalog_too_large",
      `catalog document exceeds the ${DATA_PLANE_CATALOG_MAX_BYTES} byte data-plane limit`,
    );
  }
  const headers = new Headers(catalogDistributionHeaders(catalog));
  if (method === "HEAD") {
    headers.set("Content-Length", String(catalog.byteLength));
    return new Response(null, { status: 200, headers });
  }
  return new Response(catalog.body, { status: 200, headers });
}
