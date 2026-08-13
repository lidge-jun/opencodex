import { expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { bridgeToResponsesSSE } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import { buildToolBridgeMaps } from "../src/server/responses";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://api.x.ai/v1",
  apiKey: "test-key",
};

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

function parseSse(text: string): Array<{ event?: string; data: Record<string, unknown> }> {
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const data = lines.find(line => line.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

test("routed Code Mode does not forbid nested apply_patch when it is absent from the flat catalog", () => {
  const parsed: OcxParsedRequest = {
    modelId: "grok-4.6",
    context: {
      systemPrompt: ["Use apply_patch for local file edits."],
      messages: [{ role: "user", content: "Edit the requested file.", timestamp: 0 }],
      tools: [
        {
          name: "exec",
          description: "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };",
          parameters: {},
        },
        { name: "wait", description: "Wait for an exec cell.", parameters: {} },
        { name: "request_user_input", description: "Ask the user a question.", parameters: {} },
      ],
    },
    stream: false,
    options: {},
  };

  const request = createOpenAIChatAdapter(provider).buildRequest(parsed);
  const body = JSON.parse(request.body) as {
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ function?: { name?: string; description?: string } }>;
  };

  const systemText = body.messages
    .filter(message => message.role === "system" && typeof message.content === "string")
    .map(message => message.content as string)
    .join("\n");
  const execTool = body.tools?.find(tool => tool.function?.name === "exec");

  // Reproduce the actual Code Mode shape: patching exists only as a nested exec helper,
  // not as a top-level wire tool. Before 0325a5a the injected nudge contradicted this
  // contract by explicitly forbidding apply_patch, which pushed routed models to Python/sed.
  expect(execTool?.function?.description).toContain("apply_patch");
  expect(body.tools?.some(tool => tool.function?.name === "apply_patch")).toBe(false);
  expect(systemText).toContain("Use apply_patch for local file edits.");
  expect(systemText).toContain("Valid tool names for this turn are exactly `exec`, `wait`, `request_user_input`");
  expect(systemText).toContain("Do not use neighboring-agent tool names");
  expect(systemText).not.toMatch(/Do not use neighboring-agent tool names[^.]*apply_patch/);
});

test("routed chat round-trips a declared apply_patch custom tool with valid freeform input", async () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: ocx-apply-patch-smoke.txt",
    "+apply patch smoke",
    "*** End Patch",
  ].join("\n");
  const parsed = parseRequest({
    model: "xai/grok-4.6",
    input: "Create the smoke-test file.",
    stream: true,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  });
  const maps = buildToolBridgeMaps(parsed);
  const adapter = createOpenAIChatAdapter(provider);

  // Responses custom/freeform tools are lowered to a normal chat function with one string
  // field. If this wrapper changes or disappears, routed chat models cannot call apply_patch.
  const outbound = JSON.parse(adapter.buildRequest(parsed).body) as {
    tools?: Array<{
      type?: string;
      function?: {
        name?: string;
        parameters?: { properties?: { input?: { type?: string } } };
      };
    }>;
  };
  expect(outbound.tools?.find(tool => tool.function?.name === "apply_patch")).toMatchObject({
    type: "function",
    function: {
      name: "apply_patch",
      parameters: { properties: { input: { type: "string" } } },
    },
  });

  // Simulate the routed chat model selecting that function. The adapter must parse the call,
  // then the Responses bridge must unwrap {input:string} back into a native custom_tool_call.
  const upstreamPayload = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ input: patch }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
  const upstream = new Response(`data: ${upstreamPayload}\n\ndata: [DONE]\n\n`);
  const bridged = bridgeToResponsesSSE(
    adapter.parseStream(upstream),
    parsed.modelId,
    maps.toolNsMap,
    maps.freeformToolNames,
    maps.toolSearchToolNames,
    undefined,
    2_000,
    { declaredToolNames: maps.declaredToolNames },
  );
  const frames = parseSse(await new Response(bridged).text());

  const inputDone = frames.find(frame => frame.event === "response.custom_tool_call_input.done")?.data;
  expect(inputDone?.input).toBe(patch);

  const itemDone = frames.find(frame => {
    if (frame.event !== "response.output_item.done") return false;
    const item = frame.data.item as Record<string, unknown> | undefined;
    return item?.type === "custom_tool_call" && item.name === "apply_patch";
  })?.data.item as Record<string, unknown> | undefined;
  expect(itemDone).toMatchObject({
    type: "custom_tool_call",
    call_id: "call_patch",
    name: "apply_patch",
    input: patch,
    status: "completed",
  });

  const completed = frames.find(frame => frame.event === "response.completed")?.data.response as
    | { status?: string; output?: Array<Record<string, unknown>> }
    | undefined;
  expect(completed?.status).toBe("completed");
  expect(completed?.output).toContainEqual(expect.objectContaining({
    type: "custom_tool_call",
    name: "apply_patch",
    input: patch,
    status: "completed",
  }));
  expect(frames.some(frame => frame.event === "response.failed")).toBe(false);
});
