/**
 * The managed native Messages builder (src/adapters/anthropic/passthrough.ts, PF-08): the
 * allowlisted source body with the wire model, the adapter's own URL, pinned version and key
 * placement, and nothing taken from the caller.
 */
import { describe, expect, test } from "bun:test";
import { ANTHROPIC_API_VERSION, createAnthropicAdapter } from "../../../src/adapters/anthropic";
import {
  ANTHROPIC_MESSAGES_PASSTHROUGH_FIELDS,
  buildAnthropicMessagesPassthroughRequest,
} from "../../../src/adapters/anthropic/passthrough";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://anthropic.example/v1",
    authMode: "key",
    apiKey: "fixture-managed-key",
    ...overrides,
  } as OcxProviderConfig;
}

const SOURCE = {
  model: "client-selector",
  max_tokens: 64,
  top_k: 7,
  temperature: 0.2,
  stream: true,
  thinking: { type: "enabled", budget_tokens: 2048 },
  system: [{ type: "text", text: "fixture system", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
  metadata: { user_id: "fixture-user" },
  // Not on the allowlist: dropped rather than forwarded unchecked.
  context_management: { edits: [] },
  mcp_servers: [{ type: "url", url: "https://mcp.example" }],
  container: "fixture-container",
};

describe("buildAnthropicMessagesPassthroughRequest", () => {
  test("keeps exactly the allowlisted source fields and swaps in the wire model", () => {
    const built = buildAnthropicMessagesPassthroughRequest(provider(), "claude-wire", SOURCE);
    const expected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(SOURCE)) {
      if ((ANTHROPIC_MESSAGES_PASSTHROUGH_FIELDS as readonly string[]).includes(key)) expected[key] = value;
    }
    expected.model = "claude-wire";
    expect(JSON.parse(built.body)).toEqual(expected);
    expect(built.wireBody).toEqual(expected);
    expect(built.wireBody).toMatchObject({ top_k: 7, thinking: SOURCE.thinking, system: SOURCE.system });
    expect(built.wireBody).not.toHaveProperty("context_management");
    expect(built.wireBody).not.toHaveProperty("mcp_servers");
    expect(built.wireBody).not.toHaveProperty("container");
    // The source is not mutated.
    expect(SOURCE.model).toBe("client-selector");
  });

  test("uses the adapter's endpoint, version and key placement", async () => {
    const built = buildAnthropicMessagesPassthroughRequest(provider(), "claude-wire", SOURCE);
    expect(built.url).toBe("https://anthropic.example/v1/messages");
    expect(built.headers).toMatchObject({
      "anthropic-version": ANTHROPIC_API_VERSION,
      "x-api-key": "fixture-managed-key",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    });
    expect(built.headers).not.toHaveProperty("Authorization");

    const parsed = {
      modelId: "claude-wire",
      stream: true,
      context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
      options: {},
    } as unknown as OcxParsedRequest;
    const adapterRequest = await createAnthropicAdapter(provider())
      .buildRequest(parsed, { headers: new Headers(), translatorBudget: createTranslatorBudget() });
    expect(adapterRequest.url).toBe(built.url);
    const adapterHeaders = adapterRequest.headers as Record<string, string>;
    for (const name of ["anthropic-version", "x-api-key", "Accept", "User-Agent"]) {
      expect(built.headers[name]).toBe(adapterHeaders[name]);
    }
  });

  test("a bearer key transport and operator headers apply as in the adapter", () => {
    const built = buildAnthropicMessagesPassthroughRequest(
      provider({ apiKeyTransport: "bearer", headers: { "x-operator": "fixture" } } as Partial<OcxProviderConfig>),
      "claude-wire",
      { ...SOURCE, stream: false },
    );
    expect(built.headers.Authorization).toBe("Bearer fixture-managed-key");
    expect(built.headers).not.toHaveProperty("x-api-key");
    expect(built.headers["x-operator"]).toBe("fixture");
    expect(built.headers.Accept).toBe("application/json");
  });

  test("refuses what the adapter refuses and never carries an OAuth or forwarded credential", () => {
    expect(() => buildAnthropicMessagesPassthroughRequest(provider({ apiKey: "" }), "m", SOURCE))
      .toThrow("non-empty apiKey");
    expect(() => buildAnthropicMessagesPassthroughRequest(provider({ baseUrl: "https://{region}.example/v1" }), "m", SOURCE))
      .toThrow("unresolved {region}");
    expect(() => buildAnthropicMessagesPassthroughRequest(provider({ authMode: "oauth" }), "m", SOURCE)).toThrow();
    expect(() => buildAnthropicMessagesPassthroughRequest(provider({ authMode: "forward" }), "m", SOURCE)).toThrow();
  });
});
