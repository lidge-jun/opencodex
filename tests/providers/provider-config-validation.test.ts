import { describe, expect, test } from "bun:test";
import {
  apiKeyTransportConfigError,
  booleanRecordConfigError,
  modelAdapterRecordConfigError,
  modelDisplayNamesConfigError,
  nonBlankStringArrayConfigError,
  normalizeNonBlankStringArray,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  providerProxyConfigError,
  reasoningSummaryDeliveryRecordConfigError,
  upstreamHttpVersionConfigError,
} from "../../src/config/provider-validation";
import {
  parseProviderEditorConfigDTO,
  providerEditorConfigDTO,
  providerManagementConfigError,
  safeConfigDTO,
} from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";

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

  test("accepts only absent or explicit http(s) provider proxy URLs", () => {
    expect(providerProxyConfigError(undefined)).toBeNull();
    expect(providerProxyConfigError("http://127.0.0.1:7897")).toBeNull();
    expect(providerProxyConfigError("https://proxy.example:8443")).toBeNull();
    for (const value of [null, 8080, true, {}, []]) {
      expect(providerProxyConfigError(value)).toContain("string URL");
    }
    for (const value of ["", "   "]) {
      expect(providerProxyConfigError(value)).toContain("must not be empty");
    }
    expect(providerProxyConfigError("direct")).toContain("Phase 1A");
    expect(providerProxyConfigError("auto")).toContain("Phase 1A");
    for (const value of ["not a url", "socks5://127.0.0.1:1080", "ftp://127.0.0.1:21", "gopher://127.0.0.1:70"]) {
      expect(providerProxyConfigError(value)).toContain("http(s)");
    }
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

  test("accepts safe display names for exact provider model ids", () => {
    expect(modelDisplayNamesConfigError(undefined)).toBeNull();
    expect(modelDisplayNamesConfigError({})).toBeNull();
    expect(modelDisplayNamesConfigError({ "models/grok-4.6": "Grok 4.6" })).toBeNull();
    expect(modelDisplayNamesConfigError({ "grok-4.6": "A".repeat(128) })).toBeNull();
  });

  test("rejects unsafe discovered model display name maps", () => {
    expect(modelDisplayNamesConfigError([])).toContain("plain object");
    expect(modelDisplayNamesConfigError(Object.create({ inherited: "Unsafe" }))).toContain("own properties");
    expect(modelDisplayNamesConfigError(Object.fromEntries(
      Array.from({ length: 2_001 }, (_, index) => [`model-${index}`, `Model ${index}`]),
    ))).toContain("at most 2000 entries");
    expect(modelDisplayNamesConfigError({ " ": "Blank key" })).toContain("valid model ids");
    expect(modelDisplayNamesConfigError({ ["m".repeat(1_025)]: "Long key" })).toContain("valid model ids");
    expect(modelDisplayNamesConfigError({ model: 7 })).toContain("must be a string");
    expect(modelDisplayNamesConfigError({ model: "   " })).toContain("nonblank");
    expect(modelDisplayNamesConfigError({ model: "  Grok 4.6  " })).toContain("must be trimmed");
    expect(modelDisplayNamesConfigError({ model: "A".repeat(129) })).toContain("at most 128 characters");
    expect(modelDisplayNamesConfigError({ model: "Grok/4.6" })).toContain("must not contain /");
    expect(modelDisplayNamesConfigError({ model: "Grok\n4.6" })).toContain("control characters");
  });

  test("does not echo a secret shaped model id in display name errors", () => {
    const secretModelId = ["sk", "secret", "model", "id", "123456"].join("-");
    const error = modelDisplayNamesConfigError({ [secretModelId]: "Bad/Name" });
    expect(error).not.toContain(secretModelId);
    expect(error).toContain("[REDACTED]");
  });
});

describe("provider proxy management boundary", () => {
  const manageableBase = {
    adapter: "openai-chat",
    baseUrl: "https://api.example.test/v1",
  };

  test("management validation accepts absent and explicit http(s) proxy URLs", () => {
    expect(providerManagementConfigError("xai", { ...manageableBase })).toBeNull();
    expect(
      providerManagementConfigError("xai", { ...manageableBase, proxy: "http://127.0.0.1:7897" }),
    ).toBeNull();
    expect(
      providerManagementConfigError("xai", { ...manageableBase, proxy: "https://proxy.example:8443" }),
    ).toBeNull();
  });

  test("management validation rejects invalid proxy values before persistence", () => {
    for (const proxy of [null, 8080, true, "", "   ", "direct", "auto", "not a url", "socks5://127.0.0.1:1080", "ftp://127.0.0.1:21"]) {
      expect(providerManagementConfigError("xai", { ...manageableBase, proxy })).not.toBeNull();
    }
  });

  test("management proxy errors never echo embedded credentials", () => {
    const error = providerManagementConfigError("xai", {
      ...manageableBase,
      proxy: "socks5://bob:s3cret-9@127.0.0.1:1080",
    });
    expect(error).not.toBeNull();
    expect(error).not.toContain("s3cret-9");
    expect(error).not.toContain("bob");
  });

  test("credential-bearing proxy stays out of dashboard DTOs", () => {
    const config = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          ...manageableBase,
          proxy: "http://alice:s3cret-1@127.0.0.1:7897",
        },
      },
    } as unknown as OcxConfig;
    const serialized = JSON.stringify(safeConfigDTO(config));
    expect(serialized).not.toContain("\"proxy\"");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("s3cret-1");
    const editorSerialized = JSON.stringify(providerEditorConfigDTO(config));
    expect(editorSerialized).not.toContain("\"proxy\"");
    expect(editorSerialized).not.toContain("s3cret-1");
  });

  test("raw editor round-trip refuses the redacted proxy field", () => {
    const parsed = parseProviderEditorConfigDTO({
      defaultProvider: "xai",
      providers: {
        xai: { ...manageableBase, proxy: "http://127.0.0.1:7897" },
      },
    });
    expect(parsed.ok).toBe(false);
  });
});
