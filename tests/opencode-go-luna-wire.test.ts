/**
 * OpenCode Go is a mixed-wire provider. Its endpoint matrix assigns GPT 5.6 Luna
 * to Responses while its provider-wide default and most sibling models use Chat.
 * These tests protect both the exact-model correction and the explicit override
 * boundary that lets operators opt out if the upstream changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const MODEL = "gpt-5.6-luna";

function opencodeGo(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  const entry = getProviderRegistryEntry("opencode-go");
  if (!entry) throw new Error("missing opencode-go registry fixture");
  return { ...providerConfigSeed(entry), apiKey: "test-key", ...overrides };
}

describe("OpenCode Go GPT 5.6 Luna wire selection (#1482)", () => {
  test("uses Responses from every inbound surface", () => {
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("opencode-go", MODEL, opencodeGo(), inbound).adapter)
        .toBe("openai-responses");
    }
  });

  test("an explicit Chat override wins from every inbound surface", () => {
    const provider = opencodeGo({ modelAdapters: { [MODEL]: "openai-chat" } });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("opencode-go", MODEL, provider, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("other OpenCode Go models keep their existing wire", () => {
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("opencode-go", "glm-5.2", opencodeGo(), inbound).adapter)
        .toBe("openai-chat");
    }
  });
});

describe("OpenCode Go Luna Responses route (#1482)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("handleResponses sends Luna to the documented /responses endpoint", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json({
        id: "resp_opencode_go_luna",
        object: "response",
        status: "completed",
        output: [],
      });
    }) as typeof fetch;

    const config = {
      providers: { "opencode-go": opencodeGo() },
    } as unknown as OcxConfig;
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `opencode-go/${MODEL}`, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire: "responses" },
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/responses");
    // The endpoint fix does not silently impose the separate bounded-JSON policy.
    expect(requests[0]?.body.stream).toBe(true);
  });
});
