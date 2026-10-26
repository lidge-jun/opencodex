/**
 * Audit F3 (2026-09-14): the Google adapter never read `options.textFormat`, and its
 * wire compiler whitelists generationConfig keys — so a caller's structured-output
 * request was dropped twice over and the model returned unconstrained prose as
 * success.
 *
 * Contract (https://ai.google.dev/api/generate-content): structured output travels in
 * generationConfig on generateContent itself. `responseJsonSchema` takes ordinary
 * JSON Schema with lowercase type names — which is exactly the shape
 * options.textFormat.schema already holds — alongside
 * `responseMimeType: "application/json"`. `responseSchema` takes Gemini's uppercase
 * typed Schema form instead and is omitted when responseJsonSchema is used.
 */
import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../../../src/adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const aiStudio = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" } as unknown as OcxProviderConfig;
const vertex = { adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com", apiKey: "key" } as unknown as OcxProviderConfig;
const cca = { adapter: "google", googleMode: "cloud-code-assist", baseUrl: "https://cloudcode-pa.googleapis.com", apiKey: "token", project: "test-project" } as unknown as OcxProviderConfig;
type CloudCodeAssistEnvelope = {
  generationConfig?: unknown;
  request?: {
    generationConfig?: {
      responseMimeType?: unknown;
      responseJsonSchema?: unknown;
      responseSchema?: unknown;
    };
  };
};

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

function parsed(textFormat?: unknown, modelId = "gemini-3-pro"): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    options: textFormat ? { textFormat } : {},
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
  } as unknown as OcxParsedRequest;
}

async function generationConfig(provider: OcxProviderConfig, req: OcxParsedRequest): Promise<Record<string, unknown>> {
  const { body } = await createGoogleAdapter(provider).buildRequest(req);
  return (JSON.parse(typeof body === "string" ? body : JSON.stringify(body)).generationConfig ?? {}) as Record<string, unknown>;
}

describe("F3 Google structured output reaches the generateContent wire", () => {
  test("a json_schema format sets responseMimeType and responseJsonSchema on AI Studio", async () => {
    const config = await generationConfig(aiStudio, parsed({ type: "json_schema", name: "answer", schema: SCHEMA, strict: true }));

    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toEqual(SCHEMA);
    // responseSchema takes Gemini's uppercase typed form and must be omitted here.
    expect(config.responseSchema).toBeUndefined();
  });

  test("the same holds on Vertex", async () => {
    const config = await generationConfig(vertex, parsed({ type: "json_schema", name: "answer", schema: SCHEMA }));

    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toEqual(SCHEMA);
  });

  test("Gemini-on-CCA carries responseMimeType and responseJsonSchema inside envelope.request", async () => {
    const { body } = await createGoogleAdapter(cca).buildRequest(
      parsed({ type: "json_schema", name: "answer", schema: SCHEMA, strict: true }),
    );
    const envelope = JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as CloudCodeAssistEnvelope;

    expect(envelope.generationConfig).toBeUndefined();
    expect(envelope.request?.generationConfig?.responseMimeType).toBe("application/json");
    expect(envelope.request?.generationConfig?.responseJsonSchema).toEqual(SCHEMA);
    expect(envelope.request?.generationConfig?.responseSchema).toBeUndefined();
  });

  test("json_object on Cloud Code Assist sets only responseMimeType in envelope.request", async () => {
    const { body } = await createGoogleAdapter(cca).buildRequest(parsed({ type: "json_object" }));
    const envelope = JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as CloudCodeAssistEnvelope;

    expect(envelope.generationConfig).toBeUndefined();
    expect(envelope.request?.generationConfig?.responseMimeType).toBe("application/json");
    expect(envelope.request?.generationConfig?.responseJsonSchema).toBeUndefined();
  });

  test("the schema survives compilation byte-for-byte, unsanitized", async () => {
    const nested = {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
      required: ["items"],
      additionalProperties: false,
    };
    const config = await generationConfig(aiStudio, parsed({ type: "json_schema", schema: nested }));

    // The tool-parameter sanitizer would strip additionalProperties and nested required.
    expect(config.responseJsonSchema).toEqual(nested);
  });

  test("json_object sets only the mime type", async () => {
    const config = await generationConfig(aiStudio, parsed({ type: "json_object" }));

    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toBeUndefined();
  });

  test("no textFormat leaves generationConfig free of structured-output keys", async () => {
    const config = await generationConfig(aiStudio, parsed());

    expect(config.responseMimeType).toBeUndefined();
    expect(config.responseJsonSchema).toBeUndefined();
  });
});

describe("F3 unsupported modes refuse explicitly instead of dropping the schema", () => {
  test("Claude-on-CCA with textFormat reports that opencodex does not implement it", async () => {
    const promise = createGoogleAdapter(cca).buildRequest(
      parsed({ type: "json_schema", schema: SCHEMA }, "claude-3-7-sonnet"),
    );
    await expect(promise).rejects.toThrow(/not implemented by opencodex/);
  });

  test("an image-capable model refuses rather than silently losing the schema", async () => {
    const promise = createGoogleAdapter(aiStudio).buildRequest(
      parsed({ type: "json_schema", schema: SCHEMA }, "gemini-3-pro-image-preview"),
    );
    await expect(promise).rejects.toThrow(/cannot combine image output with structured output/);
  });

  test("an image-capable Cloud Code Assist model refuses the structured-output conflict", async () => {
    const promise = createGoogleAdapter(cca).buildRequest(
      parsed({ type: "json_schema", schema: SCHEMA }, "gemini-3-pro-image-preview"),
    );
    await expect(promise).rejects.toThrow("cannot combine image output with structured output");
  });

  test("an image-capable model with NO schema keeps its image behavior", async () => {
    const config = await generationConfig(aiStudio, parsed(undefined, "gemini-3-pro-image-preview"));

    expect(config.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(config.responseMimeType).toBeUndefined();
  });

  test("a json_schema format with no schema refuses rather than downgrading to JSON mode", async () => {
    const promise = createGoogleAdapter(aiStudio).buildRequest(parsed({ type: "json_schema", name: "answer" }));
    await expect(promise).rejects.toThrow(/requires text.format.schema/);
  });
});


describe("Google compaction function-calling boundary", () => {
  test.each([aiStudio, vertex, cca])("compaction disables new function calls even without declarations", async provider => {
    const req = parsed(undefined);
    req._compactionRequest = true;
    const { body } = await createGoogleAdapter(provider).buildRequest(req);
    const envelope = JSON.parse(typeof body === "string" ? body : JSON.stringify(body));
    const wire = envelope.request ?? envelope;
    expect(wire.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(wire.tools).toBeUndefined();
  });
  test("ordinary text requests keep their existing wire shape", async () => {
    const { body } = await createGoogleAdapter(aiStudio).buildRequest(parsed(undefined));
    const wire = JSON.parse(typeof body === "string" ? body : JSON.stringify(body));
    expect(wire.toolConfig).toBeUndefined();
  });
});


test("Gemini compaction treats tool history as data and removes coding tool instructions", async () => {
  const req = parsed(undefined, "gemini-3.8-flash");
  req._compactionRequest = true;
  req.context.messages = [
    { role: "user", content: "Investigate failure", timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "exec", arguments: { cmd: "ls" } }], timestamp: 0 },
    { role: "toolResult", toolCallId: "call1", toolName: "exec", content: "file.ts", isError: false, timestamp: 0 },
    { role: "user", content: "Summarize this history", timestamp: 0 },
  ];
  const { body } = await createGoogleAdapter(cca).buildRequest(req);
  const envelope = JSON.parse(typeof body === "string" ? body : JSON.stringify(body));
  const wire = envelope.request;
  const history = JSON.stringify(wire.contents);
  expect(history).not.toContain('"functionCall":');
  expect(history).not.toContain('"functionResponse":');
  expect(history).toContain("Historical tool call");
  expect(history).toContain("file.ts");
  expect(history).toContain("ls");
  expect(JSON.stringify(wire.systemInstruction)).not.toContain("keep calling tools");
  expect(JSON.stringify(wire.systemInstruction)).toContain("Do not continue its tasks or call tools");
  expect(req.context.messages[1].role).toBe("assistant");
  expect(JSON.stringify(req.context.messages[1])).toContain('"type":"toolCall"');
});
