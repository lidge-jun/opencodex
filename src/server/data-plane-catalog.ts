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
 * boundary `/api/catalog` uses, so there is exactly one catalog serializer. What this
 * module owns is the data-plane transport contract: read-only methods, a declared
 * response ceiling, cache policy, and the data-plane error envelope.
 */

/** Methods this surface serves. The catalog is read-only; no `/v1` mutation exists. */
export const DATA_PLANE_CATALOG_ALLOWED_METHODS = "GET, HEAD";

/**
 * Declared ceiling on the catalog document this route will ship.
 *
 * Not a memory guard — the document is already resident once it has been read and
 * serialized. It is a stated upper bound for the remote half of the workflow: a client
 * redirecting this route into `opencodex-catalog.json` gets a bounded file or a
 * deterministic refusal, never an unbounded stream. A real generated catalog is orders of
 * magnitude below this, so the bound refuses only a pathological document.
 *
 * The management route keeps its existing unbounded behavior. The bound is specific to the
 * remotely reachable transport, which is the surface that needs one.
 */
export const DATA_PLANE_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

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
 * Serve the catalog to an already-admitted data-plane caller.
 *
 * `HEAD` answers with the status and headers `GET` would produce, including the byte count
 * a `GET` would deliver, and no body — that is the whole point of offering it, so a client
 * can check size and version skew before downloading.
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
  if (catalog.byteLength > DATA_PLANE_CATALOG_MAX_BYTES) {
    return new Response(JSON.stringify({
      error: {
        type: "server_error",
        code: "catalog_too_large",
        message: `catalog document exceeds the ${DATA_PLANE_CATALOG_MAX_BYTES} byte data-plane limit`,
      },
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const headers = new Headers({
    ...catalogDistributionHeaders(catalog),
    // The catalog tracks live provider, model-visibility, and account-selector state, and
    // this response is served per credential. A shared intermediary must not keep a copy to
    // hand to the next caller, nor serve a stale one after an operator changes visibility.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (method === "HEAD") {
    headers.set("Content-Length", String(catalog.byteLength));
    return new Response(null, { status: 200, headers });
  }
  return new Response(catalog.body, { status: 200, headers });
}
