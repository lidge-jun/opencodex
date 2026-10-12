import { describe, expect, test } from "bun:test";
import { captureAnthropicClientIdentity, hasObservedAnthropicClientIdentity, type AnthropicClientIdentity } from "../../../src/adapters/anthropic/client-identity";
import { shouldPreserveNativeClientPreamble } from "../../../src/adapters/anthropic/native-client-preamble";
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
  test("known CLI and SDK entrypoints carry the coherent observed bundle", () => {
    for (const entrypoint of ["cli", "sdk-cli", "sdk"]) {
      const userAgent = `claude-cli/2.1.288 (external, ${entrypoint})`;
      const identity = captureAnthropicClientIdentity(new Headers({ ...observed, "User-Agent": userAgent }));
      expect(hasObservedAnthropicClientIdentity(identity)).toBe(true);
      const built = new Headers(build(identity).headers);
      expect(built.get("user-agent")).toBe(userAgent);
      expect(built.get("x-claude-code-session-id")).toBe(SESSION);
      expect(built.get("authorization")).toBe("Bearer fixture-a-access");
    }
    expect(hasObservedAnthropicClientIdentity(undefined)).toBe(false);
    expect(hasObservedAnthropicClientIdentity({} as AnthropicClientIdentity)).toBe(false);
  });
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
  test("UA alone, unknown clients, malformed, oversized and duplicate required values fall back", () => {
    expect(captureAnthropicClientIdentity(new Headers({ "User-Agent": UA }))).toBeUndefined();
    for (const [name, value] of [["User-Agent", "third-party/1.0"], ["User-Agent", "claude-cli/2.1.288 (external, arbitrary-token)"], ["User-Agent", "claude-cli/2.1.282 (external, claude desktop)"],
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


describe("native Claude system preamble", () => {
  const nativeIdentities = [
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  ];
  const preamble = (identity = nativeIdentities[0]!) => [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.288.fixture; cc_entrypoint=sdk-cli; cch=fixture-observed-value;" },
    { type: "text", text: identity },
    { type: "text", text: "fixture stable prefix", cache_control: { type: "ephemeral" } },
  ];
  test("observed native Claude preambles preserve system block order and cache markers", () => {
    for (const identityText of nativeIdentities) {
      const system = preamble(identityText);
      const before = JSON.stringify(system);
      const clientIdentity = captureAnthropicClientIdentity(new Headers(observed));
      const built = buildAnthropicMessagesPassthroughRequest(provider, "m", { ...body, system }, undefined, { clientIdentity });
      expect(JSON.parse(built.body).system).toEqual(system);
      expect(JSON.stringify(system)).toBe(before);
    }
  });
  test("the pure helper recognizes all native variants without changing caller blocks", () => {
    const handle = captureAnthropicClientIdentity(new Headers(observed));
    for (const identityText of nativeIdentities) {
      const system = preamble(identityText);
      const before = JSON.stringify(system);
      expect(shouldPreserveNativeClientPreamble(system, handle)).toBe(true);
      expect(JSON.stringify(system)).toBe(before);
    }
  });
  test("missing, foreign and forged identities cannot select preamble preservation", () => {
    const system = preamble();
    for (const handle of [undefined, {} as AnthropicClientIdentity,
      captureAnthropicClientIdentity(new Headers({ ...observed, "User-Agent": "third-party/1.0" })),
      captureAnthropicClientIdentity(new Headers({ "User-Agent": UA }))]) {
      expect(shouldPreserveNativeClientPreamble(system, handle)).toBe(false);
    }
  });
  test("unrecognized, displaced and malformed prefix blocks keep generated SDK behavior", () => {
    const handle = captureAnthropicClientIdentity(new Headers(observed));
    const system = preamble();
    for (const candidate of [system.slice(1), [system[1], system[0]], preamble("fixture foreign identity"),
      [{ type: "text", text: "x-anthropic-billing-header: fixture" }, system[1]],
      [{ type: "text", text: system[0]!.text + "\nfixture" }, system[1]],
      [{ type: "text", text: system[0]!.text + "x".repeat(4096) }, system[1]],
      [{ type: "image", text: system[0]!.text }, system[1]], "fixture system"]) {
      expect(shouldPreserveNativeClientPreamble(candidate, handle)).toBe(false);
    }
  });

});

 test("native Desktop Code entrypoints preserve their observed body and required feature betas", () => {
  for (const entrypoint of ["claude-desktop", "claude-desktop-3p", "local-agent"]) {
    const headers = new Headers({ ...observed, "User-Agent": `claude-cli/2.1.288 (external, ${entrypoint})` });
    const clientIdentity = captureAnthropicClientIdentity(headers);
    expect(clientIdentity).toBeDefined();
    const system = [
      { type:"text", text:"x-anthropic-billing-header: cc_version=2.1.288.fixture; cc_entrypoint=claude-desktop; cch=fixture;" },
      { type:"text", text:"You are Claude Code, Anthropic's official CLI for Claude." },
      { type:"text", text:"fixture static", cache_control:{type:"ephemeral", ttl:"1h"} },
    ];
    const built = buildAnthropicMessagesPassthroughRequest(provider,"m",{...body,system},undefined,{clientIdentity,callerAnthropicBeta:"inline-tools-2026-09-15,thinking-display-updates-2026-08-18"});
    expect(built.wireBody.system).toBe(system);
    expect(new Headers(built.headers).get("user-agent")).toBe(headers.get("user-agent"));
    expect(new Headers(built.headers).get("x-claude-code-session-id")).toBe(SESSION);
    expect(built.headers["anthropic-beta"]).toContain("inline-tools-2026-09-15");
    expect(built.headers["anthropic-beta"]).toContain("thinking-display-updates-2026-08-18");
  }
  expect(captureAnthropicClientIdentity(new Headers({ ...observed, "User-Agent":"Mozilla/5.0" }))).toBeUndefined();
});

test("the builder excludes native feature betas for absent, forged and compatible identities", () => {
  const callerAnthropicBeta = "inline-tools-2026-09-15,thinking-display-updates-2026-08-18";
  for (const clientIdentity of [undefined, {} as AnthropicClientIdentity,
    captureAnthropicClientIdentity(new Headers({ ...observed, "User-Agent": "third-party/1.0" }))]) {
    const built = buildAnthropicMessagesPassthroughRequest(provider, "m", body, undefined, { clientIdentity, callerAnthropicBeta });
    expect(built.headers["anthropic-beta"]).not.toContain("inline-tools-2026-09-15");
    expect(built.headers["anthropic-beta"]).not.toContain("thinking-display-updates-2026-08-18");
    expect(built.droppedBetas).toBe(true);
  }
  const clientIdentity = captureAnthropicClientIdentity(new Headers(observed));
  const compatible = buildAnthropicMessagesPassthroughRequest({ ...provider, authMode: "key", baseUrl: "https://compatible.example" },
    "m", body, undefined, { clientIdentity, callerAnthropicBeta });
  expect(compatible.headers).not.toHaveProperty("anthropic-beta");
  expect(compatible.droppedBetas).toBe(true);
  const noHeader = buildAnthropicMessagesPassthroughRequest(provider, "m", body, undefined, { clientIdentity });
  expect(noHeader.headers["anthropic-beta"]).not.toContain("inline-tools-2026-09-15");
  expect(noHeader.droppedBetas).toBe(false);
});
