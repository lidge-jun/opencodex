/**
 * Antigravity direct lane: the Chat -> IR decoder is held to the bridge it replaces.
 *
 * For every body below, the request the core prepares on the direct lane (the settings-only body
 * parsed by `parseRequest`, plus `chatConversationToIr` for the conversation) must equal what
 * `parseRequest(chatCompletionsToResponsesBody(body))` builds on the bridge, field for field
 * except `_rawBody` and timestamps. Bodies the bridge refuses must be refused with the same
 * message. If either side changes alone, this file fails; that is the point of it.
 */
import { describe, expect, test } from "bun:test";
import {
  chatCompletionsToResponsesBody,
  chatSettingsToResponsesBody,
} from "../../src/chat/inbound";
import {
  chatConversationToIr,
  chatIrRouteEvidence,
  withDirectChatConversation,
} from "../../src/protocols/codecs/chat-ir";
import { featureEffectsForPath, PROTOCOL_FEATURES } from "../../src/protocols/features";
import { requestPathForLane } from "../../src/protocols/path";
import { parseRequest } from "../../src/responses/parser";
import { evidenceFromBody } from "../../src/routing/request-evidence";
import type { OcxParsedRequest } from "../../src/types";

const MODEL = "google-antigravity/gemini-3.8-flash";
const IDENTITY = "You are a coding agent powered by the gpt-6. If asked which model you are, identify as gpt-6. "
  + "Do not claim to be a different model or to have a different creator.";
const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 fixture").toString("base64")}`;
const PNG = "data:image/png;base64,iVBORw0KGgo=";

type Body = Record<string, unknown>;

function comparable(parsed: OcxParsedRequest): unknown {
  const { _rawBody: _ignored, ...rest } = parsed;
  return JSON.parse(JSON.stringify(rest, (key, value) => key === "timestamp" ? 0 : value));
}

function viaBridge(body: Body): OcxParsedRequest {
  return parseRequest(chatCompletionsToResponsesBody(clone(body)));
}

function viaDirect(body: Body): OcxParsedRequest {
  const source = clone(body);
  const decoded = chatConversationToIr(source, source.model as string);
  return withDirectChatConversation(parseRequest(chatSettingsToResponsesBody(source)), source, decoded);
}

/** A JSON round trip, as the ingress reads bodies: keeps an own `__proto__` key. */
function clone(body: Body): Body {
  return JSON.parse(JSON.stringify(body)) as Body;
}

const CORPUS: Record<string, Body> = {
  "a single user string": {
    model: MODEL,
    messages: [{ role: "user", content: "hello" }],
  },
  "leading system and developer are hoisted and named for the destination": {
    model: MODEL,
    messages: [
      { role: "system", content: `  ${IDENTITY}  ` },
      { role: "developer", content: [{ type: "text", text: "second instruction" }] },
      { role: "user", content: "hi" },
    ],
  },
  "a later system message keeps its slot as a developer turn": {
    model: MODEL,
    messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "system", content: IDENTITY },
      { role: "user", content: "u2" },
    ],
  },
  "an empty user turn does not end the leading instruction block": {
    model: MODEL,
    messages: [
      { role: "user", content: "" },
      { role: "system", content: "still leading" },
      { role: "user", content: "real" },
    ],
  },
  "user media: text, image with detail, video with processing, inline document, bare string": {
    model: MODEL,
    messages: [{
      role: "user",
      content: [
        "plain string part",
        { type: "text", text: "" },
        { type: "image_url", image_url: { url: PNG, detail: "low" } },
        { type: "image_url", image_url: "https://example.com/cat.png" },
        { type: "video_url", video_url: { url: "https://www.youtube.com/watch?v=abc", processing: "agentic" } },
        { type: "file", file: { file_data: PDF, filename: "spec.pdf" } },
      ],
    }],
  },
  "tool calls, results with images, held mid-batch instruction and reasoning": {
    model: MODEL,
    tools: [
      { type: "function", function: { name: "lookup", description: "find", parameters: { type: "object", properties: { q: { type: "string" } } }, strict: true } },
      { type: "function", name: "flat_tool", parameters: { properties: {} } },
      { type: "function", function: { name: "lookup", description: "duplicate is dropped" } },
    ],
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "find two things" },
      {
        role: "assistant",
        reasoning_content: "I should look both up.",
        content: [{ type: "text", text: "Looking." }, { type: "output_text", text: "" }],
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "lookup", arguments: "{\"q\":\"a\"}" } },
          { id: "call_b", type: "function", function: { name: "flat_tool", arguments: { q: "b" } } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "result a" },
      { role: "developer", content: "held until the batch drains" },
      { role: "tool", tool_use_id: "call_b", content: [{ type: "text", text: "see image" }, { type: "image_url", image_url: { url: PNG, detail: "high" } }] },
      { role: "user", content: "thanks" },
    ],
  },
  "tool-only assistant turns merge and reasoning after the call joins its owner": {
    model: MODEL,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", reasoning_details: [{ text: "part one " }, { text: "part two" }], tool_calls: [
        { id: "call_1", function: { name: "first", arguments: "" } },
      ] },
      { role: "assistant", reasoning_content: "late reasoning" },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
      { role: "assistant", reasoning_content: "r1" },
      { role: "assistant", reasoning_content: "r2", content: "answer" },
      { role: "user", content: "again" },
      { role: "assistant", tool_calls: [{ id: "call_2", function: { name: "first", arguments: "\"k\":1}" } }] },
      { role: "assistant", tool_calls: [{ id: "call_3", function: { name: "second", arguments: "not json" } }] },
      { role: "tool", tool_call_id: "call_2", content: "ok" },
      { role: "tool", tool_call_id: "call_3", content: "ok" },
    ],
  },
  "a tool call without a name reuses the name its id already carries": {
    model: MODEL,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", tool_calls: [{ id: "call_x", function: { name: "named", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_x", content: "ok" },
      { role: "assistant", tool_calls: [{ id: "call_x", function: { arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_x", content: "again" },
    ],
  },
  "legacy functions and function_call pairing": {
    model: MODEL,
    functions: [{ name: "legacy", description: "old style", parameters: { type: "object" } }],
    function_call: { name: "legacy" },
    messages: [
      { role: "user", content: "call it" },
      { role: "assistant", content: null, function_call: { name: "legacy", arguments: { a: 1 } } },
      { role: "function", name: "legacy", content: "legacy result" },
      { role: "assistant", function_call: { name: "legacy", arguments: "{}" } },
      { role: "function", name: "legacy", content: [{ type: "text", text: "second" }] },
    ],
  },
  "settings ride the Responses body unchanged": {
    model: MODEL,
    stream: true,
    max_completion_tokens: 512,
    temperature: 0.2,
    top_p: 0.9,
    stop: ["END"],
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    parallel_tool_calls: false,
    service_tier: "priority",
    prompt_cache_key: "cache-key",
    user: "user-1",
    reasoning_effort: "high",
    include_reasoning: true,
    response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } },
    tools: [{ type: "function", function: { name: "pick" } }],
    tool_choice: { type: "function", function: { name: "pick" } },
    messages: [{ role: "user", content: "fmt" }],
  },
  "an allowed-tools choice and reasoning disabled": {
    model: MODEL,
    reasoning_effort: "none",
    tools: [{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }],
    tool_choice: { type: "allowed_tools", allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "a" } }] } },
    messages: [{ role: "user", content: "pick" }],
  },
  "only instructions": {
    model: MODEL,
    messages: [{ role: "system", content: "just instructions" }],
  },
  "tool parameters with an own __proto__ key": JSON.parse(
    `{"model":"${MODEL}","messages":[{"role":"user","content":"x"}],`
    + `"tools":[{"type":"function","function":{"name":"p","parameters":{"type":"object","__proto__":{"x":1},"properties":{}}}},`
    + `{"type":"function","function":{"name":"q","parameters":{"__proto__":{"y":2}}}}]}`,
  ) as Body,
};

describe("Chat -> IR direct decode parity with the Responses bridge", () => {
  for (const [name, body] of Object.entries(CORPUS)) {
    test(name, () => {
      expect(comparable(viaDirect(body))).toEqual(comparable(viaBridge(body)));
    });
  }

  test("the settings-only body is the bridge body without its conversation", () => {
    for (const body of Object.values(CORPUS)) {
      const { input: _input, instructions: _instructions, tools: _tools, ...settings } = chatCompletionsToResponsesBody(clone(body));
      expect(chatSettingsToResponsesBody(clone(body))).toEqual({ ...settings, input: [] });
    }
  });

  test("routing evidence matches what the core reads from the bridge body", () => {
    for (const body of Object.values(CORPUS)) {
      const decoded = chatConversationToIr(clone(body), MODEL);
      expect(chatIrRouteEvidence(decoded)).toEqual(evidenceFromBody(chatCompletionsToResponsesBody(clone(body))));
    }
  });

  test("a model the core settled differently is decoded again for that model", () => {
    const body = CORPUS["leading system and developer are hoisted and named for the destination"]!;
    const decoded = chatConversationToIr(clone(body), MODEL);
    const renamed = { ...clone(body), model: "google-antigravity/other-model" };
    const base = parseRequest(chatSettingsToResponsesBody(renamed));
    expect(comparable(withDirectChatConversation(base, renamed, decoded))).toEqual(comparable(viaBridge(renamed)));
  });

  test("the decoder does not hand the caller's tool parameters to the IR by reference", () => {
    const body = clone(CORPUS["tool calls, results with images, held mid-batch instruction and reasoning"]!);
    const decoded = chatConversationToIr(body, MODEL);
    const tool = decoded.context.tools!.find(entry => entry.name === "lookup")!;
    tool.parameters.mutated = true;
    const source = ((body.tools as Body[])[0]!.function as Body).parameters as Body;
    expect(source.mutated).toBeUndefined();
  });
});

describe("Chat -> IR direct decode refuses what the bridge refuses", () => {
  const INVALID: Record<string, Body> = {
    "tool message without an id": { model: MODEL, messages: [{ role: "tool", content: "x" }] },
    "tool call without any name": { model: MODEL, messages: [{ role: "assistant", tool_calls: [{ id: "c", function: { arguments: "{}" } }] }] },
    "function result without a name": { model: MODEL, messages: [{ role: "function", content: "x" }] },
    "function result with no pending call": { model: MODEL, messages: [{ role: "function", name: "f", content: "x" }] },
    "function result with an image": { model: MODEL, messages: [{ role: "function", name: "f", content: [{ type: "image_url", image_url: { url: PNG } }] }] },
    "assistant function_call without a name": { model: MODEL, messages: [{ role: "assistant", function_call: { arguments: "{}" } }] },
    "functions that are not an array": { model: MODEL, functions: {}, messages: [{ role: "user", content: "x" }] },
    "a function without a name": { model: MODEL, functions: [{ description: "x" }], messages: [{ role: "user", content: "x" }] },
    "no conversational turn": { model: MODEL, messages: [{ role: "user", content: "" }] },
    "untranslated audio": { model: MODEL, messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }] }] },
    "a file part without inline bytes": { model: MODEL, messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-1" } }] }] },
  };
  for (const [name, body] of Object.entries(INVALID)) {
    test(name, () => {
      let bridgeMessage: string | undefined;
      try { chatCompletionsToResponsesBody(clone(body)); } catch (err) { bridgeMessage = (err as Error).message; }
      expect(bridgeMessage).toBeDefined();
      expect(() => chatConversationToIr(clone(body), MODEL)).toThrow(bridgeMessage!);
    });
  }
});

describe("feature effects on the direct path", () => {
  test("every Chat feature meets the same disposition as on the bridge path", () => {
    const direct = featureEffectsForPath("chat", requestPathForLane("chat", "direct", "other"), PROTOCOL_FEATURES);
    const bridge = featureEffectsForPath("chat", requestPathForLane("chat", "bridge", "other"), PROTOCOL_FEATURES);
    expect(direct).toEqual(bridge);
  });

  test("the direct lane exists only toward an other upstream", () => {
    expect(requestPathForLane("chat", "direct", "other")).toEqual(["chat", "ir", "other"]);
    expect(requestPathForLane("messages", "direct", "other")).toEqual(["messages", "ir", "other"]);
    expect(requestPathForLane("chat", "direct", "responses")).toEqual(["chat", "responses"]);
    expect(requestPathForLane("chat", "direct", "messages")).toEqual(["chat", "responses-internal", "ir", "messages"]);
    expect(requestPathForLane("responses", "direct", "other")).toEqual(["responses", "ir", "other"]);
  });
});
