import { expect, mock, spyOn, test } from "bun:test";
import { geminiNativeReasoningFields, geminiSseTransform, rawJsonMember, unwrapGeminiResponse, wrapGeminiRequest } from "../../src/server/gemini-native-wire";

const response = '{"candidates":[{"finishReason":"STOP","content":{"parts":[{"thoughtSignature":"a+/=","functionCall":{"args":{"n":9007199254740993123}}}]}}],"future":1.000e+40,"promptFeedback":{"blockReason":"SAFETY"}}';
test("Gemini JSON retains integers, number spelling, unknown fields and signature bytes", () => {
  const raw = '{ "contents": [], "future":9007199254740993123, "s":"\\u0061" }';
  expect(rawJsonMember(wrapGeminiRequest(raw, "gemini-test", "project"), "request")).toBe(raw.trim());
  expect(unwrapGeminiResponse(`{"response":${response},"other":{"response":null}}`)).toBe(response);
});
test("envelope extraction handles escaped keys, nesting, braces in strings and rejects ambiguity", () => {
  expect(unwrapGeminiResponse('{"respon\\u0073e":{"s":"},\\\"","a":[{}]}}')).toBe('{"s":"},\\\"","a":[{}]}');
  for (const raw of ['[]', '{}', '{"response":null}', '{"response":{},"response":{}}', '{"response":{']) {
    expect(() => unwrapGeminiResponse(raw)).toThrow();
  }
});
async function transform(
  text: string, chunk = 1, limit?: number, observers?: Parameters<typeof geminiSseTransform>[1],
): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(offset, offset + chunk)); offset = Math.min(bytes.length, offset + chunk);
  } });
  return new Response(body.pipeThrough(geminiSseTransform(limit, observers))).text();
}
test("SSE accepts byte-split UTF8, CRLF, comments and multiple events", async () => {
  const frame = `: ping\r\ndata: {"response":${response}}\r\n\r\n`;
  const unicode = 'data: {"response":{"text":"中文😀","promptFeedback":{"blockReason":"SAFETY"}}}\n\n';
  expect(await transform(frame + unicode)).toBe(`data: ${response}\n\ndata: {"text":"中文😀","promptFeedback":{"blockReason":"SAFETY"}}\n\n`);
});
test("SSE supports multiline data and lone CR framing", async () => {
  expect(await transform('data: {"response":\rdata: {"promptFeedback":{"blockReason":"SAFETY"}}}\r\r')).toBe('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n');
});
test("SSE rejects truncation, oversized frames and missing wrappers", async () => {
  for (const raw of ['data: {"response":{}}', 'data: {}\n\n', 'data: [DONE]\n\n']) {
    await expect(transform(raw)).rejects.toThrow();
  }
  await expect(transform('data: {"response":{"text":"too long"}}\n\n', 1, 20)).rejects.toThrow();
});

test("SSE requires every observed candidate to finish; DONE alone is insufficient", async () => {
  const frame = (response: string) => `data: {"response":${response}}\n\n`;
  const first = frame('{"candidates":[{"index":0},{"index":1}]}');
  const one = frame('{"candidates":[{"index":0,"finishReason":"STOP"}]}');
  const two = frame('{"candidates":[{"index":1,"finishReason":"STOP"}]}');
  await expect(transform(first + one)).rejects.toThrow("incomplete");
  await expect(transform(first + "data: [DONE]\n\n")).rejects.toThrow();
  expect(await transform(first + one + two + "data: [DONE]\n\n")).toBe([first, one, two].map(text => `data: ${unwrapGeminiResponse(text.slice(6).trim())}\n\n`).join(''));
});

test("SSE prefixes each preserved JSON line inside an extracted multiline response", async () => {
  const raw = '{\n  "candidates": [{"finishReason":"STOP"}],\n  "future":9007199254740993123,\n  "signature":"a+/="\n}';
  const frame = `data: {"response":${raw.replaceAll("\n", "\ndata: ")}}\n\n`;
  const result = await transform(frame, 3);
  expect(result).toBe(`data: ${raw.replaceAll("\n", "\ndata: ")}\n\n`);
  // A standard SSE consumer must recover the complete original JSON, including its newlines.
  const data = result.trimEnd().split("\n").map(line => {
    expect(line.startsWith("data: ")).toBe(true);
    return line.slice(6);
  }).join("\n");
  expect(data).toBe(raw);
});

test("fragmented 1 MiB SSE lines perform only linear UTF-8 encoding work", async () => {
  const raw = `{"candidates":[{"finishReason":"STOP"}],"padding":"${"x".repeat(1024 * 1024)}"}`;
  const frame = `data: {"response":${raw}}\n\n`;
  const originalEncode = TextEncoder.prototype.encode;
  let encodedBytes = 0;
  const encoder = spyOn(TextEncoder.prototype, "encode").mockImplementation(function(this: TextEncoder, text?: string) {
    const bytes = originalEncode.call(this, text);
    encodedBytes += bytes.byteLength;
    return bytes;
  });
  let result: string;
  try { result = await transform(frame, 1024); }
  finally { encoder.mockRestore(); }
  expect(result!).toBe(`data: ${raw}\n\n`);
  // Input plus output are about 2 MiB; re-encoding retained prefixes would exceed 500 MiB.
  expect(encodedBytes).toBeLessThan(frame.length * 3);
});

test("native SSE reports the final cumulative usage once, retaining all original frames", async () => {
  const frames = [
    '{"candidates":[{"index":0}],"usageMetadata":{"promptTokenCount":19,"candidatesTokenCount":2}}',
    '{"candidates":[{"index":0,"finishReason":"STOP"}]}',
    '{"usageMetadata":{"promptTokenCount":19,"candidatesTokenCount":6,"thoughtsTokenCount":9,"future":9007199254740993123}}',
    '{"usageMetadata":{"candidatesTokenCount":"unreported"}}',
  ];
  const upstream = frames.map(json => `data: {"response":${json}}\n\n`).join("");
  for (const terminator of ["", "data: [DONE]\n\n"]) {
    const onUsage = mock();
    const result = await transform(upstream + terminator, 7, undefined, { onUsage });
    expect(result).toBe(frames.map(json => `data: ${json}\n\n`).join(""));
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 19, outputTokens: 15, reasoningOutputTokens: 9 });
  }
});

test("native SSE does not report partial usage when the response fails", async () => {
  const frame = 'data: {"response":{"candidates":[{"index":0}],"usageMetadata":{"promptTokenCount":19,"candidatesTokenCount":2}}}\n\n';
  const onUsage = mock();
  await expect(transform(frame, 7, undefined, { onUsage })).rejects.toThrow("incomplete Gemini generation");
  const error = 'data: {"response":{"error":{"message":"rejected"}}}\n\n';
  await transform(frame + error, 7, undefined, { onUsage });
  expect(onUsage).not.toHaveBeenCalled();
});

test("native reasoning diagnostics reflect the request controls and model wire tier", () => {
  expect(geminiNativeReasoningFields({}, "gemini-4-neon-medium")).toEqual({ effectiveEffort: "medium" });
  const level = { generation_config: { thinking_config: { thinking_level: "HIGH" } } };
  expect(geminiNativeReasoningFields(level, "gemini-4-neon-medium")).toEqual({
    requestedEffort: "high", effectiveEffort: "medium", reasoningWireField: "thinkingLevel", reasoningWireValue: "HIGH",
  });
  expect(geminiNativeReasoningFields(level, "gemini-3.7-flash-tiered").effectiveEffort).toBe("high");
  const budget = { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } };
  expect(geminiNativeReasoningFields(budget, "gemini-3.7-flash-tiered")).toEqual({
    requestedEffort: "auto", effectiveEffort: undefined, reasoningWireField: "thinkingBudget", reasoningWireValue: "-1",
  });
  const invalid = { generationConfig: { thinkingConfig: { thinkingLevel: "fixture-unrecognized" } } };
  expect(geminiNativeReasoningFields(invalid, "gemini-3.7-flash-tiered")).toEqual({ effectiveEffort: undefined });
});

test("native output observation separates thoughts from visible content and ignores usage-only frames", async () => {
  const frames = [
    '{"candidates":[{"content":{"parts":[{"text":"summary","thought":true}]}}]}',
    '{"candidates":[{"content":{"parts":[{"thoughtSignature":"signature"},{"text":""}]}}]}',
    '{"candidates":[{"content":{"parts":[{"text":"answer"}]}}]}',
    '{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"thoughtsTokenCount":12,"candidatesTokenCount":3}}',
  ];
  const onOutput = mock();
  const upstream = frames.map(json => `data: {"response":${json}}\n\n`).join("");
  expect(await transform(upstream, 11, undefined, { onOutput }))
    .toBe(frames.map(json => `data: ${json}\n\n`).join(""));
  expect(onOutput.mock.calls).toEqual([[false, true], [true, false]]);
});
