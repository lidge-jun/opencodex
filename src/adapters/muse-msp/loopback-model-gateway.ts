import { randomBytes } from "node:crypto";
import { MuseMspError } from "./connection";
import { MuseCorrelatedBudget } from "./correlated-budget";
import { holdMuseResponse } from "./response-lifetime";

/**
 * Experimental loopback-only model gateway for an owned, isolated host.
 * It cannot prevent the host from using other network paths and is not a
 * production transport or an authentication mechanism for real accounts.
 */
export function openMuseLoopbackModelGateway(options: {
  upstream: string;
  budget: MuseCorrelatedBudget;
  credential: { matches: (candidate: Uint8Array) => boolean };
  /** Opt in only with a trusted, request-scoped transport; it may rewrite the destination. */
  useRequestTransport?: true;
  /** Prepare without retaining the body; commit only after the send has been admitted. */
  prepareInput?: (body: unknown) => () => void;
}): { baseUrl: string; close: () => void } {
  let upstream: URL;
  try { upstream = new URL(options.upstream); } catch { throw new MuseMspError("invalid_gateway_upstream"); }
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || !upstream.port ||
      upstream.pathname !== "/responses" || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new MuseMspError("invalid_gateway_upstream");
  }
  const capability = randomBytes(32).toString("hex"), pathname = `/${capability}/responses`;
  const shutdown = new AbortController();
  let closed = false;
  const maxBytes = 8 * 1024 * 1024;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, maxRequestBodySize: maxBytes,
    async fetch(req) {
      const url = new URL(req.url);
      if (closed || req.method !== "POST" || url.pathname !== pathname || url.search) return new Response(null, { status: 404 });
      const authorization = req.headers.get("authorization") ?? "";
      if (!authorization.startsWith("Bearer ")) return new Response(null, { status: 403 });
      const candidate = Buffer.from(authorization.slice(7));
      let valid = false;
      try { valid = options.credential.matches(candidate); } finally { candidate.fill(0); }
      if (!valid) return new Response(null, { status: 403 });
      let bytes: ArrayBuffer, body: unknown;
      try {
        bytes = await req.arrayBuffer();
        if (bytes.byteLength > maxBytes) return new Response(null, { status: 413 });
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch { return new Response(null, { status: 400 }); }
      let commitInput: (() => void) | undefined;
      try { commitInput = options.prepareInput?.(body); } catch { return new Response(null, { status: 400 }); }
      let finish: (() => void) | undefined;
      try {
        const dispatch = options.budget.beginDispatch(body, options.useRequestTransport === true);
        finish = dispatch.finish;
        commitInput?.();
        const transport = options.useRequestTransport ? dispatch.providerFetch! : fetch;
        const signals = [req.signal, shutdown.signal, ...(dispatch.signal ? [dispatch.signal] : [])];
        const signal = AbortSignal.any(signals);
        const response = await transport(upstream, { method: "POST", redirect: "manual", signal,
          headers: { authorization, "content-type": "application/json", accept: "text/event-stream" }, body: bytes });
        if (response.status >= 300 && response.status < 400) { finish(); void response.body?.cancel(); return new Response(null, { status: 502 }); }
        return holdMuseResponse(response, finish, signal);
      } catch {
        finish?.();
        return new Response(null, { status: 502 });
      }
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/${capability}`, close() {
    if (closed) return;
    closed = true; shutdown.abort(); server.stop(true);
  } };
}
