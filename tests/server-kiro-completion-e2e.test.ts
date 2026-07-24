import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME } from "../src/adapters/kiro-constants";
import { saveConfig } from "../src/config";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const enc = new TextEncoder();
const originalFetch = globalThis.fetch;

let testDir = "";
let previousOpenCodexHome: string | undefined;
let previousRegion: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousRegion = process.env.KIRO_REGION;
  isolatedCodexHome = installIsolatedCodexHome("ocx-kiro-completion-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-kiro-completion-"));
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
  rmSync(testDir, { recursive: true, force: true });
});

function eventFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return encodeMessage(
    { ":message-type": "event", ":event-type": eventType },
    enc.encode(JSON.stringify(payload)),
  );
}

function textFrame(text: string): Uint8Array {
  return eventFrame("assistantResponseEvent", { content: text });
}

function completionFrames(answer: string, id = "completion-1"): Uint8Array[] {
  const input = JSON.stringify({ answer });
  return [
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id, input }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id, stop: true }),
  ];
}

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]);
      else controller.close();
    },
  });
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
        models: ["gpt-5.6-sol"],
      },
    },
  } as OcxConfig;
}

function scriptedKiroUpstream(attempts: Uint8Array[][]) {
  const requests: Array<Record<string, any>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push(await req.json() as Record<string, any>);
      const frames = attempts.shift();
      if (!frames) return new Response("unexpected extra Kiro attempt", { status: 500 });
      return new Response(streamOf(frames), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    },
  });
  return { server, requests };
}

function kiroToolNames(request: Record<string, any>): string[] {
  return request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools.map(
    (tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name,
  );
}

function responseEvents(sse: string): Array<{ name: string; data: Record<string, any> }> {
  return sse.split("\n\n").flatMap(frame => {
    let name = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!name || !data) return [];
    return [{ name, data: JSON.parse(data) as Record<string, any> }];
  });
}

function anthropicEvents(sse: string): Array<{ name: string; data: Record<string, any> }> {
  return responseEvents(sse);
}

describe("Kiro completion through public server endpoints", () => {
  test("/v1/responses keeps progress nonterminal and lets only the bounded fallback complete", async () => {
    const upstream = scriptedKiroUpstream([
      [textFrame("Checking the workspace.")],
      completionFrames("The workspace is ready."),
    ]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          input: "Inspect the workspace",
          stream: true,
          tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
        }),
      });

      expect(response.status).toBe(200);
      const wire = await response.text();
      const events = responseEvents(wire);
      const text = events.filter(event => event.name === "response.output_text.delta");
      expect(text.map(event => [event.data.delta, event.data.phase])).toEqual([
        ["Checking the workspace.", undefined],
        ["The workspace is ready.", undefined],
      ]);
      const completed = events.filter(event => event.name === "response.completed");
      expect(completed).toHaveLength(1);
      expect(events.at(-1)?.name).toBe("response.completed");
      const messages = completed[0].data.response.output.filter((item: { type: string }) => item.type === "message");
      expect(messages.map((item: { phase?: string }) => item.phase)).toEqual(["commentary", "final_answer"]);
      expect(wire).not.toContain(KIRO_COMPLETION_TOOL_NAME);

      expect(upstream.requests).toHaveLength(2);
      expect(kiroToolNames(upstream.requests[0])).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
      expect(kiroToolNames(upstream.requests[1])).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
      expect(upstream.requests[1].conversationState.history.at(-1).assistantResponseMessage.content)
        .toBe("Checking the workspace.");
    } finally {
      proxy.stop(true);
      upstream.server.stop(true);
    }
  });

  test.each([
    ["validated completion", completionFrames("The Claude task is complete.")],
    ["accepted text fallback", [textFrame("The Claude task is complete.")]],
  ])("/v1/messages hides the private tool and ends after %s", async (_label, fallbackFrames) => {
    const upstream = scriptedKiroUpstream([
      [textFrame("I am checking the Claude task.")],
      fallbackFrames,
    ]);
    saveConfig(kiroConfig(upstream.server.url.toString()));
    const proxy = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/messages", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "kiro-test/gpt-5.6-sol",
          max_tokens: 256,
          stream: true,
          messages: [{ role: "user", content: "Inspect the Claude task" }],
          tools: [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }],
        }),
      });

      expect(response.status).toBe(200);
      const wire = await response.text();
      const events = anthropicEvents(wire);
      const deltas = events
        .filter(event => event.name === "content_block_delta" && event.data.delta?.type === "text_delta")
        .map(event => event.data.delta.text);
      expect(deltas).toEqual(["I am checking the Claude task.", "The Claude task is complete."]);
      expect(events.filter(event => event.name === "message_delta")).toHaveLength(1);
      expect(events.find(event => event.name === "message_delta")?.data.delta.stop_reason).toBe("end_turn");
      expect(events.at(-1)?.name).toBe("message_stop");
      expect(wire).not.toContain(KIRO_COMPLETION_TOOL_NAME);

      expect(upstream.requests).toHaveLength(2);
      expect(kiroToolNames(upstream.requests[0])).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
      expect(kiroToolNames(upstream.requests[1])).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
    } finally {
      proxy.stop(true);
      upstream.server.stop(true);
    }
  });
});
