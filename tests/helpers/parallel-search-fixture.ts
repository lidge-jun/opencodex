import { packageVersion } from "../../src/lib/package-version";

export const PARALLEL_MCP_URL = "https://mcp.parallel.ai/mcp";
export const PARALLEL_USER_AGENT = `opencodex/${packageVersion()}`;
export const PARALLEL_SOURCE = { title: "Bun HTTP docs", url: "https://bun.com/docs/runtime/http/server#routing" };
export const PARALLEL_EXCERPT = "Bun.serve creates an HTTP server.";

export function startParallelSearchFixture(mode: "success" | "resume" | "error" | "oversized" | "redirect" = "success") {
  const requests: { method: string; rpc?: string; params?: unknown; attribution: string | null;
    hasCredentials: boolean; resumeFrom: string | null; hasSession: boolean }[] = [];
  let pendingId: number | undefined;
  const result = {
    content: [],
    structuredContent: { results: [
      { url: "javascript:alert(1)", excerpts: ["unsafe link"] },
      { ...PARALLEL_SOURCE, excerpts: [PARALLEL_EXCERPT] },
      PARALLEL_SOURCE,
    ] },
  };
  const searchResponse = (id: number | undefined) => ({ jsonrpc: "2.0", id, result });
  const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = request.method === "POST" ? await request.json() as {
        id?: number; method: string; params?: unknown;
      } : undefined;
      const resumeFrom = request.headers.get("last-event-id");
      requests.push({
        method: request.method, rpc: body?.method, params: body?.params,
        attribution: request.headers.get("user-agent"),
        hasCredentials: ["authorization", "cookie", "x-api-key", "x-opencodex-api-key"]
          .some(header => request.headers.has(header)),
        resumeFrom, hasSession: request.headers.has("mcp-session-id"),
      });
      if (request.method === "GET") {
        return resumeFrom === "search-started"
          ? sse(`data: ${JSON.stringify(searchResponse(pendingId))}\n\n`)
          : new Response(null, { status: 405 });
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      switch (body?.method) {
        case "initialize":
          return Response.json({
            jsonrpc: "2.0", id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } },
          }, { headers: { "mcp-session-id": "fixture-session" } });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/call":
          if (mode === "resume") {
            pendingId = body.id;
            return sse("id: search-started\nretry: 1\ndata:\n\n");
          }
          if (mode === "error") return Response.json({
            jsonrpc: "2.0", id: body.id, result: {
              isError: true, content: [{ type: "text", text: "untrusted upstream diagnostic" }],
            },
          });
          if (mode === "oversized") return sse(`data: ${"x".repeat(1_100_000)}`);
          if (mode === "redirect") return Response.redirect(new URL("/unexpected", request.url), 307);
          return sse(`data: ${JSON.stringify(searchResponse(body.id))}\n\n`);
        default:
          return new Response(null, { status: 400 });
      }
    },
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== PARALLEL_MCP_URL) return fetch(input, init);
    return fetch(new URL("/mcp", server.url), init);
  }) as typeof fetch;
  return {
    requests,
    url: server.url,
    async stop() {
      globalThis.fetch = fetch;
      await server.stop(true);
    },
  };
}
