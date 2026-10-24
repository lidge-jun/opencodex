import { describe, expect, test } from "bun:test";
import { applyExplicitChatDeveloperRole } from "../../src/adapters/openai-chat/developer-role";
import { providerConfigSeed } from "../../src/providers/derive";
import { MOONSHOT_INTL_BASE_URL } from "../../src/providers/base-url-choices";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { routedProviderConfig } from "../../src/providers/routed-config";
import type { OcxProviderConfig } from "../../src/types";

// api.moonshot.ai answers `400 Invalid request: role 'developer' is not allowed`. The native
// /v1/chat/completions passthrough only folds the role on an explicit record, so the registry
// records it for the moonshot preset.
describe("moonshot developer role", () => {
  const savedBeforeTheRecord: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: MOONSHOT_INTL_BASE_URL,
    authMode: "key",
  };

  test("a fresh moonshot seed records the fold", () => {
    expect(providerConfigSeed(getProviderRegistryEntry("moonshot")!).foldDeveloperRoleToSystem).toBe(true);
  });

  test("a config saved before the record is resolved with the fold", () => {
    expect(routedProviderConfig("moonshot", savedBeforeTheRecord).foldDeveloperRoleToSystem).toBe(true);
  });

  test("an explicit user value still wins", () => {
    const resolved = routedProviderConfig("moonshot", { ...savedBeforeTheRecord, foldDeveloperRoleToSystem: false });
    expect(resolved.foldDeveloperRoleToSystem).toBe(false);
  });

  test("the native passthrough sends system instead of developer", () => {
    const resolved = routedProviderConfig("moonshot", savedBeforeTheRecord);
    const messages = [
      { role: "developer", content: "be terse" },
      { role: "user", content: "hi" },
    ];
    expect(applyExplicitChatDeveloperRole(messages, resolved)).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });
});
