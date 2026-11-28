import { describe, expect, spyOn, test } from "bun:test";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import * as policyModule from "../../src/providers/resolved-model-policy";

// #8951: a large static catalogue rebuilt the whole provider policy for every model row.
describe("captured static catalog policy reuse", () => {
  test("a captured static catalog resolves provider policy once, not once per model row", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `org/model-${i}`);
    const captured = captureProviderGather("fixture-provider", {
      adapter: "openai-chat",
      baseUrl: "https://registry.invalid/v1",
      authMode: "key",
      liveModels: false,
      models: ids,
      modelContextWindows: Object.fromEntries(ids.map((id, i) => [id, 100_000 + i])),
    }, { kind: "observed", resolve: () => ({ apiKey: "fixture-token", observed: true }) });
    const resolveSpy = spyOn(policyModule, "resolveModelPolicy");
    try {
      const rows = ids.map(id => applyProviderConfigHints("fixture-provider", captured.provider, { provider: "fixture-provider", id }));
      expect(rows.map(row => row.contextWindow)).toEqual(ids.map((_, i) => 100_000 + i));
      expect(resolveSpy).not.toHaveBeenCalled();
    } finally {
      resolveSpy.mockRestore();
    }
  });
});
