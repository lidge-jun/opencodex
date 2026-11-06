import { expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import { responseTurnMembership } from "../../src/server/responses/turn-membership";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

test("authenticated signed history reaches the supplier as the exact buffered reference", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  const previousSigning = process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY;
  const release = acquireOwnedSpendHome();
  process.env.OPENCODEX_API_AUTH_TOKEN = "owned-local-client";
  process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY = "dr_turn_v1_" + Buffer.alloc(32, 23).toString("base64url");
  const config: OcxConfig = {
    port: 0, hostname: "127.0.0.1", defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", allowPrivateNetwork: true, baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-upstream", models: ["owned-model"] } },
  };
  const admission = { kind: "loopback", source: "loopback" } as const;
  const headers = { "content-type": "application/json", "x-opencodex-api-key": "owned-local-client", "thread-id": "owned-ingress-thread" };
  const request = (input: unknown[], authenticated = true) => new Request("http://localhost/v1/responses", {
    method: "POST", headers: authenticated ? headers : { "content-type": "application/json", "thread-id": headers["thread-id"] },
    body: JSON.stringify({ model: "fixture/owned-model", stream: true, input, tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }] }),
  });
  const context = responseTurnMembership(request([]), config, admission);
  expect(context).toBeDefined();
  if (!context) throw new Error("owned scope absent");
  const epoch = context.begin();
  const call = { type: "function_call", id: epoch.next("function_call"), call_id: "owned_call", name: "lookup", arguments: '{"q":"x"}' };
  const message = { type: "message", id: epoch.next("message"), role: "assistant", content: [{ type: "output_text", text: "Owned commentary" }] };
  const result = { type: "function_call_output", call_id: "owned_call", output: "REAL_TOOL_OUTPUT" };
  const captured: string[] = [];
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("http://127.0.0.1:1/v1/chat/completions");
    expect(typeof init?.body).toBe("string");
    captured.push(String(init?.body));
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    for (const [input, authenticated] of [[[call, message, result], true], [[message, call, result], true], [[call, message, result], false]] as const) {
      const response = await handleResponses(request([...input], authenticated), config, { model: "", provider: "" }, { admission });
      const text = await response.text();
      if (response.status !== 200) throw new Error(text);
      expect(text).toContain("response.completed");
    }
    expect(captured).toHaveLength(3);
    expect(captured[0]).toBe(captured[1]);
    expect(captured[2]).not.toBe(captured[1]);
    const messages = JSON.parse(captured[0]!).messages;
    expect(messages.find((item: { role: string; tool_call_id?: string }) => item.role === "tool" && item.tool_call_id === "owned_call")?.content).toBe("REAL_TOOL_OUTPUT");
    expect(captured[0]).not.toContain("no tool result was recorded");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
    if (previousSigning === undefined) delete process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY; else process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY = previousSigning;
    release();
  }
});


test("real streaming delivery mints one signed output identity per item and replays its real result", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  const previousSigning = process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY;
  const release = acquireOwnedSpendHome();
  process.env.OPENCODEX_API_AUTH_TOKEN = "owned-stream-client";
  process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY = "dr_turn_v1_" + Buffer.alloc(32, 29).toString("base64url");
  const config: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", allowPrivateNetwork: true, baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic-upstream", models: ["owned-model"], headers: { "x-opencodex-tool-completion": "block-stop-v1" } },
  } };
  const admission = { kind: "loopback", source: "loopback" } as const;
  const headers = { "content-type": "application/json", "x-opencodex-api-key": "owned-stream-client", "thread-id": "owned-stream-thread" };
  const user = { role: "user", content: "fixture" };
  const request = (input: unknown[]) => new Request("http://localhost/v1/responses", { method: "POST", headers,
    body: JSON.stringify({ model: "fixture/owned-model", stream: true, input, tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }] }),
  });
  const captured: string[] = [];
  const chunk = (delta: unknown, finish_reason?: string) => ({ choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] });
  const body = [chunk({ tool_calls: [{ index: 0, id: "call_stream", function: { name: "lookup", arguments: '{"q":"x"}' } }] }),
    chunk({ tool_calls: [{ index: 0, id: "call_stream", x_opencodex_completed: "block-stop-v1" }] }),
    chunk({ content: "Later commentary" }), chunk({}, "tool_calls")].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  globalThis.fetch = (async (_url, init) => { captured.push(String(init?.body)); return new Response(body, { headers: { "content-type": "text/event-stream", "x-opencodex-tool-completion": "block-stop-v1" } }); }) as typeof fetch;
  try {
    const response = await handleResponses(request([user]), config, { model: "", provider: "" }, { admission });
    expect(response.status).toBe(200);
    const wire = await response.text();
    const frames = wire.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
    const output = frames.find(frame => frame.type === "response.completed")?.response.output;
    expect(output?.map((item: {type: string}) => item.type)).toEqual(["function_call", "message"]);
    const [call, message] = output;
    expect(call.id).toMatch(/^fc_ocxt1_/);
    expect(message.id).toMatch(/^msg_ocxt1_/);
    for (const item of output) {
      expect(frames.find(frame => frame.type === "response.output_item.added" && frame.item.type === item.type)?.item.id).toBe(item.id);
      expect(frames.find(frame => frame.type === "response.output_item.done" && frame.item.type === item.type)?.item.id).toBe(item.id);
    }
    expect(frames.filter(frame => frame.item_id && frame.type.startsWith("response.function_call_arguments")).every(frame => frame.item_id === call.id)).toBe(true);
    const result = { type: "function_call_output", call_id: call.call_id, output: "REAL_STREAM_RESULT" };
    for (const input of [[user, call, message, result], [user, message, call, result]]) {
      const replay = await handleResponses(request(input), config, { model: "", provider: "" }, { admission });
      expect(replay.status).toBe(200);
      await replay.text();
    }
    expect(captured[1]).toBe(captured[2]);
    expect(captured[1]).toContain("REAL_STREAM_RESULT");
    expect(captured[1]).not.toContain("no tool result was recorded");
    for (const missing of ["signing-key", "credential", "own-thread", "parent-only"]) {
      process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY = "dr_turn_v1_" + Buffer.alloc(32, 29).toString("base64url");
      const refused = request([user]);
      if (missing === "signing-key") delete process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY;
      if (missing === "credential") refused.headers.delete("x-opencodex-api-key");
      if (missing === "own-thread" || missing === "parent-only") refused.headers.delete("thread-id");
      if (missing === "parent-only") refused.headers.set("x-codex-parent-thread-id", "owned-stream-thread");
      const fallback = await handleResponses(refused, config, { model: "", provider: "" }, { admission });
      const fallbackFrames = (await fallback.text()).split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
      const fallbackOutput = fallbackFrames.find(frame => frame.type === "response.completed")?.response.output;
      expect(fallbackOutput?.map((item: { type: string }) => item.type)).toEqual(["message", "function_call"]);
      expect(fallbackOutput.every((item: { id: string }) => !item.id.includes("_ocxt1_"))).toBe(true);
    }

  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
    if (previousSigning === undefined) delete process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY; else process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY = previousSigning;
    release();
  }
});
