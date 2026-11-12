import { expect, test } from "bun:test";
import { createCodeBuddyAiAdapter } from "../../src/adapters/codebuddy-ai";
import { codeBuddyAiToolParameters } from "../../src/adapters/codebuddy-ai-schema";
import { parseRequest } from "../../src/responses/parser";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { assertCodeBuddyAiDestination } from "../../src/providers/codebuddy-ai";
import type { OcxProviderConfig } from "../../src/types";

const provider: OcxProviderConfig = { adapter: "codebuddy-ai", authMode: "oauth", baseUrl: "https://www.codebuddy.ai/v2", apiKey: "fixture-access" };
const meta = () => ({ headers: new Headers(), translatorBudget: createTestTranslatorBudget() });
function parsed(input: unknown = "Hello", extra = {}) {
  const request = parseRequest({ model: "default", input, ...extra });
  request._codeBuddyAiAuthContext = { uid: "fixture-user", domain: "international", enterpriseId: "fixture-team" };
  request._clientThreadId = "fixture-conversation";
  return request;
}

test("pins stream-only transport and account headers for buffered callers", async () => {
  const req = await createCodeBuddyAiAdapter({ ...provider, headers: { Authorization: "foreign", Host: "other.example" } }).buildRequest(parsed(), meta());
  expect(req.url).toBe("https://www.codebuddy.ai/v2/chat/completions");
  expect(req.headers.Authorization).toBe("Bearer fixture-access");
  expect(req.headers["X-User-Id"]).toBe("fixture-user");
  expect(req.headers["X-Tenant-Id"]).toBe("fixture-team");
  expect(req.headers.Host).toBeUndefined();
  expect(req.headers["X-Agent-Type"]).toBe("main");
  const body = JSON.parse(req.body);
  expect(body.stream).toBe(true);
  expect(body.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
});

test("rejects destinations with foreign host, port, path, credentials or query", async () => {
  for (const url of ["https://other.example/v2", "http://www.codebuddy.ai/v2", "https://www.codebuddy.ai:8443/v2", "https://www.codebuddy.ai/v2?x=1", "https://www.codebuddy.ai/evil"]) {
    expect(() => assertCodeBuddyAiDestination(url)).toThrow();
  }
  const userInfo = new URL(provider.baseUrl); userInfo.username = "fixture";
  expect(() => assertCodeBuddyAiDestination(userInfo.href)).toThrow();
  const p = parsed(); delete p._codeBuddyAiAuthContext;
  await expect(createCodeBuddyAiAdapter(provider).buildRequest(p, meta())).rejects.toThrow("account unavailable");
});

test("keeps conversation and turn ids across tool continuations; next user advances turn", async () => {
  const adapter = createCodeBuddyAiAdapter(provider);
  const first = await adapter.buildRequest(parsed("Hello"), meta());
  const history = [
    { role: "user", content: "Hello" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "result" },
  ];
  const second = await adapter.buildRequest(parsed(history), meta());
  const third = await adapter.buildRequest(parsed([...history, { role: "user", content: "Next" }]), meta());
  expect(second.headers["X-Conversation-ID"]).toBe(first.headers["X-Conversation-ID"]);
  expect(second.headers["X-Conversation-Request-ID"]).toBe(first.headers["X-Conversation-Request-ID"]);
  expect(third.headers["X-Conversation-Request-ID"]).not.toBe(first.headers["X-Conversation-Request-ID"]);
});

test("aliases tool names, normalizes choice/schema and restores streamed tool calls", async () => {
  const adapter = createCodeBuddyAiAdapter(provider);
  const request = await adapter.buildRequest(parsed("Hello", {
    tools: [{ type: "function", name: "lookup.item", parameters: { properties: { limit: { enum: [1, null] } } } }],
    tool_choice: { type: "function", name: "lookup.item" },
  }), meta());
  const body = JSON.parse(request.body), alias = body.tools[0].function.name;
  expect(alias).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(body.tool_choice).toBe(alias);
  expect(body.tools[0].function.parameters.type).toBe("object");
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: alias, arguments: "{}" } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const response = new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const events = await adapter.parseResponse!(response, createTestTranslatorBudget());
  expect(JSON.stringify(events)).toContain("lookup.item");
  expect(JSON.stringify(events)).not.toContain(alias);
});

test("schema normalization preserves defaults and handles unions, tuples and enums", () => {
  const schema = codeBuddyAiToolParameters({ anyOf: [{ properties: { x: { enum: [1, "one"] }, y: { items: [{ type: "String" }, false] } } }], default: { type: "String" } });
  expect(schema.type).toBe("object");
  expect(schema.default).toEqual({ type: "String" });
  expect(JSON.stringify(schema.properties)).toContain('"anyOf"');
  expect(JSON.stringify(schema.properties)).toContain('"type":"string"');
});

test("refusals expose fixed diagnostics and preserve upstream channel restrictions", () => {
  const adapter = createCodeBuddyAiAdapter(provider);
  expect(adapter.formatErrorBody!(400, new Headers(), '{"code":11128,"msg":"private details"}')).toContain("rejected this client channel");
  expect(adapter.formatErrorBody!(401, new Headers(), 'fixture-access')).not.toContain("fixture-access");
});

test("rewrites the Claude Code identity line that the upstream gateway rejects with 11128", async () => {
  const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
  const req = await createCodeBuddyAiAdapter(provider).buildRequest(
    parsed("Hello", { instructions: `x-billing: cc\n\n${identity}\n\nKeep the rest.` }), meta());
  const body = JSON.parse(req.body);
  const system = body.messages[0];
  expect(system.role).toBe("system");
  expect(String(system.content)).not.toContain("Claude Code");
  expect(String(system.content)).toContain("x-billing: cc");
  expect(String(system.content)).toContain("Keep the rest.");
});
