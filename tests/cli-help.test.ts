import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");

describe("CLI subcommand help", () => {
  test("restore --help prints usage without mutating Codex config", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-help-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const before = [
        'model_provider = "opencodex"',
        "",
        "[model_providers.opencodex]",
        'base_url = "http://localhost:10100/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n");
      writeFileSync(configPath, before, "utf8");

      const result = spawnSync(process.execPath, [cliPath, "restore", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: ocx restore");
      expect(result.stdout).not.toContain("Plain `codex` now runs natively");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("recover-history --help prints usage without opening history database", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-help-"));
    try {
      const statePath = join(codexHome, "state_5.sqlite");

      const result = spawnSync(process.execPath, [cliPath, "recover-history", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: ocx recover-history --legacy-openai");
      expect(result.stdout).toContain("Explicitly recover pre-backup syncResumeHistory rows.");
      expect(result.stdout).not.toContain("Recovered");
      expect(result.stderr).toBe("");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
