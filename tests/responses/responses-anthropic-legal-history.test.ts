import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const SIGNATURE = "SyntheticPrefixSignature123456==";
const SECOND_SIGNATURE = "SyntheticNextPrefixSignature123456==";
const MODEL = "claude-opus-5-5";
const TOOLS = [{ type: "function", name: "lookup", description: "Fixture lookup", parameters: { type: "object", properties: {} } }];
type Item = Record<string, unknown>;
let home = "";
let release: (() => void) | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-prefix-roundtrip-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  resetWorkflowBudgetsForTest();
});
afterEach(() => {
  try { release?.(); } finally {
    release = undefined;
    globalThis.fetch = originalFetch;
    clearReasoningReplayCacheForTests();
    resetThoughtSignatureReplayForTests();
    resetWorkflowBudgetsForTest();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

function config(): OcxConfig {
  return { defaultProvider: "anthropic-test", emptyCompletionRetry: false, providers: { "anthropic-test": {
    adapter: "anthropic", baseUrl: "https://anthropic.example.test", authMode: "key",
    apiKey: "synthetic-test-key", proxy: "direct", models: [MODEL, "claude-sonnet-4-5"],
  } } } as OcxConfig;
}
const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
function request(input: Item[], stream: boolean, overrides: Item = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "x-codex-parent-thread-id": "prefix-fixture-thread" },
    body: JSON.stringify({ model: `anthropic-test/${MODEL}`, stream, store: false,
      instructions: "Preserve the fixture context.", reasoning: { effort: "high", summary: "detailed" },
      tools: TOOLS, input, ...overrides }),
  });
}
function frame(type: string, data: Item = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}
function signedFrames(signature = SIGNATURE, thinking = "Complete fixture reasoning"): string[] {
  return [
    frame("message_start", { message: { id: "msg_fixture", role: "assistant", content: [], usage: { input_tokens: 2 } } }),
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } }),
    frame("content_block_stop", { index: 0 }),
  ];
}
function upstream(signature = SIGNATURE, tool = false, stream = true): Response {
  if (!stream) return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: MODEL,
    content: [{ type: "thinking", thinking: "Complete fixture reasoning", signature },
      tool ? { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } : { type: "text", text: "Fixture answer" }],
    stop_reason: tool ? "tool_use" : "end_turn", usage: { input_tokens: 2, output_tokens: 3 } });
  const frames = signedFrames(signature);
  if (tool) frames.push(
    frame("content_block_start", { index: 1, content_block: { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } }),
    frame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }),
    frame("content_block_stop", { index: 1 }),
  );
  else frames.push(
    frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Fixture answer" } }),
    frame("content_block_stop", { index: 1 }),
  );
  frames.push(frame("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }), frame("message_stop"));
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
function transport(answer: (index: number, stream: boolean) => Response | Promise<Response>) {
  const bodies: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!["https://anthropic.example.test/v1/messages", "https://other-anthropic.example.test/v1/messages"].includes(url)) {
      throw new Error(`Unexpected network target blocked: ${url}`);
    }
    bodies.push(String(init?.body));
    return answer(bodies.length, JSON.parse(String(init?.body)).stream === true);
  }) as typeof fetch;
  return bodies;
}
async function send(input: Item[], stream = false, overrides: Item = {}, cfg = config(), options: Parameters<typeof handleResponses>[3] = {}) {
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request(input, stream, overrides), cfg, log, options);
  const text = await response.text();
  const events = stream ? text.split("\n").filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6)) as Item) : [];
  const json = stream ? undefined : JSON.parse(text);
  const output = (stream ? events.filter(event => event.type === "response.output_item.done").map(event => event.item)
    : json?.output ?? []) as Item[];
  return { response, text, output, log, json, events };
}
test("removing only the oldest thinking preserves the remaining valid run", async () => {
  const bodies = transport((index, stream) => upstream(index === 1 ? SIGNATURE : SECOND_SIGNATURE, false, stream));
  const first = await send([user("First question")]);
  const history = [user("First question"), ...first.output, user("Second question")];
  const second = await send(history);
  expect(second.response.status).toBe(200);
  const trimmed = [user("First question"), ...first.output.filter(item => item.type !== "reasoning"),
    user("Second question"), ...second.output, user("Third question")];
  const third = await send(trimmed);
  expect(third.response.status).toBe(200);
  expect(bodies).toHaveLength(3);
  expect(bodies[2]).toContain(SECOND_SIGNATURE);
});

test("rotating image URL with identical bytes is left to upstream validation", async () => {
  const bodies = transport((_index, stream) => upstream(SIGNATURE, true, stream));
  const imageUser = (url: string): Item => ({type: "message", role: "user", content: [
    {type: "input_text", text: "Look at this fixed image"}, {type: "input_image", image_url: url}
  ]});
  const first = await send([imageUser("https://images.example.test/fixed.png?signature=old")], false,
    {model: "anthropic-test/claude-sonnet-4-5"});
  const next = await send([imageUser("https://images.example.test/fixed.png?signature=new"), ...first.output,
    {type: "function_call_output", call_id: "tool_fixture", output: "Already executed"}], false,
    {model: "anthropic-test/claude-sonnet-4-5"});
  expect(next.response.status).toBe(200);
  expect(bodies).toHaveLength(2);
});

test("pre-binding model accepts a changed system on a manual tool continuation", async () => {
  const bodies = transport((_index, stream) => upstream(SIGNATURE, true, stream));
  const first = await send([user("Run lookup")], false, {model: "anthropic-test/claude-sonnet-4-5"});
  const next = await send([user("Run lookup"), ...first.output,
    {type: "function_call_output", call_id: "tool_fixture", output: "Already executed"}], false,
    {model: "anthropic-test/claude-sonnet-4-5", instructions: "New system prompt for this next turn."});
  expect(next.response.status).toBe(200);
  expect(bodies).toHaveLength(2);
});
