import { describe, expect, test } from "bun:test";
import { buildResponsesTransport } from "../../src/adapters/openai-responses/transport";
import type { OcxProviderConfig } from "../../src/types";

// Regression coverage for the forward-mode baseUrl normalization: the previous implementation
// used `replace(/\/+$/, "")`, which retries candidate end positions when a long slash run is not
// at the end of the string. The replacement is a linear scan, pinned here on the shapes that
// distinguish the two. Provider validation requires an absolute http(s) baseUrl, so empty and
// slash-only values are outside this call's contract and are not exercised here.
const forwardProvider = (baseUrl: string): OcxProviderConfig => ({
  adapter: "openai-responses",
  authMode: "forward",
  baseUrl,
});

const incoming = { headers: new Headers() };

describe("buildResponsesTransport baseUrl normalization", () => {
  test("noncanonical forward baseUrl drops every trailing slash", () => {
    const { url } = buildResponsesTransport(forwardProvider("https://relay.example.test/v1///"), incoming);
    expect(url).toBe("https://relay.example.test/v1/responses");
  });

  test("a single trailing slash is dropped", () => {
    const { url } = buildResponsesTransport(forwardProvider("https://relay.example.test/"), incoming);
    expect(url).toBe("https://relay.example.test/responses");
  });

  test("a baseUrl without a trailing slash is unchanged", () => {
    const { url } = buildResponsesTransport(forwardProvider("https://relay.example.test/v1"), incoming);
    expect(url).toBe("https://relay.example.test/v1/responses");
  });

  test("interior slash runs are preserved", () => {
    const { url } = buildResponsesTransport(forwardProvider("https://relay.example.test//v1//"), incoming);
    expect(url).toBe("https://relay.example.test//v1/responses");
  });

  test("a mid-path slash run does not stall normalization", () => {
    // The input shape that made `/\/+$/` retry: a long slash run that is not at the end.
    // The linear scan treats it like any other URL and preserves it.
    const baseUrl = `https://relay.example.test${"/".repeat(2_000)}v1`;
    const { url } = buildResponsesTransport(forwardProvider(baseUrl), incoming);
    expect(url).toBe(`${baseUrl}/responses`);
  });
});
