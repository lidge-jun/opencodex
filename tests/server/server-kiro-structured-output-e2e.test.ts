import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME, KIRO_STRUCTURED_OUTPUT_TOOL_NAME } from "../../src/adapters/kiro-constants";
import { saveConfig } from "../../src/config";
import { encodeMessage } from "../../src/lib/eventstream-decoder";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// T3 Code titles every thread with a Messages request carrying `output_config.format` json_schema.
// Routed to Kiro it used to be refused locally (HTTP 400, sendCount 0), so no Kiro thread ever got
// a title. These cases drive that exact request shape through the public endpoints.

const enc = new TextEncoder();
const originalFetch = globalThis.fetch;
let testDir = "";
let previousOpenCodexHome: string | undefined;
let previousRegion: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousRegion = process.env.KIRO_REGION;
  isolatedCodexHome = installIsolatedCodexHome("ocx-kiro-structured-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-kiro-structured-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.KIRO_REGION = "us-east-1";
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousRegion === undefined) delete process.env.KIRO_REGION;
  else process.env.KIRO_REGION = previousRegion;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  removeTreeWithRetry(testDir);
});

const eventFrame = (eventType: string, payload: Record<string, unknown>): Uint8Array => encodeMessage(
  { ":message-type": "event", ":event-type": eventType },
  enc.encode(JSON.stringify(payload)),
);
const textFrame = (text: string) => eventFrame("assistantResponseEvent", { content: text });
function structuredFrames(input: Record<string, unknown>, id = "structured-1"): Uint8Array[] {
  return [
    eventFrame("toolUseEvent", { name: KIRO_STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: id }),
    eventFrame("toolUseEvent", { name: KIRO_STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: id, input: JSON.stringify(input) }),
    eventFrame("toolUseEvent", { name: KIRO_STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: id, stop: true }),
  ];
}

/** A local Kiro runtime stand-in that records each request and answers it with the next scripted attempt. */
function scriptedKiroUpstream(attempts: Uint8Array[][]) {
  const requests: Array<Record<string, any>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    /** Record the request and stream the next attempt's frames, or fail on an unexpected extra attempt. */
    async fetch(req) {
      requests.push(await req.json() as Record<string, any>);
      const frames = attempts.shift();
      if (!frames) return new Response("unexpected extra Kiro attempt", { status: 500 });
      let index = 0;
      return new Response(new ReadableStream<Uint8Array>({
        /** Enqueue the next frame, or close the stream after the last one. */
        pull(controller) {
          if (index < frames.length) controller.enqueue(frames[index++]);
          else controller.close();
        },
      }), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
    },
  });
  return { server, requests };
}

function kiroConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kiro-test",
    providers: {
      "kiro-test": {
        adapter: "kiro",
        baseUrl,
        authMode: "key",
        apiKey: "synthetic-token",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["claude-opus-5.5"],
      },
    },
  } as OcxConfig;
}

function sseEvents(sse: string): Array<{ name: string; data: Record<string, any> }> {
  return sse.split("\n\n").flatMap(frame => {
    let name = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    return name && data ? [{ name, data: JSON.parse(data) as Record<string, any> }] : [];
  });
}

const titleSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

/** The title request T3 Code sends through the Claude Agent SDK, byte-for-byte in shape. */
function t3TitleRequest(stream: boolean): Record<string, unknown> {
  return {
    model: "kiro-test/claude-opus-5.5",
    max_tokens: 128000,
    stream,
    output_config: { effort: "medium", format: { type: "json_schema", schema: titleSchema } },
    messages: [{ role: "user", content: "Generate a short title for: fix the Kiro structured output bug" }],
  };
}

async function withProxy<T>(attempts: Uint8Array[][], body: (url: URL, requests: Array<Record<string, any>>) => Promise<T>) {
  const upstream = scriptedKiroUpstream(attempts);
  saveConfig(kiroConfig(upstream.server.url.toString()));
  const proxy = startServer(0);
  try {
    return await body(proxy.url, upstream.requests);
  } finally {
    await proxy.stop(true);
    upstream.server.stop(true);
  }
}

const post = (url: URL, path: string, body: unknown) => originalFetch(new URL(path, url), {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify(body),
});

/** The tool names a captured Kiro request advertises in its current user message. */
function advertisedTools(request: Record<string, any>): string[] {
  return (request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? [])
    .map((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name);
}

describe("Kiro structured output through public server endpoints", () => {
  test("/v1/messages streams the T3 Code title as JSON text with end_turn", async () => {
    await withProxy([structuredFrames({ title: "Fix Kiro structured output" })], async (url, requests) => {
      const response = await post(url, "/v1/messages", t3TitleRequest(true));
      expect(response.status).toBe(200);
      const wire = await response.text();
      const events = sseEvents(wire);
      const deltas = events
        .filter(event => event.name === "content_block_delta" && event.data.delta?.type === "text_delta")
        .map(event => event.data.delta.text as string);
      expect(JSON.parse(deltas.join(""))).toEqual({ title: "Fix Kiro structured output" });
      expect(events.find(event => event.name === "message_delta")?.data.delta.stop_reason).toBe("end_turn");
      expect(events.some(event => event.data.content_block?.type === "tool_use")).toBe(false);
      expect(wire).not.toContain(KIRO_STRUCTURED_OUTPUT_TOOL_NAME);
      expect(requests).toHaveLength(1);
      expect(advertisedTools(requests[0])).toEqual([KIRO_STRUCTURED_OUTPUT_TOOL_NAME]);
    });
  });

  test("/v1/messages non-streaming returns the JSON as the text block", async () => {
    await withProxy([structuredFrames({ title: "Fix Kiro" })], async url => {
      const response = await post(url, "/v1/messages", t3TitleRequest(false));
      expect(response.status).toBe(200);
      const json = await response.json() as { content: Array<{ type: string; text?: string }>; stop_reason: string };
      expect(json.content.map(block => block.type)).toEqual(["text"]);
      expect(JSON.parse(json.content[0].text!)).toEqual({ title: "Fix Kiro" });
      expect(json.stop_reason).toBe("end_turn");
    });
  });

  test("/v1/messages never relays prose: two non-JSON answers end in an error", async () => {
    await withProxy([[textFrame("Here is a title: Fix Kiro")], [textFrame("Fix Kiro")]], async (url, requests) => {
      const response = await post(url, "/v1/messages", t3TitleRequest(false));
      const wire = await response.text();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(wire).toContain("structured output");
      expect(wire).not.toContain("Here is a title");
      expect(requests).toHaveLength(2);
    });
  });

  test("/v1/responses json_schema returns the JSON as output_text", async () => {
    await withProxy([[textFrame("Picking a title."), ...structuredFrames({ title: "Fix Kiro" })]], async (url, requests) => {
      const response = await post(url, "/v1/responses", {
        model: "kiro-test/claude-opus-5.5",
        stream: false,
        input: "Title this thread",
        text: { format: { type: "json_schema", name: "thread_title", schema: titleSchema, strict: true } },
      });
      expect(response.status).toBe(200);
      const json = await response.json() as { output: Array<{ type: string; content?: Array<{ type: string; text: string }> }> };
      const texts = json.output.filter(item => item.type === "message")
        .flatMap(item => item.content ?? []).filter(part => part.type === "output_text").map(part => part.text);
      expect(texts).toEqual(['{"title":"Fix Kiro"}']);
      expect(advertisedTools(requests[0])).not.toContain(KIRO_COMPLETION_TOOL_NAME);
    });
  });
});
