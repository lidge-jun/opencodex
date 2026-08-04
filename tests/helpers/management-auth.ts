import { configuredAdminToken } from "../../src/lib/admin-secrets";

function isLocalManagementRequest(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://127.0.0.1");
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    return loopback && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Test transport: authenticate local management requests without changing data/upstream traffic. */
export function managementFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isLocalManagementRequest(input)) return globalThis.fetch(input, init);
  const headers = managementHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has("x-opencodex-api-key")) return globalThis.fetch(input, init);
  if (input instanceof Request) {
    return globalThis.fetch(new Request(input, { headers }), init ? { ...init, headers } : undefined);
  }
  return globalThis.fetch(input, { ...init, headers });
}

/** Headers for callers that must retain a captured fetch implementation. */
export function managementHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  const token = configuredAdminToken();
  if (token && !headers.has("x-opencodex-api-key")) headers.set("x-opencodex-api-key", token);
  return headers;
}

/** Direct-handler test request with the Host header an actual HTTP server would provide. */
export class ManagementRequest extends globalThis.Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const raw = input instanceof globalThis.Request ? input.url : String(input);
    const url = new URL(raw, "http://127.0.0.1");
    const headers = new Headers(init?.headers ?? (input instanceof globalThis.Request ? input.headers : undefined));
    if (isLocalManagementRequest(input) && !headers.has("Host")) headers.set("Host", url.host);
    super(input, { ...init, headers });
  }
}
