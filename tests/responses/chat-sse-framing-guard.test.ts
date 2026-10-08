import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let previousHome: string | undefined;
let home: string;
let releaseSpendHome: () => void;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-chat-sse-framing-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(async () => {
  releaseSpendHome();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  await removeTreeWithRetry(home);
});

const encoder = new TextEncoder();
function event(name: string, newline: string, delimiter = newline + newline): string {
  const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name, arguments: "{}", status: "completed" };
  return `: ignored${newline}event: response.output_item.done${newline}data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}${delimiter}`;
}
function terminal(newline: string): string {
  return `event: response.completed${newline}data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}${newline}${newline}`;
}

async function request(chunks: string[], stream: boolean, live = false, wire: "chat" | "responses" = "chat") {
  let requests = 0;
  let cancelled = false;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "openai-responses", baseUrl: "https://sse-framing.invalid/v1", authMode: "key",
    apiKey: "fixture-key", models: ["model"],
    // Own the executor: DNS-pinned egress does not necessarily use globalThis.fetch.
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://sse-framing.invalid/v1/responses");
      requests += 1;
      let index = 0;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            cancelled = true;
            try { controller.close(); } catch { /* already closed or cancelled */ }
          }, { once: true });
        },
        pull(controller) {
          if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
          else if (!live) controller.close();
        },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  };
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: provider } };
  const handler = wire === "responses" ? handleResponses : handleChatCompletions;
  const input = wire === "responses"
    ? { input: "fixture", tools: [{ type: "function", name: "declared_tool", parameters: { type: "object" } }] }
    : { messages: [{ role: "user", content: "fixture" }],
      tools: [{ type: "function", function: { name: "declared_tool", parameters: { type: "object" } } }] };
  const endpoint = wire === "responses" ? "/v1/responses" : "/v1/chat/completions";
  const response = await handler(new Request(`http://localhost${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", stream, ...input }),
  }), config, { model: "", provider: "" });
  expect(requests).toBe(1);
  return { response, cancelled: () => cancelled };
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
      }
    })(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("SSE completion waited for EOF")), 2_000);
    })]);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

describe("Responses-to-Chat shared SSE security framing", () => {
  test.each([[true, false], [false, false], [true, true], [false, true]])(
    "chat relays CR-hidden undeclared calls (stream=%s, fragmented=%s)", async (stream, fragmented) => {
    const wire = event("unlisted_tool", "\r", "\r\r\n\n") + terminal("\n");
    const { response } = await request(fragmented ? [...wire] : [wire], stream);
    const text = await readBounded(response);
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"name":"unlisted_tool"');
    expect(text).toContain('"id":"call_fixture"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).not.toContain("undeclared client tool");
    expect(text).not.toContain('"error"');
  });
  test.each(["\n", "\r\n", "\r"])("keeps declared calls with %j framing", async newline => {
    const { response } = await request([...event("declared_tool", newline), ...terminal(newline)], true);
    const text = await readBounded(response);
    expect(text).toContain('"name":"declared_tool"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).not.toContain('"error"');
  });
  test("delivers a CR-only declared completion before upstream EOF", async () => {
    const result = await request([event("declared_tool", "\r") + terminal("\r")], true, true);
    const text = await readBounded(result.response);
    expect(text).toContain('"name":"declared_tool"');
    expect(text).toContain("[DONE]");
    expect(result.cancelled()).toBe(true);
  });
  test("chat relays consecutive CR-only undeclared events before upstream EOF", async () => {
    const result = await request([event("unlisted_tool", "\r") + terminal("\r")], true, true);
    const text = await readBounded(result.response);
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"name":"unlisted_tool"');
    expect(text).toContain('"id":"call_fixture"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain("[DONE]");
    expect(text).not.toContain("undeclared client tool");
    expect(text).not.toContain('"error"');
    expect(result.cancelled()).toBe(true);
  });
  // #6461 framing protection remains on the refusing inbound wire after #6648.
  test.each([[true, false], [false, false], [true, true], [false, true]])(
    "responses rejects CR-hidden undeclared calls (stream=%s, fragmented=%s)", async (stream, fragmented) => {
    const wire = event("unlisted_tool", "\r", "\r\r\n\n") + terminal("\n");
    const { response } = await request(fragmented ? [...wire] : [wire], stream, false, "responses");
    const text = await readBounded(response);
    expect(text).toContain("routed provider emitted undeclared client tool");
    expect(text).toContain('"error"');
    expect(text).toContain("response.failed");
    expect(text).not.toContain("response.output_item.done");
    expect(text).not.toContain('"type":"function_call"');
    expect(text).not.toContain("response.completed");
  });
  test("responses rejects consecutive CR-only undeclared events before upstream EOF", async () => {
    const result = await request([event("unlisted_tool", "\r") + terminal("\r")], true, true, "responses");
    const text = await readBounded(result.response);
    expect(text).toContain("routed provider emitted undeclared client tool");
    expect(text).toContain('"error"');
    expect(text).toContain("response.failed");
    expect(text).not.toContain("response.output_item.done");
    expect(text).not.toContain('"type":"function_call"');
    expect(text).not.toContain("response.completed");
    expect(result.cancelled()).toBe(true);
  });
});
