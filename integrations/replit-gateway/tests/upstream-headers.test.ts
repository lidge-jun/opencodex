import { describe, expect, test } from "bun:test";
import { buildAnthropicUpstreamHeaders, buildOpenAiUpstreamHeaders } from "../src/relay/upstream-headers";

describe("upstream header construction", () => {
  test("buildOpenAiUpstreamHeaders injects only the managed upstream credential", () => {
    const headers = buildOpenAiUpstreamHeaders({
      baseUrl: "https://integrations.replit.com/openai/v1",
      apiKey: "replit-openai-secret",
      allowedModels: ["gpt-4o"],
    });
    expect(headers.get("Authorization")).toBe("Bearer replit-openai-secret");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect([...headers.keys()]).toEqual(["authorization", "content-type"]);
  });

  test("buildAnthropicUpstreamHeaders injects only the managed upstream credential", () => {
    const headers = buildAnthropicUpstreamHeaders({
      baseUrl: "https://integrations.replit.com/anthropic",
      apiKey: "replit-anthropic-secret",
      allowedModels: ["claude-sonnet-4-6"],
    });
    expect(headers.get("x-api-key")).toBe("replit-anthropic-secret");
    expect(headers.get("anthropic-version")).toBeTruthy();
    expect(headers.get("Authorization")).toBeNull();
  });
});
