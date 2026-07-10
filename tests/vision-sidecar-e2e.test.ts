import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

// Issue #88: text-only input models (DeepSeek, ...) get "eyes" — the vision sidecar describes
// attached images via a vision-capable forward model and replaces them with text BEFORE the main
// call. These tests observe the fallback path actually firing end-to-end (activation evidence),
// and that models outside `noVisionModels` keep their images untouched (regression guard).

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let sidecar: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-vision-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-vision-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  sidecar?.stop(true);
  sidecar = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";
const CAPTION = "A red square logo with the word OPENCODEX in white monospace text.";

/** Fake ChatGPT forward backend: answers /responses with an SSE caption stream. */
function serveSidecar(onRequest: (req: Request, bodyText: string) => void) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const bodyText = await req.text();
      onRequest(req, bodyText);
      const sse = [
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: CAPTION })}`,
        "",
        "data: [DONE]",
        "", "",
      ].join("\n");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

/** Fake text-only upstream (openai-chat wire): records the forwarded body. */
function serveUpstream(record: (bodyText: string) => void) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      record(await req.text());
      return new Response(JSON.stringify({
        id: "chatcmpl-vision-1", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "I see a red logo." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }), { headers: { "content-type": "application/json" } });
    },
  });
}

function baseRequest(model: string) {
  return {
    model, stream: false,
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "what does this logo say?" },
      { type: "input_image", image_url: PNG_DATA_URL },
    ]}],
  };
}

describe("vision sidecar fallback (issue #88, end-to-end)", () => {
  test("noVisionModels request fires the sidecar and forwards the caption instead of the image", async () => {
    let upstreamBody = "";
    let sidecarBody = "";
    let sidecarAuth: string | null = null;
    let sidecarHits = 0;
    upstream = serveUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar((req, b) => { sidecarHits += 1; sidecarBody = b; sidecarAuth = req.headers.get("authorization"); });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly",
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        chatgpt: { adapter: "openai-responses", authMode: "forward", baseUrl: `http://127.0.0.1:${sidecar.port}` },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("textonly/blind-model")),
      });
      expect(res.status).toBe(200);

      // Activation evidence: the sidecar actually ran, got the image + OAuth passthrough.
      expect(sidecarHits).toBe(1);
      expect(sidecarAuth).toBe("Bearer forward-oauth-token");
      expect(sidecarBody).toContain("input_image");
      expect(sidecarBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");

      // The text-only upstream saw the caption, not the image bytes.
      expect(upstreamBody).toContain(CAPTION);
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("image_url");
    } finally {
      server.stop(true);
    }
  });

  test("models outside noVisionModels keep their image untouched (no sidecar call)", async () => {
    let upstreamBody = "";
    let sidecarHits = 0;
    upstream = serveUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar(() => { sidecarHits += 1; });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "seeing",
      providers: {
        seeing: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        chatgpt: { adapter: "openai-responses", authMode: "forward", baseUrl: `http://127.0.0.1:${sidecar.port}` },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("seeing/vision-model")),
      });
      expect(res.status).toBe(200);
      expect(sidecarHits).toBe(0);
      expect(upstreamBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain(CAPTION);
    } finally {
      server.stop(true);
    }
  });
});
