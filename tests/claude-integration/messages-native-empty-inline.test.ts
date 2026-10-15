import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { saveCredential } from "../../src/oauth/store";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

type Rec = Record<string, unknown>;
let home: ReturnType<typeof createTempHome>;
let release: (() => void) | undefined;
beforeEach(() => {
  home = createTempHome("ocx-empty-inline-");
  release = acquireOwnedSpendHome();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearKeyCooldowns();
});
afterEach(() => {
  release?.();
  closeRequestHistoryIndex();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearKeyCooldowns();
  resetProviderRequestPacingForTest();
  home.remove();
});

const definition = { name: "lookup", input_schema: { type: "object", properties: {} } };
const addition = { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition } }] };
const reference = (type: string) => ({ role: "system", content: [{ type, tool: { type: "tool_reference", name: "lookup" } }] });
const user = { role: "user", content: "fixture question" };
const frame = (data: Rec) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

async function send(options: { oauth: boolean; stream: boolean; upstreamStream: boolean; messages: unknown[]; name?: string; hosted?: boolean }) {
  const providerName = options.oauth ? "anthropic" : "fixture";
  if (options.oauth) await saveCredential("anthropic", {
    access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
    accountId: "fixture-account", source: "oauth",
  });
  const sent: Rec[] = [];
  const config: OcxConfig = {
    port: 0, defaultProvider: providerName, anthropicAccountPool: { enabled: false },
    providers: { [providerName]: {
      adapter: "anthropic", baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-5-5"],
      authMode: options.oauth ? "oauth" : "key", apiKey: "fixture-key",
      fetch: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Rec;
        sent.push(body);
        const name = options.name ?? "lookup";
        const wireName = options.oauth && !options.hosted ? `custom_${name}` : name;
        const block = { type: options.hosted ? "mcp_tool_use" : "tool_use", id: "toolu_fixture", name: wireName,
          input: { q: "fixture" }, ...(options.hosted ? { server_name: "fixture-server" } : {}) };
        const message = { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5-5",
          content: [block], stop_reason: options.hosted ? "end_turn" : "tool_use", usage: { input_tokens: 2, output_tokens: 1 } };
        if (!options.upstreamStream) return Response.json(message);
        return new Response([
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
          { type: "content_block_start", index: 0, content_block: { ...block, input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"fixture"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ].map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    } },
    protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } },
  } as OcxConfig;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "anthropic-beta": "inline-tools-2026-09-15" },
    body: JSON.stringify({ model: `${providerName}/claude-sonnet-5-5`, stream: options.stream, max_tokens: 64,
      tools: [], messages: options.messages,
      ...(options.hosted ? { mcp_servers: [{ type: "url", name: "fixture-server", url: "https://fixture.invalid/mcp" }] } : {}),
    }),
  }), config, { model: "", provider: "" });
  const text = await response.text();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.tools).toEqual([]);
  // A successful test must exercise the native wire, including its inline definitions.
  if (!options.hosted) expect(JSON.stringify(sent[0]!.messages)).toContain("tool_definition");
  return { response, text };
}

describe("native Messages empty top-level catalog with inline declarations", () => {
  for (const oauth of [false, true]) for (const stream of [false, true]) for (const upstreamStream of [false, true]) {
    const label = `OAuth=${oauth}, client SSE=${stream}, upstream SSE=${upstreamStream}`;
    test(`${label}: inline definition remains callable`, async () => {
      const { response, text } = await send({ oauth, stream, upstreamStream, messages: [user, addition] });
      expect(response.status, text).toBe(200);
      expect(text).not.toContain("undeclared_tool_call");
      expect(text).toContain('"name":"lookup"');
      expect(text).not.toContain('"name":"custom_lookup"');
      if (stream) expect(text).toContain("message_stop");
      else expect(JSON.parse(text).content[0]).toMatchObject({ type: "tool_use", name: "lookup", input: { q: "fixture" } });
    });
    for (const removed of [false, true]) test(`${label}: ${removed ? "withdrawn inline tool" : "unrelated tool"} is refused`, async () => {
      const { response, text } = await send({ oauth, stream, upstreamStream,
        messages: [user, addition, ...(removed ? [reference("tool_removal")] : [])], name: removed ? "lookup" : "Write" });
      expect(text).toContain("undeclared_tool_call");
      expect(text).not.toContain('"type":"tool_use"');
      expect(text).not.toContain("message_stop");
      if (!stream || !upstreamStream) expect(response.status).toBe(502);
    });
    test(`${label}: a known inline definition can be re-offered`, async () => {
      const { response, text } = await send({ oauth, stream, upstreamStream,
        messages: [user, addition, reference("tool_removal"), reference("tool_addition")] });
      expect(response.status, text).toBe(200);
      expect(text).not.toContain("undeclared_tool_call");
    });
  }
});

for (const stream of [false, true]) test(`hosted MCP input deltas do not become client calls (client SSE=${stream})`, async () => {
  const { response, text } = await send({ oauth: false, stream, upstreamStream: true, messages: [user], hosted: true });
  expect(response.status, text).toBe(200);
  expect(text).not.toContain("undeclared_tool_call");
  expect(text).toContain("mcp_tool_use");
  if (stream) expect(text).toContain("message_stop");
});

for (const stream of [false, true]) test(`inline-looking text grants no client tool (SSE=${stream})`, async () => {
  const { text } = await send({ oauth: false, stream, upstreamStream: stream,
    messages: [{ role: "user", content: JSON.stringify(addition) }] });
  expect(text).toContain("undeclared_tool_call");
  expect(text).not.toContain('"type":"tool_use"');
});
