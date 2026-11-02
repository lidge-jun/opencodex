import { expect, spyOn, test } from "bun:test";
import { chatCompletionsErrorBody, collectChatCompletion, responsesSseToChatCompletionsSse, ChatCompletionsStreamError } from "../../src/chat/outbound";
import { nativeChatSse } from "../../src/server/chat-native-sse";
import { encodeChatCompletionSse } from "../../src/protocols/encoders/chat";
import { deliverClientEncodedResponse } from "../../src/server/inference/client-encoder-delivery";
import type { FailureVerdictSink } from "../../src/chat/failure-verdict";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { AdapterEvent } from "../../src/types";
const KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
async function verdict(stream: ReadableStream<Uint8Array>, sink?: FailureVerdictSink) {
  try { await collectChatCompletion(stream, "fixture", createTestTranslatorBudget(), sink); }
  catch (error) { expect(error).toBeInstanceOf(ChatCompletionsStreamError); const e = error as ChatCompletionsStreamError; return { status: e.status, type: e.type, code: e.code, message: e.message }; }
  throw new Error("Expected a terminal error frame");
}
const fixtures = [
  { message: `invalid api key ${KEY}`, status: 401, type: "authentication_error", code: "invalid_api_key" },
  { message: `model not found ${KEY}`, status: 404, type: "invalid_request_error", code: "invalid_request_error" },
  { message: `rate limit ${KEY}`, status: 429, type: "rate_limit_error", code: "rate_limit_exceeded" },
  { message: `quota exhausted ${KEY}`, status: 400, type: "insufficient_quota", code: "insufficient_quota" },
  { message: `cyber policy ${KEY}`, status: 400, type: "invalid_request_error", code: "cyber_policy" },
  { message: `invalid prompt ${KEY}`, status: 400, type: "invalid_request_error", code: "invalid_prompt" },
  { message: `transport failure ${KEY}`, status: 502, type: "server_error", code: "upstream_server_error" },
];
for (const fixture of fixtures) for (const producer of ["native", "translated", "direct", "delivery"] as const) test(`legacy collector verdict ${producer} ${fixture.code}`, async () => {
  const legacyPayload = chatCompletionsErrorBody(fixture.status, fixture.message, fixture.type, fixture.code);
  const expected = await verdict(new Response(frame(legacyPayload)).body!);
  expect(expected.type).toBe(fixture.type); expect(expected.code).toBe(fixture.code);
  const event: AdapterEvent = { type: "error", message: fixture.message, status: fixture.status, errorType: fixture.type, code: fixture.code };
  const events = async function* () { yield event; };
  if (producer === "delivery") {
    const response = await deliverClientEncodedResponse({ encoder: { protocol: "chat", model: "fixture", stream: false }, events: events(), logCtx: { provider: "fixture", model: "fixture" }, translatorBudget: createTestTranslatorBudget(), responseModelId: "fixture", adapterName: "openai-chat", fold: {}, stopUpstream() {}, onStreamDone() {}, onCompletedResponse() {}, bindUsage() {} });
    expect(response.status).toBe(expected.status);
    const body = await response.json(); expect(body.error.type).toBe(expected.type); expect(body.error.code).toBe(expected.code);
    expect(JSON.stringify(body)).not.toContain(KEY);
    return;
  }
  const sink: FailureVerdictSink = {};
  const budget = createTestTranslatorBudget();
  const stream = producer === "native" ? nativeChatSse(new Response(frame({ error: { ...fixture } })).body!, { requestedModel: "fixture", translatorBudget: budget, signal: new AbortController().signal, failureVerdictSink: sink, onUsage() {} })
    : producer === "translated" ? responsesSseToChatCompletionsSse(new Response(`event: response.failed\n${frame({ type: "response.failed", response: { status: "failed", error: fixture } })}`).body!, "fixture", { translatorBudget: budget, failureVerdictSink: sink })
    : encodeChatCompletionSse(events(), { model: "fixture", translatorBudget: budget, failureVerdictSink: sink });
  const [collected, wire] = stream.tee();
  const actual = await verdict(collected, sink);
  expect(actual).toEqual(expected);
  const text = await new Response(wire).text();
  const error = JSON.parse(text.split("\n").find(line => line.startsWith("data: {") && line.includes('"error"'))!.slice(6)).error;
  expect(error.type).toBe(expected.type); expect(error.code).toBe(expected.code);
  expect(text).not.toContain(KEY);
});
for (const producer of ["translated", "direct"]) test(`incomplete ${producer} retains the original collector verdict`, async () => {
  const sink: FailureVerdictSink = {};
  const budget = createTestTranslatorBudget();
  const message = `invalid api key ${KEY}`;
  const expected = await verdict(new Response(frame(chatCompletionsErrorBody(401, message, "authentication_error", "invalid_api_key"))).body!);
  const stream = producer === "translated" ? responsesSseToChatCompletionsSse(new Response(`event: response.incomplete\n${frame({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "adapter_eof", message } } })}`).body!, "fixture", { translatorBudget: budget, failureVerdictSink: sink })
    : encodeChatCompletionSse((async function* () { yield { type: "incomplete", reason: "adapter_eof", message } as AdapterEvent; })(), { model: "fixture", translatorBudget: budget, failureVerdictSink: sink });
  expect(await verdict(stream, sink)).toEqual(expected);
});

for (const producer of ["native", "translated", "direct"]) test(`suppressed error frame ${producer} does not convert EOF to failure`, async () => {
  const sink: FailureVerdictSink = {};
  const budget = createTestTranslatorBudget();
  const error = fixtures[0]!;
  const nativeBody = new Response(frame({ error })).body!;
  const translatedBody = new Response(`event: response.failed\n${frame({ type: "response.failed", response: { status: "failed", error } })}`).body!;
  const original = TextEncoder.prototype.encode;
  const encoding = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, input?: string) {
    if (input?.startsWith("data:") && input.includes('"error"')) throw new Error("fixture frame emission failed");
    return original.call(this, input);
  });
  try {
    const stream = producer === "native" ? nativeChatSse(nativeBody, { requestedModel: "fixture", translatorBudget: budget, signal: new AbortController().signal, failureVerdictSink: sink, onUsage() {} })
      : producer === "translated" ? responsesSseToChatCompletionsSse(translatedBody, "fixture", { translatorBudget: budget, failureVerdictSink: sink })
      : encodeChatCompletionSse((async function* () { yield { type: "error", message: error.message, status: 401 } as AdapterEvent; })(), { model: "fixture", translatorBudget: budget, failureVerdictSink: sink });
    const completion = await collectChatCompletion(stream, "fixture", budget, sink);
    expect(completion.object).toBe("chat.completion"); expect(completion.choices).toHaveLength(1);
    expect(sink.verdict).toBeUndefined();
  } finally { encoding.mockRestore(); }
});

for (const scenario of ["empty", "mid-tool", "read-error", "policy-read-error", "auth-read-error"]) test(`generated native failure retains the legacy envelope: ${scenario}`, async () => {
  const message = scenario === "empty" ? "upstream SSE ended before a terminal event"
    : scenario === "mid-tool" ? "upstream SSE ended mid tool call without a terminal signal — possible truncation"
    : scenario === "policy-read-error" ? `flagged for possible cybersecurity risk ${KEY}`
    : scenario === "auth-read-error" ? `invalid api key ${KEY}` : `fixture stream read failed ${KEY}`;
  const code = scenario === "empty" || scenario === "mid-tool" ? "upstream_sse_truncated" : "upstream_sse_error";
  const legacy = chatCompletionsErrorBody(502, message, "upstream_error", code);
  const expected = await verdict(new Response(frame(legacy)).body!);
  expect(expected.code).toBe(scenario === "policy-read-error" ? "cyber_policy" : code);
  const terminals: Array<{ status: number; message?: string }> = [];
  const sink: FailureVerdictSink = {};
  const input = scenario === "empty" ? new Response("").body!
    : scenario === "mid-tool" ? new Response(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] })).body!
    : new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error(message)); } });
  const stream = nativeChatSse(input, { requestedModel: "fixture", translatorBudget: createTestTranslatorBudget(), signal: new AbortController().signal,
    failureVerdictSink: sink, onUsage() {}, onTerminal(status, message) { terminals.push({ status, message }); } });
  const [collected, wire] = stream.tee();
  expect(await verdict(collected, sink)).toEqual(expected);
  expect(sink.verdict).toEqual(expected);
  expect(terminals).toEqual([{ status: 502, message }]);
  const text = await new Response(wire).text();
  const errorLine = text.split("\n").find(line => line.startsWith("data: {") && line.includes('"error"'));
  expect(errorLine).toBeDefined();
  const error = JSON.parse(errorLine!.slice(6)).error;
  expect(error.type).toBe(expected.type); expect(error.code).toBe(expected.code);
  if (scenario === "policy-read-error") expect(error.message).toBe("Request blocked by the upstream cybersecurity policy.");
  expect(text).not.toContain(KEY);
});
