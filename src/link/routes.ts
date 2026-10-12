const CONTEXT_PATHS = new Set([
  "/v1/alpha/history/v2/list_windows",
  "/v1/alpha/history/v2/list_items",
  "/v1/alpha/history/v2/read_item",
  "/v1/alpha/history/v2/search_contents",
  "/v1/alpha/notes/v2/thread_hint",
  "/v1/alpha/notes/v2/list_files_by_prefix",
  "/v1/alpha/notes/v2/read_file",
  "/v1/alpha/notes/v2/search_contents",
  "/v1/alpha/notes/v2/append_to_file",
  "/v1/alpha/notes/v2/write_file",
]);

/** The link socket is an HTTP data plane; every upgrade header is rejected first. */
export function linkRouteAllowed(url: URL, req: Request): boolean {
  if (req.headers.has("upgrade")) return false;
  const { pathname } = url;
  if (pathname === "/readyz") return req.method === "GET";
  if (pathname === "/v1/catalog" || pathname === "/v1/hub-state") {
    return req.method === "GET" || req.method === "HEAD";
  }
  if (pathname === "/v1/usage" || pathname === "/v1/models") return req.method === "GET";
  if (pathname === "/v1/responses" || pathname === "/v1/responses/compact"
    || pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens"
    || pathname === "/v1/chat/completions" || pathname === "/v1/audio/transcriptions"
    || pathname === "/v1/alpha/search" || pathname === "/v1/images/generations"
    || pathname === "/v1/images/edits" || pathname === "/v1/live"
    || pathname === "/v1/realtime/calls" || CONTEXT_PATHS.has(pathname)) {
    return req.method === "POST";
  }
  return req.method === "GET" && pathname.startsWith("/v1/opencodex/artifacts/");
}
