import { expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import { buildToolBridgeMaps } from "../src/server/responses";
import type { OcxProviderConfig } from "../src/types";
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

test("Code Mode exec round-trips JavaScript that invokes nested tools.apply_patch", async () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: code-mode-patch.txt",
    "+from code mode",
    "*** End Patch",
  ].join("\n");
  const source = [
    `const patch = ${JSON.stringify(patch)};`,
    "await tools.apply_patch(patch);",
  ].join("\n");
  const parsed = parseRequest({
    model: "xai/grok-4.6",
    input: "Apply the patch through Code Mode.",
    stream: true,
    tools: [{ type: "custom", name: "exec", description: "Run JavaScript" }],
  });
  const maps = buildToolBridgeMaps(parsed);
  expect(maps.freeformToolNames.has("exec")).toBe(true);

  const adapter = createOpenAIChatAdapter(provider);
  const upstreamPayload = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_exec",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ input: source }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
  const bridged = bridgeToResponsesSSE(
    adapter.parseStream(new Response(`data: ${upstreamPayload}\n\ndata: [DONE]\n\n`)),
    parsed.modelId,
    maps.toolNsMap,
    maps.freeformToolNames,
    maps.toolSearchToolNames,
    undefined,
    2_000,
    { declaredToolNames: maps.declaredToolNames },
  );
  const frames = parseSse(await new Response(bridged).text());
  const execDone = frames.find(frame => {
    if (frame.event !== "response.output_item.done") return false;
    const item = frame.data.item as Record<string, unknown> | undefined;
    return item?.type === "custom_tool_call" && item.name === "exec";
  })?.data.item as Record<string, unknown> | undefined;

  expect(execDone).toMatchObject({
    type: "custom_tool_call",
    call_id: "call_exec",
    name: "exec",
    input: source,
    status: "completed",
  });
  expect(execDone?.input).toContain("tools.apply_patch");
  expect(execDone?.input).toContain(JSON.stringify(patch));
  expect(frames.some(frame => frame.event === "response.failed")).toBe(false);
});

test("fragmented streamed apply_patch arguments survive JSON escape boundaries", async () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: fragmented-patch.txt",
    "+fragmented",
    "*** End Patch",
  ].join("\n");
  const parsed = parseRequest({
    model: "xai/grok-4.6",
    input: "Create the fragmented smoke-test file.",
    stream: true,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  });
  const maps = buildToolBridgeMaps(parsed);
  const adapter = createOpenAIChatAdapter(provider);
  const encodedArgs = JSON.stringify({ input: patch });
  const slashPositions = [...encodedArgs.matchAll(/\\n/g)].map(match => match.index!);
  const cuts = [10, ...slashPositions.flatMap(index => [index + 1, index + 2]), encodedArgs.length]
    .filter((value, index, all) => value > 0 && value <= encodedArgs.length && all.indexOf(value) === index)
    .sort((a, b) => a - b);
  let start = 0;
  const fragments = cuts.map(end => {
    const fragment = encodedArgs.slice(start, end);
    start = end;
    return fragment;
  }).filter(fragment => fragment.length > 0);

  const wire = fragments.map((argumentsFragment, index) => {
    const first = index === 0;
    const last = index === fragments.length - 1;
    return `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            ...(first ? { id: "call_fragmented", type: "function" } : {}),
            function: {
              ...(first ? { name: "apply_patch" } : {}),
              arguments: argumentsFragment,
            },
          }],
        },
        ...(last ? { finish_reason: "tool_calls" } : {}),
      }],
    })}\n\n`;
  }).join("") + "data: [DONE]\n\n";

  const bridged = bridgeToResponsesSSE(
    adapter.parseStream(new Response(wire)),
    parsed.modelId,
    maps.toolNsMap,
    maps.freeformToolNames,
    maps.toolSearchToolNames,
    undefined,
    2_000,
    { declaredToolNames: maps.declaredToolNames },
  );
  const frames = parseSse(await new Response(bridged).text());
  const streamedInput = frames
    .filter(frame => frame.event === "response.custom_tool_call_input.delta")
    .map(frame => frame.data.delta as string)
    .join("");
  const inputDone = frames.find(frame => frame.event === "response.custom_tool_call_input.done")?.data;

  expect(slashPositions.length).toBeGreaterThan(0);
  expect(streamedInput).toBe(patch);
  expect(inputDone?.input).toBe(patch);
  expect(frames.some(frame => frame.event === "response.failed")).toBe(false);
});

test("non-streaming routed apply_patch restores a custom_tool_call with exact input", async () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: non-streaming-patch.txt",
    "+non streaming",
    "*** End Patch",
  ].join("\n");
  const parsed = parseRequest({
    model: "xai/grok-4.6",
    input: "Create the non-streaming smoke-test file.",
    stream: false,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  });
  const maps = buildToolBridgeMaps(parsed);
  const adapter = createOpenAIChatAdapter(provider);
  expect(adapter.parseResponse).toBeDefined();

  const events = await adapter.parseResponse!(new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_nonstream",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ input: patch }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  })));
  const response = buildResponseJSON(events, parsed.modelId, {
    toolNsMap: maps.toolNsMap,
    declaredToolNames: maps.declaredToolNames,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
  });
  const output = response.output as Array<Record<string, unknown>>;

  expect(response.status).toBe("completed");
  expect(output).toContainEqual(expect.objectContaining({
    type: "custom_tool_call",
    call_id: "call_nonstream",
    name: "apply_patch",
    input: patch,
    status: "completed",
  }));
});

test("apply_patch call and result replay into the next routed chat request", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: continuation-patch.txt",
    "+continuation",
    "*** End Patch",
  ].join("\n");
  const parsed = parseRequest({
    model: "xai/grok-4.6",
    input: [
      {
        type: "custom_tool_call",
        id: "ctc_patch",
        call_id: "call_continue_patch",
        name: "apply_patch",
        input: patch,
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_continue_patch",
        output: "Done!",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue after patch." }],
      },
    ],
    stream: true,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  });
  const adapter = createOpenAIChatAdapter(provider);
  const outbound = JSON.parse(adapter.buildRequest(parsed).body) as {
    messages: Array<{
      role?: string;
      content?: unknown;
      tool_call_id?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    }>;
  };

  const callIndex = outbound.messages.findIndex(message =>
    message.role === "assistant"
    && message.tool_calls?.some(call => call.id === "call_continue_patch"),
  );
  const resultIndex = outbound.messages.findIndex(message =>
    message.role === "tool" && message.tool_call_id === "call_continue_patch",
  );
  const userIndex = outbound.messages.findIndex(message =>
    message.role === "user" && message.content === "Continue after patch.",
  );

  expect(callIndex).toBeGreaterThanOrEqual(0);
  expect(resultIndex).toBeGreaterThan(callIndex);
  expect(userIndex).toBeGreaterThan(resultIndex);

  const replayedCall = outbound.messages[callIndex]?.tool_calls?.find(call => call.id === "call_continue_patch");
  expect(replayedCall?.function?.name).toBe("apply_patch");
  expect(JSON.parse(replayedCall?.function?.arguments ?? "{}"))
    .toEqual({ input: patch });
  expect(outbound.messages[resultIndex]).toMatchObject({
    role: "tool",
    tool_call_id: "call_continue_patch",
    content: "Done!",
  });
});
