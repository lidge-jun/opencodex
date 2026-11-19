import { expect, spyOn, test } from "bun:test";
import { geminiSseTransform, rawJsonMember, unwrapGeminiResponse, wrapGeminiRequest } from "../../src/server/gemini-native-wire";

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
async function transform(text: string, chunk = 1, limit?: number): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(offset, offset + chunk)); offset = Math.min(bytes.length, offset + chunk);
  } });
  return new Response(body.pipeThrough(geminiSseTransform(limit))).text();
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
