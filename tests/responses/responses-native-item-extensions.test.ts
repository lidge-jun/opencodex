import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { createGoogleAdapter } from "../../src/adapters/google";
import { stripProviderInputItemMetadata } from "../../src/adapters/openai-responses/request-strips";
import { concreteComboRequestBody } from "../../src/combos/request";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import type { OcxProviderConfig } from "../../src/types";

const extra = { google: { thought_signature: "synthetic-history-signature-7111" } };
const call = { type: "function_call", call_id: "call_probe", name: "probe", arguments: '{"value":1}' };
const output = { type: "function_call_output", call_id: "call_probe", output: '{"extra_content":"tool data"}' };

function history() {
  return {
    model: "gpt-6-sol", stream: true, store: false,
    input: [
      { role: "user", content: "Continue the completed tool call." },
      { ...call, extra_content: structuredClone(extra) },
      { ...output },
    ],
    tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: { value: { type: "number" } } } }],
  };
}

function build(provider: OcxProviderConfig, body: ReturnType<typeof history>) {
  const budget = createTranslatorBudget();
  try {
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: body.model, context: { messages: [] }, stream: true, options: {}, _rawBody: body,
    }, { headers: new Headers(), translatorBudget: budget });
    try {
      const ws = prepareCodexWsRequest(request.url, {
        method: request.method, headers: request.headers, body: request.body,
      });
      expect(ws).not.toBeNull();
      return {
        http: JSON.parse(request.body),
        ws: JSON.parse(ws!.frameText),
        fallback: JSON.parse(ws!.httpInit.body as string),
      };
    } finally { request.releaseBodyObservation?.(); }
  } finally { budget.dispose(); }
}

describe("native Responses item extensions (#7111)", () => {
  test("copies only affected items and preserves nested tool data and unknown wire fields", () => {
    const untouched = Object.freeze({ type: "item_reference", id: "msg_stored" });
    const result = Object.freeze({ ...output, output: [{ type: "input_text", text: "result", extra_content: "nested data" }] });
    const extended = Object.freeze({ ...call, extra_content: extra, status: "completed" });
    const body = Object.freeze({ input: Object.freeze([untouched, extended, result]) });
    const projected = stripProviderInputItemMetadata(body) as { input: unknown[] };
    expect(projected).not.toBe(body);
    expect(projected.input[0]).toBe(untouched);
    expect(projected.input[1]).toEqual({ ...call, status: "completed" });
    expect(projected.input[2]).toBe(result);
    expect(extended.extra_content).toEqual(extra);
    expect(stripProviderInputItemMetadata(projected)).toBe(projected);
    expect(stripProviderInputItemMetadata({ input: "hello" })).toEqual({ input: "hello" });
  });

  const native: OcxProviderConfig[] = [
    { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex/", authMode: "forward" },
    { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key" },
    { adapter: "openai-responses", baseUrl: "https://api.openai.com", responsesPath: "/v1/responses", authMode: "key" },
  ];

  for (const provider of native) {
    test(`strips provider metadata for ${provider.baseUrl}${provider.responsesPath ?? ""} over HTTP and WS`, () => {
      const body = history();
      const before = structuredClone(body);
      const wire = build(provider, body);
      expect(wire.ws.type).toBe("response.create");
      for (const payload of Object.values(wire)) {
        expect(payload.input.find((item: { type?: string }) => item.type === "function_call")).toEqual(call);
        expect(payload.input.find((item: { type?: string }) => item.type === "function_call_output")).toEqual(output);
      }
      expect(body).toEqual(before);
    });
  }

  test("projects a concrete native combo child without sanitizing the parent or next gateway child", () => {
    const parent = history();
    const before = structuredClone(parent);
    const child = concreteComboRequestBody(parent, { provider: "openai", model: "gpt-6-sol" }, null, undefined);
    const nativeWire = build(native[0]!, child as ReturnType<typeof history>);
    for (const payload of Object.values(nativeWire)) {
      expect(payload.input.find((item: { type?: string }) => item.type === "function_call")).toEqual(call);
    }
    expect(child.input).toEqual(before.input);
    const nextChild = concreteComboRequestBody(parent, { provider: "gateway", model: "custom" }, null, undefined);
    const nextWire = build({ adapter: "openai-responses", baseUrl: "https://gateway.example/v1" }, nextChild as ReturnType<typeof history>);
    expect(nextWire.http.input.find((item: { type?: string }) => item.type === "function_call"))
      .toEqual({ ...call, extra_content: extra });
    expect(parent).toEqual(before);
  });

  test("native projection leaves the same history signed for a subsequent Google destination", async () => {
    const body = history();
    const before = structuredClone(body);
    build(native[0]!, body);
    const parsed = parseRequest({ ...body, model: "gemini-3.6-flash" });
    const budget = createTranslatorBudget();
    try {
      const google = createGoogleAdapter({
        adapter: "google", googleMode: "ai-studio", baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "synthetic-test-key",
      });
      const request = await google.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
      try {
        const parts = JSON.parse(request.body).contents.flatMap((item: { parts: unknown[] }) => item.parts);
        expect(parts.find((part: { functionCall?: unknown }) => part.functionCall)).toEqual({
          functionCall: { id: "call_probe", name: "probe", args: { value: 1 } },
          thoughtSignature: "synthetic-history-signature-7111",
        });
      } finally { request.releaseBodyObservation?.(); }
    } finally { budget.dispose(); }
    expect(body).toEqual(before);
  });

  const gateways: OcxProviderConfig[] = [
    { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key" },
    { adapter: "openai-responses", baseUrl: "https://gateway.example/codex", authMode: "forward" },
    { adapter: "openai-responses", baseUrl: "https://api.openai.com.evil.test/v1", authMode: "key" },
    { adapter: "openai-responses", baseUrl: "https://api.openai.com", responsesPath: "/other", authMode: "key" },
  ];

  for (const provider of gateways) {
    test(`preserves gateway extensions for ${provider.baseUrl} (${provider.authMode})`, () => {
      const body = history();
      for (const payload of Object.values(build(provider, body))) {
        expect(payload.input.find((item: { type?: string }) => item.type === "function_call"))
          .toEqual({ ...call, extra_content: extra });
      }
    });
  }
});
