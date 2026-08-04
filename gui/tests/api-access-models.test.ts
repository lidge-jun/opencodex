import { describe, expect, test } from "bun:test";
import {
  classifyExternalModel,
  gatewayInboundProtocols,
} from "../src/api-access-models";

describe("classifyExternalModel", () => {
  test("keeps bare native OpenAI ids and marks them native via owned_by", () => {
    expect(classifyExternalModel({ id: "gpt-5.4", owned_by: "openai" })).toEqual({
      id: "gpt-5.4",
      displayName: "gpt-5.4",
      provider: "openai",
      native: true,
      custom: false,
    });
  });

  test("classifies bare combo aliases from owned_by without rewriting the id", () => {
    expect(classifyExternalModel({ id: "fast-chat", owned_by: "combo" })).toEqual({
      id: "fast-chat",
      displayName: "fast-chat",
      provider: "combo",
      native: false,
      custom: false,
    });
  });

  test("classifies bare provider aliases from owned_by", () => {
    expect(classifyExternalModel({ id: "flash-lite", owned_by: "gemini" })).toEqual({
      id: "flash-lite",
      displayName: "flash-lite",
      provider: "gemini",
      native: false,
      custom: true,
    });
  });

  test("keeps namespaced provider ids", () => {
    expect(classifyExternalModel({ id: "anthropic/claude-sonnet-4-6", owned_by: "anthropic" })).toEqual({
      id: "anthropic/claude-sonnet-4-6",
      displayName: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      native: false,
      custom: true,
    });
  });
});

describe("gatewayInboundProtocols", () => {
  test("lists gateway protocols and hides Messages when Claude inbound is off", () => {
    expect(gatewayInboundProtocols(true)).toEqual(["responses", "chat", "messages"]);
    expect(gatewayInboundProtocols(false)).toEqual(["responses", "chat"]);
  });
});
