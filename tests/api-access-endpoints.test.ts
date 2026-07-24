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
      claudeCodeEnabled: true,
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
      claudeCodeEnabled: true,
    });
  });

  test("brackets IPv6 hostnames for URL display", () => {
    expect(buildApiAccessEndpoints({ hostname: "::1", port: 10100 })).toEqual({
      baseUrl: "http://[::1]:10100/v1",
      endpoint: "http://[::1]:10100/v1/responses",
      responsesEndpoint: "http://[::1]:10100/v1/responses",
      chatCompletionsEndpoint: "http://[::1]:10100/v1/chat/completions",
      messagesEndpoint: "http://[::1]:10100/v1/messages",
      modelsEndpoint: "http://[::1]:10100/v1/models",
      claudeCodeEnabled: true,
    });
  });

  test("normalizes wildcard bind hosts to loopback for display URLs", () => {
    expect(buildApiAccessEndpoints({ hostname: "0.0.0.0", port: 10100 })).toEqual({
      baseUrl: "http://127.0.0.1:10100/v1",
      endpoint: "http://127.0.0.1:10100/v1/responses",
      responsesEndpoint: "http://127.0.0.1:10100/v1/responses",
      chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
      messagesEndpoint: "http://127.0.0.1:10100/v1/messages",
      modelsEndpoint: "http://127.0.0.1:10100/v1/models",
      claudeCodeEnabled: true,
    });
  });

  test("reflects disabled Claude inbound in API access metadata", () => {
    expect(buildApiAccessEndpoints({ claudeCode: { enabled: false } }).claudeCodeEnabled).toBe(false);
  });
});
