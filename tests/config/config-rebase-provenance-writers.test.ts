import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

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

const childWriterContracts: Record<string, string[]> = {
  "src/codex/account-auto-switch.ts": ["codexAccountAutoSwitchThresholds"],
};

function childDeletionFields(source: string): Set<string> {
  const fields = new Set<string>();
  // Keep string literals whole and discard comments, so examples are not mistaken
  // for calls. The contract checks a helper call with a config identifier and a
  // literal field name, independently of formatting and local identifier names.
  const tokens = (source.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g) ?? [])
    .filter(token => !token.startsWith("//") && !token.startsWith("/*"));
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "deleteConfigObjectChildKey" && tokens[index + 1] === "("
      && /^[\w$]+$/.test(tokens[index + 2] ?? "") && tokens[index + 3] === ","
      && tokens[index + 5] === ",") {
      const field = tokens[index + 4];
      if (field && /^(["'])[\w$]+\1$/.test(field)) fields.add(field.slice(1, -1));
    }
  }
  return fields;
}

test("every enumerated top-level deletion writer records config rebase provenance", () => {
  for (const [path, keys] of Object.entries(writerContracts)) {
    const source = readFileSync(repoPath(path), "utf8");
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

test("every enumerated child deletion writer records field-scoped rebase provenance", () => {
  for (const [path, keys] of Object.entries(childWriterContracts)) {
    const fields = childDeletionFields(readFileSync(repoPath(path), "utf8"));
    for (const key of keys) {
      expect(fields.has(key), `${path} must record child deletion provenance for ${key}`).toBe(true);
    }
  }
});

test("child writer contracts tolerate formatting and ignore comments, strings, and top-level deletions", () => {
  const source = `
    // deleteConfigObjectChildKey(config, "comment", id);
    const example = 'deleteConfigObjectChildKey(config, "string", id)';
    deleteConfigTopLevelKey(renamedConfig, "topLevel");
    deleteConfigObjectChildKey(
      renamedConfig,
      'codexAccountAutoSwitchThresholds',
      renamedAccountId,
    );
  `;
  expect([...childDeletionFields(source)]).toEqual(["codexAccountAutoSwitchThresholds"]);
});

test("live-config writers contain no untracked direct top-level deletion", () => {
  for (const path of Object.keys(writerContracts)) {
    const source = readFileSync(repoPath(path), "utf8");
    expect(source.match(/delete (?:config|cfg)\.[A-Za-z_$][A-Za-z0-9_$]*[;\n]/g) ?? [], path)
      .toEqual([]);
    expect(source.match(/delete config\[[^\]]+\]/g) ?? [], path).toEqual([]);
  }
});
