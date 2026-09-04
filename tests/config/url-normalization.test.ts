import { describe, test, expect } from "bun:test";

describe("anthropic adapter URL normalization", () => {
  const normalize = (baseUrl: string) => {
    const base = baseUrl.replace(/\/v1\/?$/, "");
    return `${base}/v1/messages`;
  };

  test("strips trailing /v1 to prevent /v1/v1/messages (opencode-go)", () => {
    expect(normalize("https://opencode.ai/zen/go/v1")).toBe("https://opencode.ai/zen/go/v1/messages");
  });

  test("strips trailing /v1/ with slash", () => {
    expect(normalize("https://opencode.ai/zen/go/v1/")).toBe("https://opencode.ai/zen/go/v1/messages");
  });

  test("standard anthropic baseUrl is unaffected", () => {
    expect(normalize("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
  });

  test("does not strip /v1 from middle of URL", () => {
    expect(normalize("https://proxy.example.com/v1/relay")).toBe("https://proxy.example.com/v1/relay/v1/messages");
  });

  test("does not false-positive on URL ending in somev1", () => {
    expect(normalize("https://api.example.com/somev1")).toBe("https://api.example.com/somev1/v1/messages");
  });
});
