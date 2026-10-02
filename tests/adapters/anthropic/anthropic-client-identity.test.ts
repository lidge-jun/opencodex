import { describe, expect, test } from "bun:test";
import { captureAnthropicClientIdentity, type AnthropicClientIdentity } from "../../../src/adapters/anthropic/client-identity";
import { buildAnthropicMessagesPassthroughRequest } from "../../../src/adapters/anthropic/passthrough";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { claudeCodeSessionId } from "../../../src/adapters/client-fingerprint";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const UA = "claude-cli/2.1.282 (external, cli)";
const observed = {
  "User-Agent": UA, "X-App": "cli", "X-Claude-Code-Session-Id": SESSION,
  "X-Stainless-Lang": "js", "X-Stainless-Runtime": "node",
  "X-Stainless-Package-Version": "9.9.9", "X-Stainless-Runtime-Version": "22.1.0",
  "X-Stainless-OS": "fixture-os", "X-Stainless-Arch": "fixture-arch",
  "X-Stainless-Retry-Count": "1", "X-Stainless-Timeout": "420",
  "x-client-request-id": OTHER,
};
const provider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "fixture-a-access" } as OcxProviderConfig;
const body = { messages: [{ role: "user", content: "fixture" }], max_tokens: 64 };
const build = (clientIdentity: AnthropicClientIdentity | undefined, overrides: Partial<OcxProviderConfig> = {}) =>
  buildAnthropicMessagesPassthroughRequest({ ...provider, ...overrides }, "m", body, undefined, { clientIdentity });

describe("observed Claude Code identity", () => {
  test("account switch and refresh change only serving auth, not genuine session headers", () => {
    const identity = captureAnthropicClientIdentity(new Headers(observed));
    expect(identity).toBeDefined();
    for (const apiKey of ["fixture-a-access", "fixture-b-access", "fixture-refreshed-access"]) {
      const built = build(identity, { apiKey });
      for (const [name, value] of Object.entries(observed)) expect(new Headers(built.headers).get(name)).toBe(value);
      expect(new Headers(built.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(built.body).not.toContain(SESSION);
    }
    expect(JSON.stringify(identity)).toBe("{}");
  });
  test("different client sessions remain distinct", () => {
    const a = captureAnthropicClientIdentity(new Headers(observed));
    const b = captureAnthropicClientIdentity(new Headers({ ...observed, "X-Claude-Code-Session-Id": OTHER }));
    expect(new Headers(build(a).headers).get("x-claude-code-session-id")).toBe(SESSION);
    expect(new Headers(build(b).headers).get("x-claude-code-session-id")).toBe(OTHER);
  });
  test("credential, proxy, unknown SDK and hop-by-hop headers gain no authority", () => {
    const identity = captureAnthropicClientIdentity(new Headers({ ...observed,
      Authorization: "Bearer fixture-caller", "x-api-key": "fixture-caller-key", "proxy-authorization": "fixture-proxy",
      "x-stainless-custom": "fixture-extra", "x-ocx-admin": "fixture-admin", host: "fixture.invalid",
      connection: "X-Stainless-OS", "anthropic-beta": "fixture-unlisted-beta",
    }));
    const built = new Headers(build(identity).headers);
    expect(built.get("authorization")).toBe("Bearer fixture-a-access");
    for (const name of ["x-api-key", "proxy-authorization", "x-stainless-custom", "x-ocx-admin", "host", "connection"]) expect(built.has(name)).toBe(false);
    expect(built.get("x-stainless-os")).not.toBe("fixture-os");
    expect(built.get("anthropic-beta")).not.toContain("fixture-unlisted-beta");
  });
  test("UA alone, non-CLI, malformed, oversized and duplicate required values fall back", () => {
    expect(captureAnthropicClientIdentity(new Headers({ "User-Agent": UA }))).toBeUndefined();
    for (const [name, value] of [["User-Agent", "third-party/1.0"], ["User-Agent", "claude-cli/2.1.282 (external, claude-desktop)"],
      ["User-Agent", "x".repeat(513)], ["X-App", "web"], ["X-Claude-Code-Session-Id", "fixture-not-uuid"], ["X-Stainless-Runtime", "python"]]) {
      expect(captureAnthropicClientIdentity(new Headers({ ...observed, [name!]: value! }))).toBeUndefined();
    }
    for (const name of ["User-Agent", "X-App", "X-Claude-Code-Session-Id", "X-Stainless-Runtime"]) {
      const headers = new Headers(observed);
      headers.append(name, headers.get(name)!);
      expect(captureAnthropicClientIdentity(headers)).toBeUndefined();
    }
    expect(captureAnthropicClientIdentity(new Headers({ ...observed, connection: "X-App" }))).toBeUndefined();
    expect(build(undefined).headers["X-Claude-Code-Session-Id"]).toBe(claudeCodeSessionId(provider.apiKey));
  });
  test("duplicate/oversized optional SDK fields are dropped and forged handles do nothing", () => {
    const headers = new Headers({ ...observed, "X-Stainless-Runtime-Version": "x".repeat(513) });
    headers.append("X-Stainless-Package-Version", "1.0.0");
    const built = build(captureAnthropicClientIdentity(headers));
    expect(built.headers["X-Stainless-Runtime-Version"]).not.toBe("x".repeat(513));
    expect(built.headers["X-Stainless-Package-Version"]).toBe("0.74.0");
    expect(build({} as AnthropicClientIdentity).headers["User-Agent"]).toBe("@anthropic-ai/sdk/0.74.0");
  });
  test("compatible destinations keep defaults; first-party keys retain real caller identity", () => {
    const identity = captureAnthropicClientIdentity(new Headers(observed));
    expect(build(identity, { authMode: "key", baseUrl: "https://anthropic.example" }).headers["User-Agent"]).toBe("@anthropic-ai/sdk/0.74.0");
    const key = new Headers(build(identity, { authMode: "key" }).headers);
    expect(key.get("user-agent")).toBe(UA);
    expect(key.get("x-api-key")).toBe(provider.apiKey!);
    expect(key.has("authorization")).toBe(false);
  });
  test("operator identity header spellings do not duplicate observed fields", () => {
    const built = build(captureAnthropicClientIdentity(new Headers(observed)), { headers: { "user-agent": "fixture-operator", "x-claude-code-session-id": OTHER } });
    expect(new Headers(built.headers).get("user-agent")).toBe("fixture-operator");
    expect(new Headers(built.headers).get("x-claude-code-session-id")).toBe(OTHER);
    expect(Object.keys(built.headers).filter(name => name.toLowerCase() === "user-agent")).toHaveLength(1);
    expect(Object.keys(built.headers).filter(name => name.toLowerCase() === "x-claude-code-session-id")).toHaveLength(1);
  });
  test("operator headers win case-insensitively while unconfigured identity fields survive", () => {
    const headers = { "USER-AGENT": "fixture-operator", "X-Stainless-Package-Version": "8.8.8", "x-app": "fixture-app" };
    const built = new Headers(build(captureAnthropicClientIdentity(new Headers(observed)), { headers }).headers);
    for (const [name, value] of Object.entries(headers)) expect(built.get(name)).toBe(value);
    expect(built.get("x-claude-code-session-id")).toBe(SESSION);
    expect(built.get("x-stainless-runtime-version")).toBe("22.1.0");
  });
  test("generated Responses adapter traffic keeps its existing compatibility fingerprint", async () => {
    const parsed = { modelId: "m", stream: false, options: {}, context: { messages: [{ role: "user", content: "fixture" }], systemPrompt: [] } } as unknown as OcxParsedRequest;
    const built = await createAnthropicAdapter(provider).buildRequest(parsed);
    expect(built.headers["User-Agent"]).toBe("@anthropic-ai/sdk/0.74.0");
    expect(built.headers["X-Claude-Code-Session-Id"]).toBe(claudeCodeSessionId(provider.apiKey));
  });
});
