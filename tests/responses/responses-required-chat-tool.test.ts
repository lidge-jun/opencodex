import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let home: TempHome;
let release: () => void;
beforeEach(() => { home = createTempHome(); release = acquireOwnedSpendHome(); });
afterEach(() => { release(); home.remove(); });

const tools = Array.from({ length: 151 }, (_, i) => ({ type: "function", name: `marker_${i}`, description: "Synthetic marker", parameters: { type: "object", properties: {} } }));
for (const stream of [false, true]) for (const combo of [false, true]) for (const tool of [false, true]) {
  test(`mandatory Chat result through Responses (stream=${stream}, combo=${combo}, tool=${tool})`, async () => {
    const sent: { tool_choice: unknown; tools: unknown[]; stream?: boolean }[] = [];
    let fallbackSends = 0;
    const provider = (name: string): OcxProviderConfig => ({
      adapter: "openai-chat", baseUrl: `https://${name}.invalid/v1`, apiKey: "fixture-key", authMode: "key", models: ["fixture"],
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (name === "fallback") { fallbackSends++; throw new Error("committed output must not be replayed"); }
        const body = JSON.parse(String(init?.body)); sent.push(body);
        const call = { id: "call_fixture", type: "function", function: { name: "marker_150", arguments: "{}" } };
        const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 };
        if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "visible text", ...(tool ? { tool_calls: [call] } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }], usage });
        const chunks = [
          { choices: [{ delta: { content: "visible text" }, finish_reason: null }] },
          ...(tool ? [{ choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: null }] }] : []),
          { choices: [{ delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage },
        ];
        return new Response(chunks.map(x => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    });
    const cfg = { defaultProvider: "primary", providers: { primary: provider("primary"), fallback: provider("fallback") },
      combos: { required: { alias: "chain/required", strategy: "failover", targets: [{ provider: "primary", model: "fixture" }, { provider: "fallback", model: "fixture" }] } },
    } as OcxConfig;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: combo ? "chain/required" : "primary/fixture", input: "Use a marker", store: false, stream, tools, tool_choice: "required" }),
    }), cfg, { model: "", provider: "" });
    const text = await response.text();
    expect(sent).toHaveLength(1);
    expect(fallbackSends).toBe(0);
    expect(sent[0]!.tool_choice).toBe("required");
    expect(sent[0]!.tools).toHaveLength(151);
    if (tool) {
      expect(response.status).toBe(200);
      expect(text).toContain("marker_150");
      expect(text).toContain(stream ? "response.completed" : '"status":"completed"');
    } else {
      expect(text).toContain("required_tool_not_called");
      expect(text).not.toContain("response.completed");
      const terminal = stream
        ? JSON.parse(text.split("\n").filter(line => line.startsWith("data: {")).map(line => line.slice(6)).find(line => JSON.parse(line).type === "response.failed")!).response
        : JSON.parse(text);
      expect(terminal.status).toBe("failed");
      expect(terminal.usage).toMatchObject({ input_tokens: 7, output_tokens: 2 });
      expect(terminal.retryable).toBe(false);
      if (stream) expect(text).toContain("visible text");
      else expect(response.status).toBe(200); // Admitted Responses envelopes carry terminal failure in their status.
    }
  });
}

test("a 151-tool call/result continuation retains the catalog and result", async () => {
  const bodies: { messages: { role: string; content: unknown; tool_call_id?: string }[]; tools: unknown[]; tool_choice?: unknown }[] = [];
  const cfg = { defaultProvider: "primary", providers: { primary: {
    adapter: "openai-chat", baseUrl: "https://primary.invalid/v1", authMode: "key", apiKey: "fixture-key",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: bodies.length === 1
        ? { role: "assistant", tool_calls: [{ id: "call_cycle", type: "function", function: { name: "marker_150", arguments: "{}" } }] }
        : { role: "assistant", content: "result received" }, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] });
    }) as typeof fetch,
  } } } as OcxConfig;
  const send = (input: unknown, choice: string) => handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "primary/fixture", stream: false, store: false, input, tools, tool_choice: choice }),
  }), cfg, { model: "", provider: "" });
  const first = await (await send("Use a marker", "required")).json();
  expect(first.status).toBe("completed");
  const call = first.output.find((item: { type: string }) => item.type === "function_call");
  expect(call.name).toBe("marker_150");
  const second = await (await send([{ role: "user", content: "Use a marker" }, call, { type: "function_call_output", call_id: call.call_id, output: "synthetic marker result" }], "auto")).json();
  expect(second.status).toBe("completed");
  expect(JSON.stringify(second.output)).toContain("result received");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.tools).toHaveLength(151);
  expect(bodies[1]!.messages).toContainEqual({ role: "tool", tool_call_id: call.call_id, content: "synthetic marker result" });
});

for (const call of ["remote.lookup", "lookup"]) test(`existing namespace echo restoration still satisfies required: ${call}`, async () => {
  const cfg = { defaultProvider: "primary", providers: { primary: {
    adapter: "openai-chat", baseUrl: "https://primary.invalid/v1", authMode: "key", apiKey: "fixture-key",
    fetch: (async () => Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_alias", type: "function", function: { name: call, arguments: "{}" } }] }, finish_reason: "tool_calls" }] })) as typeof fetch,
  } } } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "primary/fixture", stream: false, store: false, input: "Use lookup", tool_choice: "required",
      tools: [{ type: "namespace", name: "remote", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] }] }),
  }), cfg, { model: "", provider: "" });
  const body = await response.json();
  expect(body.status).toBe("completed");
  expect(body.output.find((item: { type: string }) => item.type === "function_call")).toMatchObject({ name: "lookup", namespace: "remote" });
});

for (const stream of [false, true]) for (const combo of [false, true]) test(`existing bridge rejects a wrong named call (stream=${stream}, combo=${combo})`, async () => {
  let sends = 0;
  const primary: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://primary.invalid/v1", authMode: "key", apiKey: "fixture-key",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sends++;
      const call = { id: "call_wrong", type: "function", function: { name: "marker_1", arguments: "{}" } };
      if (JSON.parse(String(init?.body)).stream) return new Response([
        { choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [call] }, finish_reason: "tool_calls" }] });
    }) as typeof fetch };
  const cfg = { defaultProvider: "primary", providers: { primary }, combos: { required: { alias: "chain/required", strategy: "failover", targets: [{ provider: "primary", model: "fixture" }] } } } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: combo ? "chain/required" : "primary/fixture", stream, store: false, input: "Use marker_0", tools, tool_choice: { type: "function", name: "marker_0" } }),
  }), cfg, { model: "", provider: "" });
  const body = await response.text();
  expect(body).toContain("upstream_server_error");
  expect(body).not.toContain("response.output_item.done");
  expect(body).not.toContain("response.completed");
  expect(sends).toBe(1);
});

test("a zero-output streamed combo child that skips a required call stops the combo", async () => {
  let fallbackSends = 0;
  const provider = (name: string): OcxProviderConfig => ({
    adapter: "openai-chat", baseUrl: `https://${name}.invalid/v1`, apiKey: "fixture-key", authMode: "key", models: ["fixture"],
    fetch: (async () => {
      if (name === "silent-fallback") { fallbackSends++; return Response.json({ choices: [{ message: { role: "assistant", content: "replayed" }, finish_reason: "stop" }] }); }
      const chunks = [{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 } }];
      return new Response(chunks.map(x => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  // Distinct provider names keep earlier combo failures in this file from cooling down the primary.
  const cfg = { defaultProvider: "silent-primary", providers: { "silent-primary": provider("silent-primary"), "silent-fallback": provider("silent-fallback") },
    combos: { silent: { alias: "chain/silent-required", strategy: "failover", targets: [{ provider: "silent-primary", model: "fixture" }, { provider: "silent-fallback", model: "fixture" }] } },
  } as OcxConfig;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chain/silent-required", input: "Use a marker", store: false, stream: true, tools, tool_choice: "required" }),
  }), cfg, { model: "", provider: "" });
  const text = await response.text();
  expect(fallbackSends).toBe(0);
  expect(text).toContain("required_tool_not_called");
  expect(text).not.toContain("replayed");
  expect(text).not.toContain("response.completed");
});
