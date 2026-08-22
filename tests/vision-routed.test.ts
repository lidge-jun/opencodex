import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { resetVisionDescriptionCache } from "../src/vision";
import {
  describeImageRouted,
  routedDescribeAdmissionToken,
  VISION_DESCRIBE_TERMINAL_HEADER,
} from "../src/vision/routed-describe";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

// Roadmap 180 (revised): the routed describer loops back through the proxy's
// own chat surface, and its terminal marker is the depth-cap-1 recursion
// fence. The fence test drives the FULL chat-surface path (audit round 3-4:
// a predicate-only test would stay green with the marker broken).

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
const originalEnvToken = process.env.OPENCODEX_API_AUTH_TOKEN;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-vision-routed-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-vision-routed-"));
  process.env.OPENCODEX_HOME = testDir;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  resetVisionDescriptionCache();
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (originalEnvToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = originalEnvToken;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";
const CAPTION = "A dashboard screenshot with a vision sidecar dropdown.";
const SETTINGS = { model: "vlm/qwen-vl", reasoning: "low" as const, timeoutMs: 10_000 };

describe("describeImageRouted unit", () => {
  test("POSTs chat wire with terminal marker and returns the caption", async () => {
    let seen: { url: string; marker: string | null; auth: string | null; apiKey: string | null; body: Record<string, unknown> } | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        seen = {
          url: new URL(req.url).pathname,
          marker: req.headers.get(VISION_DESCRIBE_TERMINAL_HEADER),
          auth: req.headers.get("authorization"),
          apiKey: req.headers.get("x-opencodex-api-key"),
          body: await req.json() as Record<string, unknown>,
        };
        return Response.json({ choices: [{ message: { content: CAPTION } }] });
      },
    });
    try {
      const out = await describeImageRouted(
        PNG_DATA_URL, undefined, "what is this", "vlm/qwen-vl",
        { port: server.port }, SETTINGS, undefined, `http://127.0.0.1:${server.port}`,
      );
      expect(out.error).toBeUndefined();
      expect(out.text).toBe(CAPTION);
      expect(seen!.url).toBe("/v1/chat/completions");
      expect(seen!.marker).toBe("1");
      expect(seen!.auth).toBeNull();
      expect(seen!.apiKey).toBeNull();
      expect(seen!.body.model).toBe("vlm/qwen-vl");
      expect(seen!.body.stream).toBe(false);
      const messages = seen!.body.messages as Array<{ role: string; content: unknown }>;
      expect(messages[0].role).toBe("system");
      const userParts = messages[1].content as Array<{ type: string }>;
      expect(userParts.some(part => part.type === "image_url")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("admission ladder: env token first, then first apiKeys entry, as x-opencodex-api-key", () => {
    expect(routedDescribeAdmissionToken({})).toBeUndefined();
    expect(routedDescribeAdmissionToken({
      apiKeys: [{ id: "a", name: "a", key: "key-1", createdAt: "" }],
    })).toBe("key-1");
    process.env.OPENCODEX_API_AUTH_TOKEN = "env-token";
    expect(routedDescribeAdmissionToken({
      apiKeys: [{ id: "a", name: "a", key: "key-1", createdAt: "" }],
    })).toBe("env-token");
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
  });

  test("error taxonomy: HTTP error is redacted and never throws; invalid image rejected locally", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response("upstream exploded sk-secret-123", { status: 502 }),
    });
    try {
      const out = await describeImageRouted(
        PNG_DATA_URL, undefined, "", "vlm/qwen-vl",
        { port: server.port }, SETTINGS, undefined, `http://127.0.0.1:${server.port}`,
      );
      expect(out.text).toBe("");
      expect(out.error).toContain("routed describe HTTP 502");
      const bad = await describeImageRouted(
        "data:application/pdf;base64,QUJD", undefined, "", "vlm/qwen-vl",
        { port: server.port }, SETTINGS, undefined, `http://127.0.0.1:${server.port}`,
      );
      expect(bad.error).toContain("unsupported image type");
    } finally {
      server.stop(true);
    }
  });
});

describe("chat-surface recursion fence (full path)", () => {
  function textOnlyUpstream(record: (body: string) => void) {
    return Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const body = await req.text();
        record(body);
        // The pipeline may re-emit upstream as a chat STREAM; serve SSE when
        // asked, JSON otherwise.
        if (body.includes('"stream":true')) {
          const chunk = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "text-only", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] };
          const done = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "text-only", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          const sse = [`data: ${JSON.stringify(chunk)}`, "", `data: ${JSON.stringify(done)}`, "", "data: [DONE]", "", ""].join("\n");
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: "chatcmpl-1", object: "chat.completion", created: 0, model: "text-only",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        });
      },
    });
  }

  test("marked POST strips images (no describe); unmarked plans/strips per legacy path", async () => {
    const forwarded: string[] = [];
    upstream = textOnlyUpstream(body => forwarded.push(body));
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "routed",
      providers: {
        routed: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "k",
          noVisionModels: ["text-only"],
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const chatBody = {
        model: "routed/text-only",
        stream: false,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
          ],
        }],
      };
      const marked = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", [VISION_DESCRIBE_TERMINAL_HEADER]: "1" },
        body: JSON.stringify(chatBody),
      });
      expect(marked.status).toBe(200);
      expect(forwarded.length).toBe(1);
      // The marked request must reach the upstream with the image STRIPPED —
      // and, critically, without any inner describe loopback having fired
      // (forwarded.length would be 2 if a describe re-entered).
      expect(forwarded[0]).not.toContain(PNG_DATA_URL.slice(30, 60));

      const unmarked = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chatBody),
      });
      expect(unmarked.status).toBe(200);
      // No sidecar auth in this fixture: the legacy path fail-closes by
      // stripping too, but WITHOUT the marker the vision planner ran (same
      // upstream count increment, no recursion either way).
      expect(forwarded.length).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("routed describer end-to-end: image described via loopback before the text-only main call", async () => {
    const mainBodies: string[] = [];
    const describerBodies: string[] = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const body = await req.text();
        const url = new URL(req.url);
        if (url.port === String(upstream!.port)) {
          // both providers share this fake upstream; disambiguate by model.
        }
        if (body.includes('"model":"vlm"')) {
          describerBodies.push(body);
          return Response.json({
            id: "chatcmpl-vlm", object: "chat.completion", created: 0, model: "vlm",
            choices: [{ index: 0, message: { role: "assistant", content: CAPTION }, finish_reason: "stop" }],
          });
        }
        mainBodies.push(body);
        if (body.includes('"stream":true')) {
          const chunk = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "text-only", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] };
          const done = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "text-only", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          const sse = [`data: ${JSON.stringify(chunk)}`, "", `data: ${JSON.stringify(done)}`, "", "data: [DONE]", "", ""].join("\n");
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: "chatcmpl-1", object: "chat.completion", created: 0, model: "text-only",
          choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        });
      },
    });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "routed",
      visionSidecar: { backend: "routed", model: "vision/vlm" },
      providers: {
        routed: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "k",
          noVisionModels: ["text-only"],
        },
        vision: {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          allowPrivateNetwork: true,
          apiKey: "k",
          modelInputModalities: { vlm: ["text", "image"] },
        },
      },
    } as OcxConfig;
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "routed/text-only",
          stream: false,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "what does the dashboard show" },
              { type: "image_url", image_url: { url: PNG_DATA_URL } },
            ],
          }],
        }),
      });
      expect(res.status).toBe(200);
      // The describer ran exactly once, through the loopback chat surface.
      expect(describerBodies.length).toBe(1);
      expect(describerBodies[0]).toContain("image_url");
      // The main call got the CAPTION text, not the raw image bytes.
      expect(mainBodies.length).toBe(1);
      expect(mainBodies[0]).toContain("described by a vision model");
      expect(mainBodies[0]).toContain(CAPTION.slice(0, 20));
      expect(mainBodies[0]).not.toContain("aGVsbG8taW1hZ2UtYnl0ZXM=");
    } finally {
      server.stop(true);
    }
  });
});
