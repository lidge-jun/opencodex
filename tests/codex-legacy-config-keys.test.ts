import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectLegacyCodexConfigKeyDiagnostics,
  formatLegacyCodexConfigKeyDiagnosticsForDoctor,
} from "../src/codex/legacy-config-keys";

describe("legacy Codex config keys", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocx-legacy-config-keys-"));
    configPath = join(dir, "config.toml");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (content: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, content);
  };

  test("flags top-level persistent_instructions as an unsupported legacy key", () => {
    writeConfig('persistent_instructions = "Be brief."');
    const warnings = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(warnings).toHaveLength(1);
    expect(warnings.at(0)?.code).toBe("persistent_instructions");
    expect(warnings.at(0)?.path).toBe(configPath);
    expect(warnings.at(0)?.detail).toContain("persistent_instructions");
    expect(warnings.at(0)?.detail).toContain("--strict-config");
    expect(warnings.at(0)?.detail).toContain("AGENTS.md");
    expect(warnings.at(0)?.detail).not.toContain("developer_instructions");
  });

  test("ignores a table-scoped key with the same name", () => {
    writeConfig("[model_messages]\npersistent_instructions = \"x\"");
    const warnings = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(warnings).toHaveLength(0);
  });

  test("formats one doctor line per legacy key", () => {
    writeConfig('persistent_instructions = "Be brief."');
    const warnings = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    const lines = formatLegacyCodexConfigKeyDiagnosticsForDoctor(warnings);
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).toContain("persistent_instructions");
    expect(lines.at(0)).toContain("--strict-config");
  });

  test("does not flag a clean config", () => {
    writeConfig('model = "gpt-5.3"');
    const warnings = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(warnings).toHaveLength(0);
  });
});
