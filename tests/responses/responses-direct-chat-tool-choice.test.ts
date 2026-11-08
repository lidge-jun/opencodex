import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

const clientTool = { type: "function", name: "shell", parameters: { type: "object", properties: {} } };
const mcpTool = { type: "mcp", server_label: "remote", server_url: "https://mcp.fixture.invalid/mcp" };
const mcpChoice = { type: "allowed_tools", mode: "required", tools: [{ type: "mcp", server_label: "remote", name: "shell" }] };
const originalFetch = globalThis.fetch;
let home: ReturnType<typeof createTempHome>;
let releaseHome: () => void;

beforeEach(() => {
  home = createTempHome("ocx-direct-chat-choice-");
  releaseHome = acquireOwnedSpendHome();
  clearResponseStateForTests();
  globalThis.fetch = (() => { throw new Error("unexpected network access in tool-choice fixture"); }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await flushResponseState();
  clearResponseStateForTests();
  closeRequestHistoryIndex();
  releaseHome();
  home.remove();
});

function fixture(nativeOutput: Record<string, unknown>[] = [{ id: "computer_fixture", type: "computer_call", status: "completed" }]) {
  const sent: Array<{ provider: string; body: Record<string, unknown> }> = [];
  const send = (provider: string) => (async (_input, init) => {
    sent.push({ provider, body: JSON.parse(String(init?.body)) });
    return Response.json(provider === "chat" ? {
      id: "chat_fixture", object: "chat.completion", model: "model",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "call_fixture", type: "function", function: { name: "shell", arguments: "{}" } }],
      } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    } : {
      id: "resp_fixture", object: "response", status: "completed", model: "model",
      output: nativeOutput,
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  }) as typeof fetch;
  const config: OcxConfig = {
    port: 0, defaultProvider: "chat", multiAgentGuidanceEnabled: false,
    providers: {
      chat: { adapter: "openai-chat", baseUrl: "https://api.openai.com/v1", authMode: "key",
        apiKey: "fixture-key", models: ["model"], liveModels: false, fetch: send("chat") },
      responses: { adapter: "openai-responses", baseUrl: "https://responses.fixture.invalid/v1", authMode: "key",
        apiKey: "fixture-key", models: ["model"], liveModels: false, fetch: send("responses") },
    },
    routingProfiles: { tools: { candidates: [{ provider: "chat", model: "model" }, { provider: "responses", model: "model" }] } },
  };
  return { config, sent };
}

function request(toolChoice: unknown, tools: unknown[] | undefined, model = "chat/model", input: unknown = "Use the selected tool."): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input, stream: false, store: false, tools, tool_choice: toolChoice }),
  });
}

test("direct translated Chat rejects an unrepresentable computer_use choice before send", async () => {
  const { config, sent } = fixture();
  const response = await handleResponses(request({ type: "computer_use" }, [{ type: "computer_use" }, clientTool]), config, {});
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("mandatory tool_choice cannot be preserved");
  expect(sent).toEqual([]);
});

test.each(["computer_use", "computer_use_preview", "file_search", "code_interpreter"])(
  "required with only a dropped %s tool is refused before Chat sends", async type => {
    const { config, sent } = fixture();
    const response = await handleResponses(request("required", [{ type }]), config, {});
    expect(response.status, await response.text()).toBe(400);
    expect(sent).toEqual([]);
  },
);

test("required still accepts a mixed catalog when a declared client tool survives", async () => {
  const { config, sent } = fixture();
  const response = await handleResponses(request("required", [{ type: "computer_use" }, clientTool]), config, {});
  expect(response.status, await response.text()).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body.tool_choice).toBe("required");
  expect((sent[0]!.body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)).toEqual(["shell"]);
});

test("a policy skips an empty translated required catalog and retains its native tools", async () => {
  const { config, sent } = fixture();
  const tools = [{ type: "computer_use" }];
  const response = await handleResponses(request("required", tools, "policy/tools"), config, {});
  expect(response.status, await response.text()).toBe(200);
  expect(sent.map(row => row.provider)).toEqual(["responses"]);
  expect(sent[0]!.body.tool_choice).toBe("required");
  expect(sent[0]!.body.tools).toEqual(tools);
});

for (const type of ["additional_tools", "tool_search_output"]) for (const model of ["chat/model", "policy/tools"]) {
  test(`required retains a client tool loaded from ${type} on ${model}`, async () => {
    const { config, sent } = fixture();
    const input = [{ type, role: "developer", call_id: "search-fixture", status: "completed", tools: [clientTool] },
      { role: "user", content: "Use shell." }];
    const response = await handleResponses(request("required", [{ type: "file_search" }], model, input), config, {});
    expect(response.status, await response.text()).toBe(200);
    expect(sent.map(row => row.provider)).toEqual(["chat"]);
    expect((sent[0]!.body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)).toEqual(["shell"]);
  });
}

for (const type of ["additional_tools", "tool_search_output"]) for (const model of ["chat/model", "policy/tools"])
  for (const topLevel of [undefined, []]) {
    test(`required input-only ${type} rejects empty Chat tools on ${model}, top=${String(topLevel)}`, async () => {
      const { config, sent } = fixture([{ id: "file-fixture", type: "file_search_call", status: "completed" }]);
      const input = [{ type, role: "developer", call_id: "search-fixture", status: "completed", tools: [{ type: "file_search" }] },
        { role: "user", content: "Use the loaded tool." }];
      const response = await handleResponses(request("required", topLevel, model, input), config, {});
      expect(response.status, await response.text()).toBe(model === "chat/model" ? 400 : 200);
      expect(sent.map(row => row.provider)).toEqual(model === "chat/model" ? [] : ["responses"]);
      if (sent.length) {
        expect(sent[0]!.body.tool_choice).toBe("required");
        const forwarded = sent[0]!.body.input as Array<Record<string, unknown>>;
        if (type === "tool_search_output") {
          // The native adapter lowers this carrier to its supported result envelope.
          expect(forwarded[0]!.type).toBe("function_call_output");
          expect(forwarded[0]!.call_id).toBe("search-fixture");
          expect(JSON.parse(String(forwarded[0]!.output))).toEqual({ tools: [{ type: "file_search" }], status: "completed" });
        } else expect(forwarded).toEqual(input);
      }
    });
  }

test("native Chat cannot replace a required named MCP tool with a same-named client function", async () => {
  const { config, sent } = fixture();
  const response = await handleResponses(request(mcpChoice, [mcpTool, clientTool]), config, {});
  expect(response.status, await response.text()).toBe(400);
  expect(sent).toEqual([]);
});

test.each(["required", { type: "function", name: "shell" }, {
  type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "shell" }],
}])("representable client tool choice %j reaches Chat unchanged", async choice => {
  const { config, sent } = fixture();
  const response = await handleResponses(request(choice, [clientTool]), config, {});
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.status).toBe("completed");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.provider).toBe("chat");
  expect(sent[0]!.body.tool_choice).toEqual(choice === "required" ? "required" : { type: "function", function: { name: "shell" } });
});

test("a policy skips incompatible Chat and preserves the mandatory selector for Responses", async () => {
  const { config, sent } = fixture();
  const choice = { type: "computer_use" };
  const log: RequestLogContext = {};
  const response = await handleResponses(request(choice, [{ type: "computer_use" }, clientTool], "policy/tools"), config, log);
  expect(response.status, await response.text()).toBe(200);
  expect(log.routeDecision?.selected.provider).toBe("chat");
  expect(sent.map(row => row.provider)).toEqual(["responses"]);
  expect(log.provider).toBe("responses");
  expect(sent[0]!.body.tool_choice).toEqual(choice);
});

test("a shadow-intercepted policy route retries a compatible candidate on the real endpoint", async () => {
  // The intercept rewrites the model to the profile AFTER the body's parse hook, so the retry
  // snapshot must exist before interception — otherwise the captured policy route skips
  // traversal and the caller sees the internal candidate refusal instead of this hop.
  const { config, sent } = fixture();
  config.shadowCallIntercept = { enabled: true, model: "policy/tools", sourceModels: ["shadow-helper"] };
  const choice = { type: "computer_use" };
  const log: RequestLogContext = {};
  const response = await handleResponses(
    request(choice, [{ type: "computer_use" }, clientTool], "shadow-helper-x"), config, log);
  expect(response.status, await response.text()).toBe(200);
  expect(log.shadowCallRewrittenFrom).toBe("shadow-helper");
  expect(log.routeDecision?.selected.provider).toBe("chat");
  expect(sent.map(row => row.provider)).toEqual(["responses"]);
  expect(sent[0]!.body.tool_choice).toEqual(choice);
});

test("a policy preserves required MCP ownership across translator-budget fallback", async () => {
  const output = [{ id: "mcp_fixture", type: "mcp_call", status: "completed", server_label: "remote", name: "shell", arguments: "{}", output: "done" }];
  const { config, sent } = fixture(output);
  const log: RequestLogContext = {};
  const response = await handleResponses(request(mcpChoice, [mcpTool, clientTool], "policy/tools"), config, log);
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.status).toBe("completed");
  expect(log.routeDecision?.selected.provider).toBe("chat");
  expect(sent.map(row => row.provider)).toEqual(["responses"]);
  expect(log.provider).toBe("responses");
  expect(sent[0]!.body.tool_choice).toEqual(mcpChoice);
  expect(sent[0]!.body.tools).toEqual([mcpTool, clientTool]);
  expect(body.output).toEqual(output);
});
