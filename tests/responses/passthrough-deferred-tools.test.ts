import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #6648: membership refusal follows the caller's wire even when a routed provider uses
// Responses passthrough. Chat/Anthropic runners may defer tools; Responses fails closed.
let testDir = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-passthrough-deferred-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-passthrough-deferred-"));
  process.env.OPENCODEX_HOME = testDir;
});
afterEach(() => {
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome?.restore();
  codexHome = undefined;
  removeTreeWithRetry(testDir);
});

const endpoints = {
  anthropic: "/v1/messages",
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
} as const;
type InboundWire = keyof typeof endpoints;
const argumentsJson = '{"path":"todo.md"}';

function requestBody(wire: InboundWire, stream: boolean): Record<string, unknown> {
  const parameters = { type: "object", properties: { path: { type: "string" } } };
  const common = { model: "mock/test-model", stream };
  if (wire === "anthropic") return {
    ...common, max_tokens: 128,
    messages: [{ role: "user", content: "write to todo" }],
    tools: [{ name: "Read", description: "Read a file", input_schema: parameters }],
  };
  if (wire === "chat") return {
    ...common, messages: [{ role: "user", content: "write to todo" }],
    tools: [{ type: "function", function: { name: "Read", description: "Read a file", parameters } }],
  };
  return {
    ...common, input: "write to todo",
    tools: [{ type: "function", name: "Read", description: "Read a file", parameters }],
  };
}

function mockResponsesUpstream(toolName: string, upstreamSse: boolean) {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const call = {
    id: "fc_deferred", type: "function_call", call_id: "call_deferred",
    name: toolName, arguments: argumentsJson, status: "completed",
  };
  const response = {
    id: "resp_deferred", object: "response", model: "test-model", status: "completed",
    output: [call], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const frame = (type: string, payload: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ path: new URL(req.url).pathname, body: await req.json() as Record<string, unknown> });
      if (!upstreamSse) return Response.json(response);
      return new Response([
        frame("response.created", { response: { ...response, status: "in_progress", output: [] } }),
        frame("response.output_item.added", { output_index: 0, item: { ...call, arguments: "", status: "in_progress" } }),
        frame("response.function_call_arguments.delta", { item_id: call.id, output_index: 0, delta: argumentsJson }),
        frame("response.function_call_arguments.done", { item_id: call.id, output_index: 0, arguments: argumentsJson }),
        frame("response.output_item.done", { output_index: 0, item: call }),
        frame("response.completed", { response }),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, seen };
}

describe("Responses passthrough deferred tool delivery by inbound wire", () => {
  for (const wire of Object.keys(endpoints) as InboundWire[]) {
    for (const stream of [true, false]) {
      for (const upstreamSse of [true, false]) {
        // Native Responses passthrough preserves the upstream representation; the other
        // endpoints translate SSE/JSON to the caller's requested representation.
        if (wire === "responses" && upstreamSse !== stream) continue;
        for (const toolName of ["Write", "Read", "default.Read"]) {
          test(`${wire} ${stream ? "stream" : "buffered"} from ${upstreamSse ? "SSE" : "JSON"}: ${toolName}`, async () => {
            const upstream = mockResponsesUpstream(toolName, upstreamSse);
            saveConfig({
              port: 0, defaultProvider: "mock",
              providers: { mock: {
                adapter: "openai-responses", apiKey: "mock-key", authMode: "key",
                baseUrl: `${upstream.server.url.toString().replace(/\/$/, "")}/v1`, allowPrivateNetwork: true,
              } },
            } as OcxConfig);
            const server = startServer(0);
            try {
              const result = await fetch(new URL(endpoints[wire], server.url), {
                method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
                body: JSON.stringify(requestBody(wire, stream)),
              });
              const text = await result.text();
              // Prove the request reached the routed Responses upstream with the partial catalog.
              expect(upstream.seen).toHaveLength(1);
              expect(upstream.seen[0]!.path).toBe("/v1/responses");
              expect(upstream.seen[0]!.body.tools).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: "function", name: "Read" }),
              ]));
              if (wire === "responses" && toolName === "Write") {
                expect(text).toContain("undeclared client tool");
                expect(text).toContain("Write");
                if (stream && upstreamSse) {
                  expect(result.status).toBe(200);
                  expect(text).toContain("response.failed");
                  expect(text).not.toContain("response.completed");
                } else expect(result.status).toBe(502);
                return;
              }
              expect(result.status).toBe(200);
              expect(text).not.toContain("undeclared client tool");
              expect(text).not.toContain('"error"');
              expect(text).not.toContain("default.Read");
              const expectedName = toolName === "Write" ? "Write" : "Read";
              if (stream) {
                expect(result.headers.get("content-type")).toContain("text/event-stream");
                expect(text).toContain(`"name":"${expectedName}"`);
                expect(text).toContain("call_deferred");
                expect(text).toContain(wire === "anthropic" ? "message_stop" : wire === "chat" ? "data: [DONE]" : "response.completed");
              } else {
                const json = JSON.parse(text);
                const tool = wire === "anthropic" ? json.content[0]
                  : wire === "chat" ? json.choices[0].message.tool_calls[0] : json.output[0];
                expect(wire === "chat" ? tool.function.name : tool.name).toBe(expectedName);
                expect(wire === "responses" ? tool.call_id : tool.id).toBe("call_deferred");
                expect(wire === "anthropic" ? tool.input : JSON.parse(wire === "chat" ? tool.function.arguments : tool.arguments)).toEqual({ path: "todo.md" });
              }
            } finally {
              await server.stop(true);
              upstream.server.stop(true);
            }
          });
        }
      }
    }
  }
});

// An explicit empty catalog is still a caller declaration — deny-all — even on wires whose
// absent or partial catalogs may be completed later by the client's own tool registry.
// The refusal must stay a deterministic catalog violation, never a retryable overload.
describe("explicit empty tool catalog is deny-all on deferred wires", () => {
  for (const wire of ["chat", "anthropic"] as const) {
    for (const stream of [true, false]) {
      test(`${wire} ${stream ? "stream" : "buffered"}: tools:[] refuses an upstream Write`, async () => {
        const upstream = mockResponsesUpstream("Write", stream);
        saveConfig({
          port: 0, defaultProvider: "mock",
          providers: { mock: {
            adapter: "openai-responses", apiKey: "mock-key", authMode: "key",
            baseUrl: `${upstream.server.url.toString().replace(/\/$/, "")}/v1`, allowPrivateNetwork: true,
          } },
        } as OcxConfig);
        const server = startServer(0);
        try {
          const body = wire === "anthropic"
            ? { model: "mock/test-model", stream, max_tokens: 128,
                messages: [{ role: "user", content: "write to todo" }], tools: [] }
            : { model: "mock/test-model", stream,
                messages: [{ role: "user", content: "write to todo" }], tools: [] };
          const result = await fetch(new URL(endpoints[wire], server.url), {
            method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
            body: JSON.stringify(body),
          });
          const text = await result.text();
          expect(upstream.seen).toHaveLength(1);
          expect(text).toContain("undeclared client tool");
          expect(text).toContain("Write");
          if (wire === "anthropic") {
            // Deterministic refusal: api_error identity, never a retryable overload.
            expect(text).not.toContain("overloaded_error");
            expect(text).toContain("undeclared_tool_call");
            if (stream) {
              expect(result.status).toBe(200);
              expect(text).toContain("api_error");
            } else {
              expect(result.status).toBe(502);
              expect(JSON.parse(text).error.type).toBe("api_error");
            }
          } else {
            expect(text).toContain("undeclared_tool_call");
            if (stream) expect(result.status).toBe(200);
            else expect(result.status).toBe(502);
          }
        } finally {
          await server.stop(true);
          upstream.server.stop(true);
        }
      });
    }
  }
});

// Tool-search style discovery lands the provider's expanded catalog back in the request as
// `additional_tools`/`tool_search_output` input items. Those are THIS turn's declarations, so
// a call they name is registered, not invented — the refusal is only for a catalog that never
// authorized the name.
describe("registered deferred catalog input items authorize calls", () => {
  for (const itemType of ["additional_tools", "tool_search_output"] as const) {
    for (const stream of [true, false]) {
      test(`responses ${stream ? "stream" : "buffered"}: Write declared via ${itemType}`, async () => {
        const upstream = mockResponsesUpstream("Write", stream);
        saveConfig({
          port: 0, defaultProvider: "mock",
          providers: { mock: {
            adapter: "openai-responses", apiKey: "mock-key", authMode: "key",
            baseUrl: `${upstream.server.url.toString().replace(/\/$/, "")}/v1`, allowPrivateNetwork: true,
          } },
        } as OcxConfig);
        const server = startServer(0);
        try {
          const result = await fetch(new URL(endpoints.responses, server.url), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "mock/test-model", stream,
              input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "write to todo" }] },
                { type: itemType, tools: [{ type: "function", name: "Write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } }] },
              ],
              tools: [{ type: "function", name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
            }),
          });
          const text = await result.text();
          expect(upstream.seen).toHaveLength(1);
          expect(result.status).toBe(200);
          expect(text).not.toContain("undeclared client tool");
          expect(text).not.toContain('"error"');
          if (stream) expect(text).toContain("response.completed");
          else expect(JSON.parse(text).output[0].name).toBe("Write");
        } finally {
          await server.stop(true);
          upstream.server.stop(true);
        }
      });
    }
  }
});
