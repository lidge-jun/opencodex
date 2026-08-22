import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxConfig } from "../src/types";
import { parseRequest } from "../src/responses/parser";
import { resetVisionDescriptionCache, stripImagesInPlace } from "../src/vision";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";

// Issue #88: text-only input models (DeepSeek, ...) get "eyes" — the vision sidecar describes
// attached images via a vision-capable forward model and replaces them with text BEFORE the main
// call. These tests observe the fallback path actually firing end-to-end (activation evidence),
// and that models outside `noVisionModels` keep their images untouched (regression guard).

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let sidecar: ReturnType<typeof Bun.serve> | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-vision-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-vision-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  globalThis.fetch = originalFetch;
  resetVisionDescriptionCache();
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  sidecar?.stop(true);
  sidecar = null;
  globalThis.fetch = originalFetch;
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

/** Fake text-only upstream (openai-responses passthrough wire): records the forwarded body. */
function serveResponsesUpstream(record: (bodyText: string) => void) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      record(await req.text());
      return Response.json({
        id: "resp_vision_1",
        object: "response",
        status: "completed",
        output: [{
          id: "msg_vision_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "I see a red logo.", annotations: [] }],
        }],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      });
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

function toolImageRequest(model: string) {
  return {
    model, stream: false,
    input: [
      {
        type: "function_call", call_id: "call_view_image", name: "view_image",
        arguments: JSON.stringify({ path: "/tmp/screenshot.png" }),
      },
      {
        type: "function_call_output", call_id: "call_view_image",
        output: [
          { type: "input_text", text: "Image loaded." },
          { type: "input_image", image_url: PNG_DATA_URL, detail: "high" },
        ],
      },
    ],
  };
}

describe("vision sidecar fallback (issue #88, end-to-end)", () => {
  test("raw-body normalization removes an image when parsing produces zero captions", () => {
    const parsed = parseRequest({
      model: "textonly/blind-model",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "" }],
      }],
    });

    expect(stripImagesInPlace(parsed)).toBe(false);
    expect(JSON.stringify(parsed._rawBody)).not.toContain("input_image");
    expect(JSON.stringify(parsed._rawBody)).toContain("[image omitted:");
  });

  test("noVisionModels request fires the sidecar and forwards the caption instead of the image", async () => {
    let upstreamBody = "";
    let sidecarBody = "";
    let sidecarAuth: string | null = null;
    let sidecarAccount: string | null = null;
    let sidecarPath = "";
    let sidecarHits = 0;
    upstream = serveUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar((req, b) => {
      sidecarHits += 1;
      sidecarBody = b;
      sidecarAuth = req.headers.get("authorization");
      sidecarAccount = req.headers.get("chatgpt-account-id");
      sidecarPath = new URL(req.url).pathname;
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      const prefix = "/backend-api/codex";
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
        return originalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, sidecar!.url), init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly", openaiProviderTierVersion: 2,
      providers: {
        textonly: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex///",
          codexAccountMode: "direct",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const token = fakeChatGptJwt({ chatgpt_account_id: "acct-vision-sidecar" });
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-vision-sidecar",
        },
        body: JSON.stringify(baseRequest("textonly/blind-model")),
      });
      expect(res.status).toBe(200);

      // Activation evidence: the sidecar actually ran, got the image + OAuth passthrough.
      expect(sidecarHits).toBe(1);
      expect(sidecarPath).toBe("/responses");
      expect(sidecarAuth).toBe(`Bearer ${token}`);
      expect(sidecarAccount).toBe("acct-vision-sidecar");
      expect(sidecarBody).toContain("input_image");
      expect(sidecarBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");

      // The text-only upstream saw the caption, not the image bytes.
      expect(upstreamBody).toContain(CAPTION);
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("image_url");
    } finally {
      await server.stop(true);
    }
  });

  test("Responses passthrough removes every raw image when fewer captions than images are produced", async () => {
    let upstreamBody = "";
    let sidecarHits = 0;
    upstream = serveResponsesUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar(() => { sidecarHits += 1; });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      const prefix = "/backend-api/codex";
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
        return originalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, sidecar!.url), init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly", openaiProviderTierVersion: 2,
      providers: {
        textonly: {
          adapter: "openai-responses",
          authMode: "key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const token = fakeChatGptJwt({ chatgpt_account_id: "acct-vision-sidecar" });
      const request = baseRequest("textonly/blind-model");
      request.input[0].content.splice(1, 0, { type: "input_image", image_url: "" });
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-vision-sidecar",
        },
        body: JSON.stringify(request),
      });
      expect(res.status).toBe(200);
      expect(sidecarHits).toBe(1);
      expect(upstreamBody).toContain(CAPTION);
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("input_image");
    } finally {
      await server.stop(true);
    }
  });

  test("Responses passthrough replaces an image returned by a client tool", async () => {
    let upstreamBody = "";
    let sidecarHits = 0;
    upstream = serveResponsesUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar(() => { sidecarHits += 1; });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      const prefix = "/backend-api/codex";
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
        return originalFetch(new URL(`${url.pathname.slice(prefix.length)}${url.search}`, sidecar!.url), init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly", openaiProviderTierVersion: 2,
      providers: {
        textonly: {
          adapter: "openai-responses",
          authMode: "key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: {
          adapter: "openai-responses",
          authMode: "forward",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountMode: "direct",
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const token = fakeChatGptJwt({ chatgpt_account_id: "acct-vision-sidecar" });
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-vision-sidecar",
        },
        body: JSON.stringify(toolImageRequest("textonly/blind-model")),
      });
      expect(res.status).toBe(200);
      expect(sidecarHits).toBe(1);
      expect(upstreamBody).toContain(CAPTION);
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("image_url");
    } finally {
      await server.stop(true);
    }
  });

  test("Responses passthrough strips images when no vision sidecar is available", async () => {
    let upstreamBody = "";
    upstream = serveResponsesUpstream(b => { upstreamBody = b; });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "textonly",
      providers: {
        textonly: {
          adapter: "openai-responses",
          authMode: "key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseRequest("textonly/blind-model")),
      });
      expect(res.status).toBe(200);
      expect(upstreamBody).toContain("[image omitted: this model is text-only and the vision sidecar is unavailable (no ChatGPT login)]");
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("image_url");
    } finally {
      await server.stop(true);
    }
  });

  test("models outside noVisionModels keep their image untouched (no sidecar call)", async () => {
    let upstreamBody = "";
    let sidecarHits = 0;
    upstream = serveUpstream(b => { upstreamBody = b; });
    sidecar = serveSidecar(() => { sidecarHits += 1; });

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "seeing", openaiProviderTierVersion: 2,
      providers: {
        seeing: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: ["blind-model"],
        },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
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
      await server.stop(true);
    }
  });

  /*
   * #1043 activation evidence. The registry classification is only useful if the
   * strip actually fires for a Zen model, so this drives the real path with the
   * built-in `opencode-zen` list rather than a fixture list, and asserts the
   * observable effect: the image bytes are gone from the upstream body and the
   * omission marker is there instead.
   *
   * `big-pickle` is the id that reproduced the reported 400 verbatim against the
   * live endpoint (devlog/_fin/260805_bug_fix_stack/002_zen_modality_probe.md).
   */
  test("a text-only Zen model has its image stripped before the upstream request (#1043)", async () => {
    let upstreamBody = "";
    upstream = serveUpstream(b => { upstreamBody = b; });

    const zen = PROVIDER_REGISTRY.find(p => p.id === "opencode-zen");
    expect(zen?.noVisionModels).toContain("big-pickle");

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "zenlike", openaiProviderTierVersion: 2,
      providers: {
        // A custom provider carrying the REGISTRY's list verbatim. The built-in
        // opencode-zen entry pins its own baseUrl, so it cannot be aimed at a local
        // upstream; what is under test is the classification, which is read from the
        // registry above rather than written out here.
        zenlike: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: zen?.noVisionModels,
        },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("zenlike/big-pickle")),
      });
      expect(res.status).toBe(200);
      // The effect, not merely a 200: no image bytes on the wire, marker present.
      expect(upstreamBody).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).toContain("[image omitted");
    } finally {
      await server.stop(true);
    }
  });

  test("a vision-capable Zen model keeps its image (#1043 negative case)", async () => {
    let upstreamBody = "";
    upstream = serveUpstream(b => { upstreamBody = b; });

    const zen = PROVIDER_REGISTRY.find(p => p.id === "opencode-zen");
    // Measured as accepting images; classifying it would silently degrade it.
    expect(zen?.noVisionModels).not.toContain("mimo-v2.5-free");

    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "zenlike", openaiProviderTierVersion: 2,
      providers: {
        zenlike: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "key-alpha-000111222333",
          noVisionModels: zen?.noVisionModels,
        },
        openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer forward-oauth-token" },
        body: JSON.stringify(baseRequest("zenlike/mimo-v2.5-free")),
      });
      expect(res.status).toBe(200);
      expect(upstreamBody).toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
      expect(upstreamBody).not.toContain("[image omitted");
    } finally {
      await server.stop(true);
    }
  });
});
