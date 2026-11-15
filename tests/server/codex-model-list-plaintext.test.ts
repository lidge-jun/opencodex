import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { buildCodexModelList } from "../../src/server/codex-model-list";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome | undefined;
afterEach(() => { home?.remove(); home = undefined; });

for (const mode of ["v2-plaintext", "v1"] as const) {
  test(`live catalog helper preserves ${mode} pins for native and routed rows`, () => {
    home = createTempHome("ocx-catalog-plaintext-");
    mkdirSync(home.codexHome, { recursive: true });
    const result = buildCodexModelList({
      config: {
        providers: {}, multiAgentMode: mode, keepNativeChatGptOnV1: true,
      } as OcxConfig,
      nativeSlugs: ["gpt-5.6-sol"],
      availableAccountNativeSlugs: [], accountNativeSlugs: [],
      accountNativeSlugsBySelector: new Map(),
      goOrdered: [{ id: "child", provider: "fixture", displayName: "Fixture child" }],
      exactComboSlugs: new Set(), accountSelectors: [],
      suppressedBareNativeSlugs: new Set(), disabledModels: new Set(),
    });
    for (const slug of ["gpt-5.6-sol", "fixture/child"]) {
      const row = result.models.find(entry => entry.slug === slug);
      expect(row).toBeDefined();
      expect(row!.multi_agent_version).toBe(mode === "v2-plaintext" ? "v2" : "v1");
    }
  });
}
