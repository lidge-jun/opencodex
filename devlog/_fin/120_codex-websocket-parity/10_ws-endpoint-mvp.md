# 120.10 — 120.2 WS Endpoint MVP (Option A: Codex-Facing WS Bridge)

## Objective

Add a Responses **WebSocket server** at `/v1/responses` so Codex's WS-first transport works
through `ocx` for **every** model. Strategy: **re-frame the existing SSE bridge output onto the
socket** — the WS path consumes the same `bridgeToResponsesSSE` / passthrough `ReadableStream`
and sends each frame's JSON as a WS Text message. This reuses RC1 (terminal guarantee), RC2
(abort on disconnect), RC3 (heartbeat), and the 100.5/110 error classifier **unchanged**, so WS
and HTTP/SSE are guaranteed identical event semantics. No upstream change; the upstream read
stays HTTP/SSE.

Satisfies the minimum server obligations in `01_codex-ws-protocol-analysis.md §7`.

## Evidence

opencodex pipeline + integration point:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:87-223   handleResponses (parse→route→oauth→vision→web-search→adapter→bridge)
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:141-162  passthrough → Response(relayWithAbort(body))   (SSE bytes)
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:202-223  routed stream → bridgeToResponsesSSE(...) → SSE Response
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:508-510  Bun.serve({ fetch }) — add `websocket` handler here
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:547-559  POST /v1/responses — add WS upgrade beside it
```

Codex WS contract this satisfies:

```text
01_codex-ws-protocol-analysis.md §4  client sends response.create / response.processed (Text)
01_codex-ws-protocol-analysis.md §5  server streams events; terminal = response.completed
01_codex-ws-protocol-analysis.md §6  text-only; client EOF = cancel; server Ping auto-Pong
```

> **Implementation note (as shipped):** the actual implementation used a lower-risk variant of
> the extraction below — the WS handler builds a synthetic `Request` and calls `handleResponses`
> **unchanged**, then re-frames its `Response.body` SSE onto the socket (cancelling the reader on
> close = RC2 abort). This avoids the `handleResponsesCore` refactor while achieving identical
> behavior. The `CoreResult` extraction (below) remains a valid alternative if the pipeline ever
> needs a non-Response return shape. Verified live: WS upgrade → `response.create` → real
> opencode-go bridge → `response.completed` (26 frames, content deltas present).

## Design

1. **Extract `handleResponsesCore`** from `handleResponses`: everything after the JSON body is
   obtained becomes a function that returns a discriminated result instead of an HTTP `Response`.
   `handleResponses` (HTTP) wraps it into a `Response` exactly as today; the WS handler consumes
   the `stream` variant.
2. **Re-frame SSE → WS** in a new `src/ws-bridge.ts`: read the `ReadableStream`, split on
   `\n\n`, send each frame's `data:` JSON as a Text message; drop `data: [DONE]` (WS terminal is
   `response.completed`); the bridge's `response.heartbeat` frames re-frame as-is and re-arm
   Codex's WS idle timer (`01_§5` unknown-type ignore).
3. **Wire Bun.serve**: upgrade `/v1/responses` WS requests; per-connection state runs the
   pipeline per `response.create`; `close` aborts the upstream (RC2 parity).

## Files

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/src/ws-bridge.ts
```

Complete content:

```ts
import type { ServerWebSocket } from "bun";

export interface WsData {
  headers?: Headers;           // inbound upgrade headers, captured at upgrade and threaded to the pipeline
  abort?: () => void;          // set per-turn so close() can abort the upstream (RC2 parity)
}

// Re-frame the existing SSE bridge/passthrough output onto a WebSocket. The frames' JSON already
// carries { type, sequence_number, ... }, so each is sent verbatim as a Text message. [DONE] is
// dropped (WS terminal is response.completed); response.heartbeat frames pass through and re-arm
// Codex's idle timer (unknown type → ignored, 01_§5).
export async function pumpSseToWebSocket(
  ws: ServerWebSocket<WsData>,
  sseStream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = sseStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split("\n").find(l => l.startsWith("data: "));
        if (!dataLine) continue;
        const payload = dataLine.slice(6);
        if (payload === "[DONE]") continue;     // WS terminal is response.completed
        if (ws.readyState === 1 /* OPEN */) ws.send(payload);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts
```

**(a) Extract `handleResponsesCore`.** Change `handleResponses` to obtain the body, then delegate.
The existing pipeline body (`server.ts:95-223`) moves verbatim into `handleResponsesCore`, with
its `return new Response(...)` / `return formatErrorResponse(...)` sites returning a tagged
result instead:

```ts
type CoreResult =
  | { kind: "stream"; stream: ReadableStream<Uint8Array>; onAbort: () => void }
  | { kind: "passthrough"; response: Response; onAbort: () => void }
  | { kind: "json"; json: Record<string, unknown> }
  | { kind: "error"; status: number; type: string; message: string };

async function handleResponsesCore(
  body: unknown, headers: Headers, config: OcxConfig, logCtx: { model: string; provider: string },
): Promise<CoreResult> {
  // The current handleResponses body moves here verbatim (parse/route/oauth/vision/web-search/
  // adapter/bridge), with each `return` rewritten 1:1 by current line:
  //   :141-161 passthrough     →  return { kind: "passthrough", response: <the Response>, onAbort: () => upstream.abort() };
  //   :202-222 routed stream   →  return { kind: "stream", stream: sseStream, onAbort: () => upstream.abort() };
  //   :223+    non-stream      →  return { kind: "json", json: buildResponseJSON(eventStream, parsed.modelId) };
  //   every formatErrorResponse(status,type,msg) site  →  return { kind: "error", status, type, message: msg };
  // `req.headers` usages become the `headers` param. The web-search branch (:168-178) returns a
  // Response today; wrap its result as { kind: "passthrough", response, onAbort } so WS gets it too.
}

// HTTP keeps today's behavior:
async function handleResponses(req: Request, config: OcxConfig, logCtx: { model: string; provider: string }): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch { return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body"); }
  const r = await handleResponsesCore(body, req.headers, config, logCtx);
  switch (r.kind) {
    case "stream": return new Response(r.stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
    case "passthrough": return r.response;
    case "json": return jsonResponse(r.json);
    case "error": return formatErrorResponse(r.status, r.type, r.message);
  }
}
```

> The HTTP responses are byte-identical to today — this is a pure extraction. Verify the existing
> suite stays green before adding WS.

**(b) Add the WS upgrade + handler in `Bun.serve`** (`server.ts:508-565`):

```diff
+import { pumpSseToWebSocket, type WsData } from "./ws-bridge";
@@
   const server = Bun.serve({
     port: listenPort,
     async fetch(req) {
       const url = new URL(req.url);
@@
+      // Responses WebSocket (phase 120). Codex upgrades the same /v1/responses path (01_§2).
+      if (url.pathname === "/v1/responses" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
+        // Capture inbound headers at upgrade (auth is handshake-time only on the WS path, 01_§3).
+        if (server.upgrade<WsData>(req, { data: { headers: req.headers } })) return undefined as unknown as Response;
+        return formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed");
+      }
@@
       return formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`);
     },
+    websocket: {
+      async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
+        let frame: { type?: string } & Record<string, unknown>;
+        try { frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()); }
+        catch { return; } // text-only contract; ignore unparseable
+        if (frame.type === "response.processed") return; // ack — no-op (01_§7.6)
+        if (frame.type !== "response.create") return;
+        const { type: _t, ...payload } = frame;          // payload == Responses request body
+        const logCtx = { model: "unknown", provider: "unknown" };
+        const r = await handleResponsesCore(payload, ws.data.headers ?? new Headers(), config, logCtx);
+        if (r.kind === "error") {
+          ws.send(JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: r.message, type: r.type, code: null } } }));
+          return;
+        }
+        if (r.kind === "json") { ws.send(JSON.stringify({ type: "response.completed", response: r.json })); return; }
+        const stream = r.kind === "stream" ? r.stream : r.response.body!;
+        ws.data.abort = r.onAbort;
+        await pumpSseToWebSocket(ws, stream);
+      },
+      close(ws: ServerWebSocket<WsData>) { ws.data.abort?.(); }, // RC2: abort upstream on client disconnect
+    },
   });
```

> **Auth (`01_§3`):** WS auth is handshake-time only — there is no per-frame token. The upgrade
> captures `req.headers` into `ws.data.headers`, and the message handler threads them into
> `handleResponsesCore` (exactly as the HTTP path passes `req.headers`). In practice routed
> providers authenticate via the configured `apiKey`/OAuth **inside** the pipeline, so inbound
> headers are usually unused; capturing them keeps parity with HTTP and covers the rare provider
> that reads an inbound header. Native end-to-end upstream auth is `11_`.

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/ws-endpoint.test.ts
```

Integration test: start the server on an ephemeral port, open a `WebSocket` to
`ws://127.0.0.1:<port>/v1/responses`, send a `response.create` for a stub/echo routed model, and
assert the received frames include `response.created` … exactly one `response.completed`, and no
`[DONE]` text frame. (Use a stubbed adapter or a local fake upstream so no paid call is made.)

## Verification

```bash
bun test tests/ws-endpoint.test.ts
bun test tests           # HTTP suite must stay green (extraction is behavior-preserving)
bun x tsc --noEmit
git diff --check
```

Expected:

```text
WS: response.created → … → exactly one response.completed; no [DONE] frame; close aborts upstream
HTTP suite unchanged (handleResponsesCore extraction is byte-identical)
typecheck clean
```

## Effort

~2.5–4 days: extraction (0.5–1d) + ws-bridge + handler (1–1.5d) + tests + edge cases
(close/cancel, multi-turn over one socket) (1–1.5d).

## Commit

```text
[agent] feat: Responses WebSocket endpoint (MVP, re-frames SSE bridge onto WS)
```

## Out of scope (this sub-phase)

- Advertising `supports_websockets` (stays deleted at `codex-catalog.ts:78` until `12_`).
- Native upstream WS (`11_`).
- Real WS `Ping` keep-alive (the re-framed `response.heartbeat` already re-arms the timer; Ping
  is an optional optimization noted in `01_§8`).
