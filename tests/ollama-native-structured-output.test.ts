import { describe, expect, test } from "bun:test";
import { createOllamaNativeAdapter } from "../src/adapters/ollama-native";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

/**
 * Structured output is a capability boundary, not a formatting preference.
 *
 * Ollama documents that "Ollama's Cloud currently does not support structured outputs"
 * (ollama/ollama docs/capabilities/structured-outputs.mdx). Cloud does not reject the `format`
 * field — it answers 200 and ignores it — so forwarding the field would hand the caller
 * unconstrained prose while its request said the answer would be schema-valid. The adapter
 * refuses the contract instead, the same call Kiro makes for a wire that cannot enforce it.
 *
 * Local and custom self-hosted Ollama honour `format`, so they keep mapping it.
 */

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "ollama-native",
    baseUrl: "https://ollama.com/v1",
    authMode: "key",
    apiKey: "test-key-not-a-real-credential",
    liveModels: false,
    models: ["glm-5.3-flash"],
    ...overrides,
  } as OcxProviderConfig;
}

const LOCAL = { baseUrl: "http://localhost:11434/v1", authMode: "local", apiKey: undefined } as Partial<OcxProviderConfig>;
const CUSTOM = { baseUrl: "https://ollama.internal.example/api", authMode: "key", apiKey: "test-key-not-a-real-credential" } as Partial<OcxProviderConfig>;

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as Record<string, unknown>;

function parsedWith(options: Record<string, unknown> = {}, modelId = "glm-5.3-flash"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    options,
    context: { messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
}

const JSON_OBJECT = { textFormat: { type: "json_object" } };
const JSON_SCHEMA = { textFormat: { type: "json_schema", name: "answer", schema: SCHEMA } };

describe("ollama-native — structured output is refused on canonical Ollama Cloud", () => {
  test("canonical Cloud + json_object fails closed", () => {
    expect(() => createOllamaNativeAdapter(provider()).buildRequest(parsedWith(JSON_OBJECT)))
      .toThrow("ollama-native does not support structured output on Ollama Cloud");
  });

  test("canonical Cloud + json_schema fails closed", () => {
    expect(() => createOllamaNativeAdapter(provider()).buildRequest(parsedWith(JSON_SCHEMA)))
      .toThrow("ollama-native does not support structured output on Ollama Cloud");
  });

  test("every accepted canonical Cloud base-URL spelling refuses it, not just the stored /v1 form", () => {
    for (const baseUrl of ["https://ollama.com", "https://ollama.com/v1", "https://ollama.com/api", "https://ollama.com/api/chat", "https://ollama.com./api"]) {
      expect(() => createOllamaNativeAdapter(provider({ baseUrl })).buildRequest(parsedWith(JSON_SCHEMA)), baseUrl)
        .toThrow("ollama-native does not support structured output on Ollama Cloud");
    }
  });

  test("www Ollama spelling cannot bypass the Cloud structured-output boundary", () => {
    expect(() => createOllamaNativeAdapter(provider({ baseUrl: "https://www.ollama.com/v1" }))
      .buildRequest(parsedWith(JSON_SCHEMA)))
      .toThrow("requires canonical Ollama Cloud host ollama.com");
  });

  test("CONTROL: ordinary Cloud prose is completely unaffected", () => {
    const request = createOllamaNativeAdapter(provider()).buildRequest(parsedWith({}));
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(request.url).toBe("https://ollama.com/api/chat");
    expect(body).not.toHaveProperty("format");
    expect(body.model).toBe("glm-5.3-flash");
    expect(Array.isArray(body.messages)).toBe(true);
  });

  test("CONTROL: unrelated parsed request options do not trip the structured-output guard", () => {
    // `textFormat` remains unset; unrelated parsed request options do not mean structured output.
    const request = createOllamaNativeAdapter(provider()).buildRequest(parsedWith({ temperature: 0 }));
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("format");
    expect((body.options as Record<string, unknown>).temperature).toBe(0);
  });
});

describe("ollama-native — local and custom endpoints keep native structured output", () => {
  test("local Ollama serializes json_object as format:\"json\"", () => {
    const request = createOllamaNativeAdapter(provider(LOCAL)).buildRequest(parsedWith(JSON_OBJECT));
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(request.url).toBe("http://localhost:11434/api/chat");
    expect(body.format).toBe("json");
  });

  test("local Ollama serializes a json_schema as the schema object itself", () => {
    const request = createOllamaNativeAdapter(provider(LOCAL)).buildRequest(parsedWith(JSON_SCHEMA));
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    // Ollama's native contract takes the schema directly, not OpenAI's response_format wrapper.
    expect(body.format).toEqual(SCHEMA);
    expect(body.format).not.toHaveProperty("json_schema");
  });

  test("custom self-hosted Ollama keeps both native format spellings", () => {
    const objectBody = JSON.parse(
      createOllamaNativeAdapter(provider(CUSTOM)).buildRequest(parsedWith(JSON_OBJECT)).body as string,
    ) as Record<string, unknown>;
    expect(objectBody.format).toBe("json");

    const schemaRequest = createOllamaNativeAdapter(provider(CUSTOM)).buildRequest(parsedWith(JSON_SCHEMA));
    const schemaBody = JSON.parse(schemaRequest.body as string) as Record<string, unknown>;
    expect(schemaRequest.url).toBe("https://ollama.internal.example/api/chat");
    expect(schemaBody.format).toEqual(SCHEMA);
  });

  test("a malformed json_schema still fails on its own terms off Cloud", () => {
    // The Cloud guard must not swallow the pre-existing schema-shape validation.
    expect(() => createOllamaNativeAdapter(provider(LOCAL))
      .buildRequest(parsedWith({ textFormat: { type: "json_schema", name: "answer" } })))
      .toThrow("ollama-native json_schema output requires a JSON schema object");
  });
});
