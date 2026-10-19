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

  test("first-party Anthropic gives TTL-less caller breakpoints 1h unless the caller pinned 5m", () => {
    const firstParty = provider({ baseUrl: "https://api.anthropic.com" });
    const ttls = (body: Record<string, unknown>): unknown[] => {
      const out: unknown[] = [];
      JSON.parse(JSON.stringify(body), (key, value) => {
        if (key === "cache_control") out.push(value.ttl);
        return value;
      });
      return out;
    };
    const source = {
      ...SOURCE,
      tools: [{
        name: "T",
        input_schema: { type: "object", properties: { cache_control: { type: "ephemeral" } } },
        input_examples: [{ cache_control: { type: "ephemeral" } }],
        cache_control: { type: "ephemeral" },
      }],
    };
    const upgraded = buildAnthropicMessagesPassthroughRequest(firstParty, "m", source).wireBody;
    expect((upgraded.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect((upgraded.tools as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // A cache_control key inside a tool schema is caller data, not a breakpoint.
    expect((upgraded.tools as Array<{ input_schema: unknown }>)[0]!.input_schema).toEqual(source.tools[0]!.input_schema);
    expect((upgraded.tools as Array<{ input_examples: unknown }>)[0]!.input_examples).toEqual(source.tools[0]!.input_examples);
    // The caller's object graph is copied on write, never mutated.
    expect(source.tools[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(SOURCE.system[0]!.cache_control).toEqual({ type: "ephemeral" });

    const pinned = { ...source, messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "5m" } }] }] };
    expect(ttls(buildAnthropicMessagesPassthroughRequest(firstParty, "m", pinned).wireBody)).toEqual(ttls(pinned));
    const short = { cacheRetention: "short" } as Parameters<typeof buildAnthropicMessagesPassthroughRequest>[3];
    expect(ttls(buildAnthropicMessagesPassthroughRequest(firstParty, "m", source, short).wireBody)).toEqual(ttls(source));
    // Compatible endpoints keep the caller's TTLs as sent.
    expect(ttls(buildAnthropicMessagesPassthroughRequest(provider(), "m", source).wireBody)).toEqual(ttls(source));
  });
});
