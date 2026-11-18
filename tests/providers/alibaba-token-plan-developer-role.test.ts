import { describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat/passthrough";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { routedProviderConfig } from "../../src/providers/routed-config";
import type { OcxProviderConfig } from "../../src/types";

// DashScope compatible-mode answers `400 developer is not one of ['system','assistant','user','tool','function']`
// (#5664, #8864). The native /v1/chat/completions passthrough folds the role only on an explicit record,
// so the registry records it for both Token Plan presets, as it does for moonshot (#7584).
const DASHSCOPE_INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

function saved(id: string, baseUrl = getProviderRegistryEntry(id)!.baseUrl): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl, authMode: "key", apiKey: "test-key" };
}

function upstreamRoles(provider: OcxProviderConfig): string[] {
  const body = JSON.parse(buildOpenAIChatPassthroughRequest(provider, {
    messages: [{ role: "developer", content: "be terse" }, { role: "user", content: "hi" }],
  }, "qwen3.8-max", false).body as string) as { messages: Array<{ role: string }> };
  return body.messages.map(message => message.role);
}

describe.each(["alibaba-token-plan", "alibaba-token-plan-intl"])("%s developer role", id => {
  test("a fresh seed records the fold", () => {
    expect(providerConfigSeed(getProviderRegistryEntry(id)!).foldDeveloperRoleToSystem).toBe(true);
  });

  test("a config saved before the record is resolved with the fold", () => {
    expect(routedProviderConfig(id, saved(id)).foldDeveloperRoleToSystem).toBe(true);
  });

  test("an explicit user value still wins", () => {
    const resolved = routedProviderConfig(id, { ...saved(id), foldDeveloperRoleToSystem: false });
    expect(resolved.foldDeveloperRoleToSystem).toBe(false);
    expect(upstreamRoles(resolved)).toEqual(["developer", "user"]);
  });

  test("the native passthrough sends system instead of developer", () => {
    expect(upstreamRoles(routedProviderConfig(id, saved(id)))).toEqual(["system", "user"]);
  });
});

describe("alibaba-token-plan-intl with the DashScope compatible-mode base URL (#8864)", () => {
  test("an overridden base URL keeps the fold on the native passthrough", () => {
    const resolved = routedProviderConfig("alibaba-token-plan-intl", saved("alibaba-token-plan-intl", DASHSCOPE_INTL));
    expect(resolved.baseUrl).toBe(DASHSCOPE_INTL);
    expect(upstreamRoles(resolved)).toEqual(["system", "user"]);
  });
});
