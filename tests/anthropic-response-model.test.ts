import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredential } from "../src/oauth/store";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const config = {
  port: 0,
  defaultProvider: "anthropic",
  providers: {
    anthropic: {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "oauth",
      models: ["claude-sonnet-5"],
    },
  },
} as unknown as OcxConfig;

const streamingMessage = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

describe("Anthropic Codex-facing response model", () => {
  const originalHome = process.env.OPENCODEX_HOME;
  let originalFetch: typeof fetch;
  let home: string;
  let upstreamModels: string[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ocx-anthropic-response-model-"));
    process.env.OPENCODEX_HOME = home;
    await saveCredential("anthropic", {
      access: "anthropic-access-test",
      refresh: "anthropic-refresh-test",
      expires: Date.now() + 3_600_000,
      accountId: `response-model-${Date.now()}`,
    });
    originalFetch = globalThis.fetch;
    upstreamModels = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; stream?: boolean };
      upstreamModels.push(body.model ?? "");
      if (body.stream) {
        return new Response(streamingMessage, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("keeps a provider-qualified selector in streaming Responses output", async () => {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-5", input: "reply OK", stream: true }),
    }), config, { model: "", provider: "" });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(upstreamModels).toEqual(["claude-sonnet-5"]);
    expect(text).toContain('"model":"anthropic/claude-sonnet-5"');
    expect(text).not.toContain('"model":"claude-sonnet-5"');
  });

  test("heals a legacy bare selector in non-streaming Responses output", async () => {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", input: "reply OK", stream: false }),
    }), config, { model: "", provider: "" });

    const json = await response.json() as { model?: string };
    expect(response.status).toBe(200);
    expect(upstreamModels).toEqual(["claude-sonnet-5"]);
    expect(json.model).toBe("anthropic/claude-sonnet-5");
  });
});
