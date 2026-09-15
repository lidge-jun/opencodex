import { describe, expect, test } from "bun:test";
import { openaiModelsUrl } from "../../../src/adapters/openai-models-url";
import { buildModelsRequest } from "../../../src/oauth";
import type { OcxProviderConfig } from "../../../src/types";

describe("openai models URL normalization", () => {
  test("maps the four common paste shapes to the canonical models endpoint", () => {
    const expected = "https://api.example.test/v1/models";
    expect(openaiModelsUrl("https://api.example.test/v1")).toBe(expected);
    expect(openaiModelsUrl("https://api.example.test/v1/")).toBe(expected);
    expect(openaiModelsUrl("https://api.example.test/v1/models")).toBe(expected);
    expect(openaiModelsUrl("https://api.example.test/v1/models/")).toBe(expected);
  });

  test("trims surrounding whitespace before joining", () => {
    expect(openaiModelsUrl("  https://api.example.test/v1/  ")).toBe(
      "https://api.example.test/v1/models",
    );
  });

  test("preserves a mid-path prefix instead of forcing /v1", () => {
    expect(openaiModelsUrl("https://proxy.example.com/relay/v1/")).toBe(
      "https://proxy.example.com/relay/v1/models",
    );
  });

  test("does not false-positive on a path that only ends in somemodels", () => {
    expect(openaiModelsUrl("https://api.example.com/somemodels")).toBe(
      "https://api.example.com/somemodels/models",
    );
  });

  test("buildModelsRequest normalizes a custom provider baseUrl with a trailing slash", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.example.test/v1/",
      apiKey: "sk-test",
      authMode: "key",
    };
    const request = buildModelsRequest(provider, "sk-test", "custom-gateway");
    expect(request.url).toBe("https://api.example.test/v1/models");
  });

  test("does not throw for a provider without a baseUrl (capture path)", () => {
    const provider: OcxProviderConfig = { adapter: "openai-responses", liveModels: false, models: ["known"] };
    const request = buildModelsRequest(provider, undefined, "custom-gateway");
    expect(request.url.endsWith("/models")).toBe(true);
  });
});

