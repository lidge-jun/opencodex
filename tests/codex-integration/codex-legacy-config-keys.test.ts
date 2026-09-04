import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectLegacyCodexConfigKeyDiagnostics,
  formatLegacyCodexConfigKeyDiagnosticsForDoctor,
} from "../../src/codex/legacy-config-keys";

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
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    const warnings = result.diagnostics;
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
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.diagnostics).toHaveLength(0);
  });

  test("formats one doctor line per legacy key", () => {
    writeConfig('persistent_instructions = "Be brief."');
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    const lines = formatLegacyCodexConfigKeyDiagnosticsForDoctor(result);
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).toContain("persistent_instructions");
    expect(lines.at(0)).toContain("--strict-config");
  });

  test("does not flag a clean config", () => {
    writeConfig('model = "gpt-5.3"');
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.diagnostics).toHaveLength(0);
    expect(formatLegacyCodexConfigKeyDiagnosticsForDoctor(result).at(0)).toContain("  ok");
  });

  test("reports unavailable when the config path is not a regular file", () => {
    mkdirSync(configPath, { recursive: true });
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(result.status).toBe("unavailable");
    expect(formatLegacyCodexConfigKeyDiagnosticsForDoctor(result).at(0)).toContain("  --");
  });

  test("a table header with a trailing comment does not leak fields into root", () => {
    writeConfig('[model_messages] # message templates\npersistent_instructions = "x"');
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.diagnostics).toHaveLength(0);
  });

  test("ignores key-shaped and table-shaped text inside a basic multiline string", () => {
    writeConfig([
      'developer_instructions = """',
      "Example only:",
      'persistent_instructions = "not a config key"',
      "[model_messages]",
      'persistent_instructions = "also prose"',
      '"""',
      'model = "gpt-5.3"',
    ].join("\n"));
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.diagnostics).toHaveLength(0);
  });

  test("ignores key-shaped and table-shaped text inside a literal multiline string", () => {
    writeConfig([
      "developer_instructions = '''",
      "Example only:",
      "persistent_instructions = 'not a config key'",
      "[profiles.example]",
      "persistent_instructions = 'also prose'",
      "'''",
      'model = "gpt-5.3"',
    ].join("\n"));
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.diagnostics).toHaveLength(0);
  });

  test("does not treat triple-quote text inside ordinary one-line strings as multiline syntax", () => {
    for (const content of [
      `persistent_instructions = '"""'`,
      `persistent_instructions = "'''"`,
    ]) {
      writeConfig(content);
      const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
      expect(result.status).toBe("available");
      if (result.status !== "available") continue;
      expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["persistent_instructions"]);
    }
  });

  test("tracks a second multiline value opened on the first value's closing line", () => {
    writeConfig([
      "instruction_fragments = [",
      '  """first block',
      '  """, """second block',
      '  persistent_instructions = "still prose"',
      '  [model_messages]',
      '  """',
      "]",
    ].join("\n"));
    const result = collectLegacyCodexConfigKeyDiagnostics({ codexConfigPath: configPath });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.diagnostics).toHaveLength(0);
  });

  test("doctor formatting redacts user names in available and unavailable paths", () => {
    const available = formatLegacyCodexConfigKeyDiagnosticsForDoctor({
      status: "available",
      path: "/home/alice/.codex/config.toml",
      diagnostics: [{
        path: "/home/alice/.codex/config.toml",
        code: "persistent_instructions",
        detail: "top-level 'persistent_instructions' is invalid",
      }],
    });
    expect(available.join("\n")).toContain("/home/[USER]/.codex/config.toml");
    expect(available.join("\n")).not.toContain("alice");

    const unavailable = formatLegacyCodexConfigKeyDiagnosticsForDoctor({
      status: "unavailable",
      path: String.raw`C:\Users\Bob\secret-config\config.toml`,
      reason: "read_failed",
    });
    expect(unavailable.join("\n")).toContain(String.raw`C:\Users\[USER]\[REDACTED]\config.toml`);
    expect(unavailable.join("\n")).not.toContain("Bob");
    expect(unavailable.join("\n")).not.toContain("secret-config");
  });
});
