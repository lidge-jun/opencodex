import { describe, expect, test } from "bun:test";
import { bindAnthropicAccountMetadata } from "../../../src/adapters/anthropic/account-metadata";
import { buildAnthropicMessagesPassthroughRequest } from "../../../src/adapters/anthropic/passthrough";
import type { OcxProviderConfig } from "../../../src/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const identity = { device_id: "fixture-device", session_id: "fixture-session", account_uuid: A };
const source = {
  metadata: { user_id: JSON.stringify(identity), extra: "fixture" },
  messages: [
    { role: "user", content: `account_uuid: ${A}` },
    { role: "assistant", content: [{ type: "tool_use", name: "fixture", id: "toolu_fixture", input: { account_uuid: A } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: { account_uuid: A } }] },
  ],
  tools: [{ name: "fixture", input_schema: { account_uuid: A } }],
};
const provider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "fixture-access" } as OcxProviderConfig;

describe("Anthropic serving-account metadata", () => {
  test("rewrites only JSON-string metadata and preserves device, session, text and tool payloads", () => {
    const before = JSON.stringify(source);
    const result = bindAnthropicAccountMetadata(source, B);
    expect(JSON.parse((result.metadata as typeof source.metadata).user_id)).toEqual({ ...identity, account_uuid: B });
    expect(result.metadata).not.toBe(source.metadata);
    expect(result.messages).toBe(source.messages);
    expect(result.tools).toBe(source.tools);
    expect(JSON.stringify(source)).toBe(before);
  });
  test("each A to B retry starts from the same immutable source", () => {
    const a = buildAnthropicMessagesPassthroughRequest(provider, "m", source, undefined, { providerAccountUuid: A });
    const b = buildAnthropicMessagesPassthroughRequest({ ...provider, apiKey: "fixture-b-access" }, "m", source, undefined, { providerAccountUuid: B });
    expect(a.headers.Authorization).toBe("Bearer fixture-access");
    expect(b.headers.Authorization).toBe("Bearer fixture-b-access");
    expect(JSON.parse((a.wireBody.metadata as typeof source.metadata).user_id).account_uuid).toBe(A);
    expect(JSON.parse((b.wireBody.metadata as typeof source.metadata).user_id).account_uuid).toBe(B);
    expect(JSON.parse(source.metadata.user_id).account_uuid).toBe(A);
  });
  test("absent, malformed, unsupported and oversized metadata stay unchanged", () => {
    for (const metadata of [undefined, null, [], { user_id: {} }, { user_id: "{" },
      { user_id: "fixture-legacy-unobserved" }, { user_id: "[]" },
      { user_id: JSON.stringify({ device_id: "fixture" }) },
      { user_id: JSON.stringify({ account_uuid: 42 }) },
      { user_id: JSON.stringify({ account_uuid: "not-a-uuid" }) },
      { user_id: JSON.stringify({ account_uuid: A, device_id: "x".repeat(4096) }) }]) {
      const body = { metadata };
      expect(bindAnthropicAccountMetadata(body, B)).toBe(body);
    }
  });
  test("unknown provider UUID and local slot ids are never used", () => {
    for (const uuid of [undefined, "", "anthropic:local-slot", "a".repeat(64)]) {
      expect(bindAnthropicAccountMetadata(source, uuid)).toBe(source);
    }
    expect(bindAnthropicAccountMetadata(source, A)).toBe(source);
  });
  test("a credential override cannot send metadata bound to another bearer", () => {
    for (const headers of [{ Authorization: "Bearer fixture-other" }, { authorization: "Bearer fixture-other" }, { "x-api-key": "fixture-other" }]) {
      expect(() => buildAnthropicMessagesPassthroughRequest({ ...provider, headers }, "m", source, undefined, { providerAccountUuid: B })).toThrow("serving credential was overridden");
    }
  });
  test("OAuth rejects provider credential overrides without a provider UUID", () => {
    for (const headers of [{ Authorization: "Bearer fixture-other" }, { authorization: "Bearer fixture-other" }, { "X-API-Key": "fixture-other" }]) {
      expect(() => buildAnthropicMessagesPassthroughRequest({ ...provider, headers }, "m", source)).toThrow("serving credential was overridden");
    }
    expect(buildAnthropicMessagesPassthroughRequest(provider, "m", source).headers.Authorization).toBe("Bearer fixture-access");
  });
  test("key-auth first-party and compatible hosts preserve caller metadata", () => {
    for (const baseUrl of ["https://api.anthropic.com", "https://anthropic.example"]) {
      const built = buildAnthropicMessagesPassthroughRequest({ ...provider, authMode: "key", baseUrl }, "m", source, undefined, { providerAccountUuid: B });
      expect(built.wireBody.metadata).toBe(source.metadata);
    }
    expect(() => buildAnthropicMessagesPassthroughRequest({ ...provider, baseUrl: "https://anthropic.example" }, "m", source, undefined, { providerAccountUuid: B })).toThrow();
  });
});
