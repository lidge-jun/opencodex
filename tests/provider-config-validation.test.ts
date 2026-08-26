import { describe, expect, test } from "bun:test";
import {
  apiKeyTransportConfigError,
  booleanRecordConfigError,
  modelAdapterRecordConfigError,
  nonBlankStringArrayConfigError,
  normalizeNonBlankStringArray,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  reasoningSummaryDeliveryRecordConfigError,
  upstreamHttpVersionConfigError,
} from "../src/config/provider-validation";

describe("provider config validation leaf", () => {
  test("accepts only credential-free HTTP(S) base URLs", () => {
    expect(providerBaseUrlConfigError("https://example.test/v1")).toBeNull();
    expect(providerBaseUrlConfigError("file:///tmp/provider")).toBe("baseUrl must be an http(s) URL");
    expect(providerBaseUrlConfigError("https://user:pass@example.test/v1")).toContain("embedded credentials");
    expect(providerBaseUrlConfigError("https://example.test/v1?token=x")).toContain("query strings");
    expect(providerBaseUrlConfigError("not a url")).toBe("baseUrl must be a valid URL");
  });

  test("rejects sensitive, malformed, non-string, and multiline headers", () => {
    expect(providerHeadersConfigError({ "X-Custom": "ok" })).toBeNull();
    expect(providerHeadersConfigError({ Authorization: "Bearer secret" })).toContain("sensitive header");
    expect(providerHeadersConfigError({ "Bad Header": "x" })).toContain("valid HTTP header names");
    expect(providerHeadersConfigError({ "X-Count": 1 })).toContain("must be a string");
    expect(providerHeadersConfigError({ "X-Custom": "ok\r\nInjected: yes" })).toContain("line breaks");
  });

  test("keeps apiKeyTransport on Anthropic API-key providers only", () => {
    expect(apiKeyTransportConfigError({ adapter: "anthropic", authMode: "key", apiKeyTransport: "bearer" })).toBeNull();
    expect(apiKeyTransportConfigError({ adapter: "openai-chat", authMode: "key", apiKeyTransport: "bearer" })).toContain("anthropic adapter");
    expect(apiKeyTransportConfigError({ adapter: "anthropic", authMode: "oauth", apiKeyTransport: "bearer" })).toContain("API-key authentication");
    expect(apiKeyTransportConfigError({ adapter: "anthropic", authMode: "key", apiKeyTransport: "invalid" as "bearer" })).toContain("x-api-key");
  });

  test("shares the upstream HTTP-version enum across write and load boundaries", () => {
    for (const value of [undefined, null, "auto", "http1.1", "h1", "http2", "h2"]) {
      expect(upstreamHttpVersionConfigError(value)).toBeNull();
    }
    expect(upstreamHttpVersionConfigError("h3")).toContain("must be one of");
  });

  test("requires own-property positive integer maps", () => {
    expect(positiveIntegerRecordConfigError({ model: 1 }, "limits")).toBeNull();
    expect(positiveIntegerRecordConfigError(Object.create({ inherited: 1 }), "limits")).toContain("own properties");
    expect(positiveIntegerRecordConfigError({ " ": 1 }, "limits")).toContain("nonblank model ids");
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      expect(positiveIntegerConfigError(value, "limit")).toContain("positive finite integer");
    }
  });

  test("validates and normalizes model-id lists in separate phases", () => {
    expect(nonBlankStringArrayConfigError([" model-a ", "model-b"], "models")).toBeNull();
    expect(nonBlankStringArrayConfigError(["model-a", "   "], "models")).toContain("models.1");
    expect(normalizeNonBlankStringArray([" model-a ", "model-a", "model-b"])).toEqual(["model-a", "model-b"]);
  });

  test("validates boolean capability maps before cross-field delivery checks", () => {
    expect(booleanRecordConfigError({ model: true }, "supports")).toBeNull();
    expect(booleanRecordConfigError(Object.create({ model: true }), "supports")).toContain("own properties");
    expect(reasoningSummaryDeliveryRecordConfigError({ model: "sequential" }, { model: true })).toBeNull();
    expect(reasoningSummaryDeliveryRecordConfigError({ model: "unknown" }, { model: true })).toContain("must be one of");
    expect(reasoningSummaryDeliveryRecordConfigError({ model: "sequential" }, { model: false })).toContain("conflicts");
  });

  test("rejects invalid, wire-pinned, and canonical-forward model adapter overrides", () => {
    const keyed = { adapter: "openai-responses", authMode: "key", baseUrl: "https://example.test/v1" };
    expect(modelAdapterRecordConfigError({ model: "openai-chat" }, "modelAdapters", "custom", keyed)).toBeNull();
    expect(modelAdapterRecordConfigError({ model: "anthropic" }, "modelAdapters", "custom", keyed)).toContain("must be one of");
    expect(modelAdapterRecordConfigError(
      { "minimax-m3": "openai-chat" },
      "modelAdapters",
      "opencode-go",
      keyed,
    )).toContain("only speaks one wire");
    expect(modelAdapterRecordConfigError(
      { "gpt-5.5": "openai-chat" },
      "modelAdapters",
      "openai",
      { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
    )).toContain("canonical ChatGPT forward provider");
  });
});
