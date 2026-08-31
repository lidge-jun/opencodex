/**
 * URL policy for Ollama's native REST API.
 *
 * The built-in Ollama provider historically stored an OpenAI-compatible `/v1` base URL.  The
 * native adapter deliberately canonicalizes that compatibility spelling only for Ollama's known
 * local/cloud hosts.  An arbitrary custom host with a `/v1` path is never silently rewritten.
 */

export type OllamaNativeEndpointKind = "local" | "cloud" | "custom";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const CLOUD_HOSTNAMES = new Set(["ollama.com"]);
const REJECTED_CLOUD_ALIAS_HOSTNAMES = new Set(["www.ollama.com"]);

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

function normalizedPath(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

function endpointKind(url: URL): OllamaNativeEndpointKind {
  // WHATWG URL keeps IPv6 brackets in `hostname` on Bun/Node (`[::1]`), while the
  // loopback policy is stored in its canonical host form (`::1`).
  const hostname = normalizedHostname(url);
  if (REJECTED_CLOUD_ALIAS_HOSTNAMES.has(hostname)) {
    throw new Error("ollama-native requires canonical Ollama Cloud host ollama.com; www.ollama.com is rejected");
  }
  if (LOCAL_HOSTNAMES.has(hostname)) return "local";
  if (CLOUD_HOSTNAMES.has(hostname)) return "cloud";
  return "custom";
}

function assertCloudTransport(url: URL, kind: OllamaNativeEndpointKind): void {
  if (kind !== "cloud") return;
  if (url.protocol !== "https:") {
    throw new Error("ollama-native canonical Ollama Cloud requires HTTPS");
  }
  if (url.port) {
    throw new Error("ollama-native canonical Ollama Cloud rejects non-default ports");
  }
}

function parseBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("ollama-native requires a non-empty baseUrl");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("ollama-native requires an absolute http(s) baseUrl");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ollama-native only supports http(s) base URLs");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ollama-native baseUrl must not contain credentials, a query, or a fragment");
  }
  return url;
}

/** Return the endpoint family used by native authentication policy. */
export function ollamaNativeEndpointKind(baseUrl: string): OllamaNativeEndpointKind {
  const url = parseBaseUrl(baseUrl);
  const kind = endpointKind(url);
  assertCloudTransport(url, kind);
  return kind;
}

/** True when the base URL points at canonical Ollama Cloud (not a self-hosted destination). */
export function isCanonicalOllamaCloudUrl(baseUrl: string): boolean {
  return ollamaNativeEndpointKind(baseUrl) === "cloud";
}

/**
 * Build the native chat endpoint from a configured base URL.
 *
 * Recognized compatibility forms on canonical Ollama hosts:
 *   - `/`, `/api`, `/api/chat`
 *   - legacy `/v1` and `/v1/chat/completions`
 *
 * For an unrelated custom host only `/`, `/api`, and `/api/chat` are accepted.  In particular,
 * `/v1` is rejected instead of being stripped or guessed at.
 */
export function ollamaNativeChatUrl(baseUrl: string): string {
  const url = parseBaseUrl(baseUrl);
  const kind = endpointKind(url);
  assertCloudTransport(url, kind);
  const path = normalizedPath(url);
  const canonicalPaths = new Set(["", "/api", "/api/chat", "/v1", "/v1/chat/completions"]);
  const customPaths = new Set(["", "/api", "/api/chat"]);

  if (kind === "custom" && !customPaths.has(path)) {
    throw new Error(
      `ollama-native refuses custom baseUrl path "${path || "/"}"; use a native root, /api, or /api/chat`,
    );
  }
  if (kind !== "custom" && !canonicalPaths.has(path)) {
    throw new Error(
      `ollama-native refuses Ollama baseUrl path "${path || "/"}"; use root, /v1, /api, or /api/chat`,
    );
  }

  if (kind === "cloud") url.hostname = normalizedHostname(url);
  url.pathname = "/api/chat";
  return url.toString();
}
