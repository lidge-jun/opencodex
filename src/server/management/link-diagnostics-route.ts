import { LINK_DIAGNOSTICS_DEFAULT_LIMIT, LINK_DIAGNOSTICS_MAX_LIMIT, LINK_DIAGNOSTICS_SCHEMA, readLinkDiagnostics } from "../../link/diagnostics-read";

export const LINK_DIAGNOSTICS_ROUTE = "/api/link/diagnostics";

function integerParam(url: URL, name: string, min: number, max: number): number | undefined | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * The body of `GET /api/link/diagnostics`: this runtime's bounded link diagnostics, re-sanitized
 * on read by `readLinkDiagnostics`. It reads the file and nothing else, needs no link lifecycle,
 * and omits the local file path. Callers authorize first: `link-routes.ts` on a standalone, Home
 * or Hub, and `src/client/machine-listener.ts` (dashboard session only) on a connected Child.
 * Kept free of the link route state so the Child's listener can serve it without that graph.
 */
export async function linkDiagnosticsResponse(url: URL): Promise<Response> {
  const limit = integerParam(url, "limit", 1, LINK_DIAGNOSTICS_MAX_LIMIT);
  const since = integerParam(url, "since", 0, Number.MAX_SAFE_INTEGER);
  if (limit === null || since === null) {
    return Response.json({ error: { code: "invalid_query", message: "limit must be 1-" + LINK_DIAGNOSTICS_MAX_LIMIT + " and since a non-negative epoch-millisecond time." } },
      { status: 400, headers: { "cache-control": "no-store" } });
  }
  const result = await readLinkDiagnostics({ limit: limit ?? LINK_DIAGNOSTICS_DEFAULT_LIMIT, since });
  return Response.json({ schema: LINK_DIAGNOSTICS_SCHEMA, ...result }, { headers: { "cache-control": "no-store" } });
}
