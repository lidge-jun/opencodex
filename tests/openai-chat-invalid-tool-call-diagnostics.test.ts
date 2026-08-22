import { afterEach, beforeEach, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests } from "../src/lib/debug-settings";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
};

const previousDebug = process.env.OCX_DEBUG;

beforeEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  delete process.env.OCX_DEBUG;
});

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  if (previousDebug === undefined) delete process.env.OCX_DEBUG;
  else process.env.OCX_DEBUG = previousDebug;
});

async function collect(stream: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function requireErrorEvent(events: AdapterEvent[]): Extract<AdapterEvent, { type: "error" }> {
  const event = events.find((candidate): candidate is Extract<AdapterEvent, { type: "error" }> =>
    candidate.type === "error");
  if (!event) throw new Error("expected an error event");
  return event;
}

function malformedNameResponse(name: unknown, args = "{}"): Response {
  return new Response(
    `data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: { name, arguments: args },
          }],
        },
      }],
    })}\n\n`,
  );
}

test("object-valued streamed function.name is a 502 with value-free compatibility detail", async () => {
  const privateNameValue = "must-not-reach-diagnostics";
  const privateArguments = "must-not-reach-diagnostics-either";
  const adapter = createOpenAIChatAdapter(provider);
  const events = await collect(adapter.parseStream(malformedNameResponse(
    { privateNameValue },
    JSON.stringify({ value: privateArguments }),
  )));

  expect(events).toEqual([{
    type: "error",
    status: 502,
    errorType: "upstream_error",
    message: "upstream response contained invalid tool calls (tool_call_function_name_invalid; callIndex=0; valueType=object)",
  }]);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(privateNameValue);
  expect(serialized).not.toContain(privateArguments);
  expect(serialized).not.toContain("call_1");
  expect(getDebugLogEntries()).toEqual([]);
});

test("provider debug fingerprints only allowlisted object structure for an invalid field", async () => {
  process.env.OCX_DEBUG = "1";
  const privateNestedValue = "must-not-reach-provider-debug";
  const privateUnknownKey = "must-not-reach-provider-debug-as-a-key";
  const privateUnknownValue = "must-not-reach-provider-debug-as-a-value";
  const privateArguments = "must-not-reach-provider-debug-arguments";
  const adapter = createOpenAIChatAdapter(provider);

  const events = await collect(adapter.parseStream(malformedNameResponse({
    name: privateNestedValue,
    [privateUnknownKey]: privateUnknownValue,
  }, JSON.stringify({ privateArguments }))));

  expect(requireErrorEvent(events).message).not.toContain("fieldShape");
  const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
  expect(lines).toContain('[ocx:openai-chat:invalid-tool-calls]');
  expect(lines).toContain('"reason":"tool_call_function_name_invalid"');
  expect(lines).toContain('"fieldShape":{"kind":"object"');
  expect(lines).toContain('"knownKeys":["name"]');
  expect(lines).toContain('"knownFieldTypes":{"name":"string"}');
  expect(lines).toContain('"hasUnknownKeys":true');
  expect(lines).not.toContain(privateNestedValue);
  expect(lines).not.toContain(privateUnknownKey);
  expect(lines).not.toContain(privateUnknownValue);
  expect(lines).not.toContain(privateArguments);
  expect(lines).not.toContain("call_1");
});

test("provider debug fingerprints invalid arrays by length without retaining elements", async () => {
  process.env.OCX_DEBUG = "1";
  const privateElement = "must-not-reach-array-fingerprint";
  const adapter = createOpenAIChatAdapter(provider);

  const events = await collect(adapter.parseStream(malformedNameResponse([privateElement, { privateElement }])));

  expect(requireErrorEvent(events).message).not.toContain("fieldShape");
  const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
  expect(lines).toContain('"fieldShape":{"kind":"array","length":2}');
  expect(lines).not.toContain(privateElement);
});

test("provider debug fingerprints buffered invalid fields with the same privacy boundary", async () => {
  process.env.OCX_DEBUG = "1";
  const privateNestedValue = "must-not-reach-buffered-provider-debug";
  const privateUnknownKey = "must-not-reach-buffered-provider-debug-as-key";
  const privateUnknownValue = "must-not-reach-buffered-provider-debug-as-value";
  const privateArguments = "must-not-reach-buffered-provider-debug-arguments";
  const adapter = createOpenAIChatAdapter(provider);

  const events = await adapter.parseResponse!(new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_buffered_private",
          type: "function",
          function: {
            name: {
              name: privateNestedValue,
              [privateUnknownKey]: privateUnknownValue,
            },
            arguments: JSON.stringify({ privateArguments }),
          },
        }],
      },
    }],
  })));

  expect(requireErrorEvent(events).message).not.toContain("fieldShape");
  const lines = getDebugLogEntries().map(entry => entry.line).join("\n");
  expect(lines).toContain('"mode":"response"');
  expect(lines).toContain('"reason":"tool_call_function_name_invalid"');
  expect(lines).toContain('"fieldShape":{"kind":"object"');
  expect(lines).toContain('"knownKeys":["name"]');
  expect(lines).toContain('"knownFieldTypes":{"name":"string"}');
  expect(lines).toContain('"hasUnknownKeys":true');
  expect(lines).not.toContain(privateNestedValue);
  expect(lines).not.toContain(privateUnknownKey);
  expect(lines).not.toContain(privateUnknownValue);
  expect(lines).not.toContain(privateArguments);
  expect(lines).not.toContain("call_buffered_private");
});
