import { describe, expect, test } from "bun:test";
import { buildApiAccessEndpoints } from "../src/server/management/api-access";

describe("buildApiAccessEndpoints", () => {
  test("builds the external gateway URLs from hostname and port", () => {
    expect(buildApiAccessEndpoints({ hostname: "127.0.0.1", port: 10100 })).toEqual({
      baseUrl: "http://127.0.0.1:10100/v1",
      endpoint: "http://127.0.0.1:10100/v1/responses",
      responsesEndpoint: "http://127.0.0.1:10100/v1/responses",
      chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
      messagesEndpoint: "http://127.0.0.1:10100/v1/messages",
      modelsEndpoint: "http://127.0.0.1:10100/v1/models",
    });
  });

  test("falls back to the default bind when config fields are missing", () => {
    expect(buildApiAccessEndpoints({})).toEqual({
      baseUrl: "http://127.0.0.1:10100/v1",
      endpoint: "http://127.0.0.1:10100/v1/responses",
      responsesEndpoint: "http://127.0.0.1:10100/v1/responses",
      chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
      messagesEndpoint: "http://127.0.0.1:10100/v1/messages",
      modelsEndpoint: "http://127.0.0.1:10100/v1/models",
    });
  });
});
