/** Backend path and opt-in config compatibility for native Codex history/notes. */
export const CONTEXT_BACKEND_PREFIX = "/backend-api/codex";

const CONTEXT_ENDPOINTS = new Set([
  "alpha/history/v2/list_windows", "alpha/history/v2/list_items",
  "alpha/history/v2/read_item", "alpha/history/v2/search_contents",
  "alpha/notes/v2/thread_hint", "alpha/notes/v2/list_files_by_prefix",
  "alpha/notes/v2/read_file", "alpha/notes/v2/search_contents",
  "alpha/notes/v2/append_to_file", "alpha/notes/v2/write_file",
]);

export function contextEndpoint(path: string): string | undefined {
  const endpoint = path.startsWith("/v1/") ? path.slice(4) : "";
  return CONTEXT_ENDPOINTS.has(endpoint) ? endpoint : undefined;
}

/** Alias only the data-plane prefix. Existing auth/origin and route gates still run. */
export function codexCompatibleUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.pathname === CONTEXT_BACKEND_PREFIX || url.pathname.startsWith(CONTEXT_BACKEND_PREFIX + "/")) {
    url.pathname = "/v1" + url.pathname.slice(CONTEXT_BACKEND_PREFIX.length);
  }
  return url;
}

/** Change only marker-managed built-in routing, and only with an explicit context opt-in. */
export function contextCompatibleBaseLine(content: string, line: string): string {
  const parsed = Bun.TOML.parse(content) as {features?: {context_management?: {experimental_mode?: boolean}}};
  if (parsed.features?.context_management?.experimental_mode !== true) return line;
  const match = /^openai_base_url = "([^"]+)"$/.exec(line);
  if (!match) return line;
  const url = new URL(match[1]);
  if (url.pathname !== "/v1" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return line;
  url.pathname = CONTEXT_BACKEND_PREFIX;
  return `openai_base_url = "${url.href}"`;
}
