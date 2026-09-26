/**
 * Upstream rewrite slot for local plugins.
 *
 * A plugin loaded by `src/plugins/loader.ts` may register a rewriter that sees every
 * provider send at the physical boundary, after the transport was chosen: HTTP in
 * `sendWithConnectionPolicy` and the Codex WebSocket dial in `CodexWsSession`. The rewriter
 * may replace the URL and add or change headers — enough to put a local sidecar (a
 * compression proxy, a recorder) in front of the provider without the core knowing it exists.
 *
 * This module imports nothing, so the request path pays one array-length check when no
 * plugin is installed. A rewriter that throws is disabled for the rest of the process and
 * the send continues unmodified: a broken plugin must never take the proxy down with it.
 */

export type UpstreamTransport = "http" | "websocket";

export interface UpstreamTarget {
  /** Absolute upstream URL. A rewriter may assign a new one. */
  url: string;
  /** Mutable outbound headers. Credentials are present; a rewriter must not log them. */
  headers: Headers;
  readonly transport: UpstreamTransport;
}

export type UpstreamRewriter = (target: UpstreamTarget) => void;

interface Registration {
  readonly name: string;
  readonly rewrite: UpstreamRewriter;
  disabled: boolean;
}

const registrations: Registration[] = [];

export function registerUpstreamRewriter(name: string, rewrite: UpstreamRewriter): () => void {
  const registration: Registration = { name, rewrite, disabled: false };
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
  };
}

export function hasUpstreamRewriters(): boolean {
  return registrations.length > 0;
}

/**
 * Run every active rewriter over one send. Returns the input untouched (same objects) when
 * no rewriter is registered, so the common path allocates nothing.
 */
export function rewriteUpstream<H extends HeadersInit | undefined>(
  url: string,
  headers: H,
  transport: UpstreamTransport,
): { url: string; headers: H | Headers } {
  if (registrations.length === 0) return { url, headers };
  const target: UpstreamTarget = { url, headers: new Headers(headers), transport };
  for (const registration of registrations) {
    if (registration.disabled) continue;
    // A rewriter that edits the target and then throws must not leave a half-rewritten send
    // for the next rewriter or the network.
    const urlBefore = target.url;
    const headersBefore = new Headers(target.headers);
    try {
      registration.rewrite(target);
    } catch (error) {
      target.url = urlBefore;
      target.headers = headersBefore;
      registration.disabled = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[opencodex] plugin "${registration.name}" upstream rewriter disabled after an error: ${reason}`);
    }
  }
  return { url: target.url, headers: target.headers };
}

/** Plain-record variant for callers that hold headers as `Record<string, string>` (WebSocket dial). */
export function rewriteUpstreamRecord(
  url: string,
  headers: Record<string, string>,
  transport: UpstreamTransport,
): { url: string; headers: Record<string, string> } {
  if (registrations.length === 0) return { url, headers };
  const result = rewriteUpstream(url, headers, transport);
  const record: Record<string, string> = {};
  new Headers(result.headers).forEach((value, key) => { record[key] = value; });
  return { url: result.url, headers: record };
}

export function isLoopbackUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * WebSocket dial variant, run for every exchange before a pooled socket is chosen so the pool
 * identity can include the rewritten destination. The caller chose `proxy` for the original
 * destination; a proxy elsewhere on the network cannot reach this machine's loopback, so a
 * rewrite onto a loopback sidecar dials directly. Any other rewrite keeps the caller's proxy.
 */
export function rewriteWebSocketDial(
  url: string,
  headers: Record<string, string>,
  proxy: string | undefined,
): { url: string; headers: Record<string, string>; proxy: string | undefined } {
  if (registrations.length === 0) return { url, headers, proxy };
  const target = rewriteUpstreamRecord(url, headers, "websocket");
  const redirectedToLoopback = target.url !== url && isLoopbackUrl(target.url);
  return { ...target, proxy: redirectedToLoopback ? undefined : proxy };
}

export function resetUpstreamRewritersForTests(): void {
  registrations.length = 0;
}
