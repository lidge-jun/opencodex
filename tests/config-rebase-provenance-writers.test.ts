import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const writerContracts: Record<string, string[]> = {
  "src/server/management/agent-settings-routes.ts": [
    "clientIntegrations", "multiAgentMode", "keepNativeChatGptOnV1",
    "syncCodexSubagentDefaults", "injectionModel", "injectionEffort", "injectionPrompt",
    "subagentModelFallback", "subagentModelFallbackPollMs", "grokExcludedModels",
  ],
  "src/server/management/config-routes.ts": [
    "streamMode", "codexAutoStart", "appOwnedMemoryBudgetMb", "codexAccountNamespaces",
    "codexAccountPickerEnabled", "oauthOpenBrowser",
  ],
  "src/server/management/combo-routes.ts": ["combos"],
  "src/server/management/routing-profile-routes.ts": ["routingProfiles"],
  "src/providers/context-cap.ts": ["providerContextCaps"],
  "src/codex/account-priority.ts": ["codexAccountPriorities", "activeCodexAccountPinned"],
  "src/codex/account-pause.ts": ["pausedCodexAccountIds"],
  "src/codex/desired-state.ts": ["clientIntegrations"],
  "src/providers/provider-id-rewrite.ts": ["customModels"],
  "src/cli/v2.ts": ["multiAgentMode", "keepNativeChatGptOnV1"],
};

test("every enumerated top-level deletion writer records config rebase provenance", () => {
  for (const [path, keys] of Object.entries(writerContracts)) {
    const source = readFileSync(join(import.meta.dir, "..", path), "utf8");
    for (const key of keys) {
      const configCall = `deleteConfigTopLevelKey(config, "${key}")`;
      const cliCall = `deleteConfigTopLevelKey(cfg, "${key}")`;
      expect(source.includes(configCall) || source.includes(cliCall),
        `${path} must record deletion provenance for ${key}`).toBe(true);
    }
    if (path.endsWith("agent-settings-routes.ts")) {
      expect(source).toContain("deleteConfigTopLevelKey(config, key)");
    }
  }
});

test("live-config writers contain no untracked direct top-level deletion", () => {
  for (const path of Object.keys(writerContracts)) {
    const source = readFileSync(join(import.meta.dir, "..", path), "utf8");
    expect(source.match(/delete (?:config|cfg)\.[A-Za-z_$][A-Za-z0-9_$]*[;\n]/g) ?? [], path)
      .toEqual([]);
    expect(source.match(/delete config\[[^\]]+\]/g) ?? [], path).toEqual([]);
  }
});
