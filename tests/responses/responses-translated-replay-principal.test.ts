/**
 * Translated ingresses (Chat Completions bridge, Claude Messages, routed Responses compaction)
 * rebuild an internal Request without the caller's OCX credential. The replay principal must be
 * resolved from the admitted client request first, or a bearer-only loopback caller silently
 * loses its own retained reasoning. Foreign and keyless callers stay isolated.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { resolveContextPrincipal, type DataPlaneAdmission } from "../../src/server/auth-cors";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Rec = Record<string, any>;
type Caller = "owner" | "foreign" | undefined;
type Credential = "bearer" | "dedicated";
/** Set per case: how the caller volunteers its OCX key on loopback. */
let credential: Credential = "bearer";
const MODEL = "deepseek-v4.1-flash";
const PRIVATE = "synthetic owner reasoning";
const CALL = "call_translated_principal";
const LOOPBACK: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home: string | undefined;
let releaseSpend: (() => void) | undefined;
let outbound: Rec[] = [];

function clearState() {
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests(); clearKeyCooldowns();
  clearReasoningReplayCacheForTests(); resetThoughtSignatureReplayForTests();
}

function chatAnswer(body: Rec): Response {
  const continuation = body.messages.some((message: Rec) => message.role === "tool");
  const message = continuation ? { role: "assistant", content: "continued" }
    : { role: "assistant", content: null, reasoning_content: PRIVATE, tool_calls: [
      { id: CALL, type: "function", function: { name: "inspect", arguments: "{}" } },
    ] };
  const finish = continuation ? "stop" : "tool_calls";
  const usage = { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 };
  if (body.stream !== true) {
    return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", model: MODEL,
      choices: [{ index: 0, message, finish_reason: finish }], usage });
  }
  const chunk = (delta: Rec, finishReason: string | null, extra: Rec = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`;
  const tool = message.tool_calls?.map((call, index) => ({ index, ...call }));
  return new Response([
    chunk({ role: "assistant", ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) }, null),
    chunk({ ...(message.content ? { content: message.content } : {}), ...(tool ? { tool_calls: tool } : {}) }, null),
    chunk({}, finish, { usage }),
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-translated-replay-principal-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  clearState(); clearResponseStateForTests();
  outbound = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.hostname).toBe("first.example.test");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${config.providers.first!.apiKey}`);
    const body = JSON.parse(String(init?.body)) as Rec;
    outbound.push(body);
    return chatAnswer(body);
  }) as typeof fetch;
});

afterEach(async () => {
  releaseSpend?.(); releaseSpend = undefined;
  closeRequestHistoryIndex(); await flushResponseState(); clearResponseStateForTests();
  globalThis.fetch = originalFetch;
  clearState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
});

const config: OcxConfig = {
  port: 0, hostname: "127.0.0.1", defaultProvider: "first",
  apiKeys: ["owner", "foreign"].map(id => ({ id, name: id, key: `synthetic-caller-${id}`, createdAt: "2026-01-01" })),
  providers: { first: { adapter: "openai-chat", baseUrl: "https://first.example.test/v1", authMode: "key",
    apiKey: "synthetic-provider-first", models: [MODEL] } },
  combos: { pair: { strategy: "failover", targets: [{ provider: "first", model: MODEL }] } },
};

function headersFor(caller: Caller, thread: string, extra: Record<string, string> = {}): Record<string, string> {
  // Non-owners also claim the owner's principal in a header; client data never selects it.
  const spoof = caller === "owner" ? {} : { "x-opencodex-client-principal-id": OWNER_PRINCIPAL };
  return { "content-type": "application/json", "thread-id": thread,
    ...(caller ? credential === "bearer" ? { authorization: `Bearer synthetic-caller-${caller}` }
      : { "x-opencodex-api-key": `synthetic-caller-${caller}` } : {}), ...spoof, ...extra };
}

const OWNER_PRINCIPAL = resolveContextPrincipal(new Request("http://localhost/", {
  headers: { authorization: `Bearer ${config.apiKeys!.find(entry => entry.id === "owner")!.key}` },
}), config, LOOPBACK)!;

/** The reasoning the provider received on the assistant tool-call message of the latest send. */
function replayedReasoning(): unknown {
  const last = outbound.at(-1)!;
  return last.messages.find((message: Rec) => message.role === "assistant" && message.tool_calls)?.reasoning_content;
}

const TOOL = { type: "function", function: { name: "inspect", parameters: { type: "object", properties: {} } } };

async function chat(caller: Caller, thread: string, seed: boolean) {
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: headersFor(caller, thread),
    body: JSON.stringify({ model: "combo/pair", stream: false, tools: [TOOL], messages: seed
      ? [{ role: "user", content: "inspect the fixture" }]
      : [
        { role: "user", content: "inspect the fixture" },
        { role: "assistant", content: null, tool_calls: [{ id: CALL, type: "function", function: { name: "inspect", arguments: "{}" } }] },
        { role: "tool", tool_call_id: CALL, content: "done" },
      ] }),
  }), config, { model: "", provider: "" }, { requestId: `chat-${crypto.randomUUID()}`, start: Date.now(), admission: LOOPBACK });
  expect(response.status).toBe(200);
  await response.text();
}

async function claude(caller: Caller, thread: string, seed: boolean) {
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: headersFor(caller, thread, { "anthropic-version": "2023-06-01" }),
    body: JSON.stringify({ model: "combo/pair", max_tokens: 256, stream: false,
      tools: [{ name: "inspect", input_schema: { type: "object", properties: {} } }],
      messages: seed
        ? [{ role: "user", content: "inspect the fixture" }]
        : [
          { role: "user", content: "inspect the fixture" },
          { role: "assistant", content: [{ type: "tool_use", id: CALL, name: "inspect", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: CALL, content: "done" }] },
        ] }),
  }), config, { model: "", provider: "" }, { requestId: `claude-${crypto.randomUUID()}`, start: Date.now(), admission: LOOPBACK });
  expect(response.status).toBe(200);
  await response.text();
}

const RESPONSES_TOOL = { type: "function", name: "inspect", parameters: { type: "object", properties: {} } };
const RESPONSES_HISTORY = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the fixture" }] },
  { type: "function_call", call_id: CALL, name: "inspect", arguments: "{}" },
  { type: "function_call_output", call_id: CALL, output: "done" },
];

async function compact(caller: Caller, thread: string, seed: boolean) {
  if (seed) {
    // The compaction handoff replays what a normal Responses turn retained for the same caller.
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: headersFor(caller, thread),
      body: JSON.stringify({ model: "combo/pair", stream: false, store: false, tools: [RESPONSES_TOOL], input: "inspect the fixture" }),
    }), config, { model: "", provider: "" }, { admission: LOOPBACK });
    expect(response.status).toBe(200);
    await response.text();
    return;
  }
  const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
    method: "POST", headers: headersFor(caller, thread),
    body: JSON.stringify({ model: "combo/pair", tools: [RESPONSES_TOOL], input: RESPONSES_HISTORY }),
  }), config, { model: "", provider: "" }, undefined, LOOPBACK);
  expect(response.status).toBe(200);
  await response.text();
}

const INGRESSES = [
  ["chat completions bridge combo", chat],
  ["claude messages", claude],
  ["responses compaction handoff", compact],
] as const;

test.each(INGRESSES.flatMap(([name, ingress]) => (["bearer", "dedicated"] as const).map(kind => [name, kind, ingress] as const)))(
  "%s keeps the %s-key loopback principal for retained reasoning", async (_name, kind, ingress) => {
  credential = kind;
  const thread = `translated-principal-${crypto.randomUUID()}`;
  expect(OWNER_PRINCIPAL).toBeString();
  await ingress("owner", thread, true);
  expect(outbound).toHaveLength(1);
  await ingress("owner", thread, false);
  expect(replayedReasoning()).toBe(PRIVATE);
  await ingress("foreign", thread, false);
  expect(replayedReasoning()).not.toBe(PRIVATE);
  await ingress(undefined, thread, false);
  expect(replayedReasoning()).not.toBe(PRIVATE);
}, 20_000);

