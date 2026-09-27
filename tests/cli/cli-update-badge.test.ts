import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { skipsCodexShimAutoRestore } from "../../src/cli/codex-shim-autorestore";

describe("hidden package update badge command", () => {
  test("is exempt from CLI shim repair, including malformed arguments", () => {
    expect(skipsCodexShimAutoRestore("__update-badge", ["__update-badge"])).toBe(true);
    expect(skipsCodexShimAutoRestore("__update-badge", ["__update-badge", "unexpected"])).toBe(true);
  });

  test("prints one badge JSON document and leaves the cache and home unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-badge-read-"));
    const home = join(directory, "opencodex");
    const codexHome = join(directory, "codex");
    mkdirSync(home);
    mkdirSync(codexHome);
    const cachePath = join(home, "version.json");
    const cache = '{"latest_version":"99.0.0","last_checked_at":"2026-09-24T00:00:00.000Z","tag":"latest"}\n';
    writeFileSync(cachePath, cache);
    try {
      const env = { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome };
      const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "__update-badge"], {
        env, encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const lines = result.stdout.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      const badge = JSON.parse(lines[0]!) as Record<string, unknown>;
      for (const field of ["updateAvailable", "unknown", "canUpdate"]) {
        expect(typeof badge[field]).toBe("boolean");
      }
      expect(readFileSync(cachePath, "utf8")).toBe(cache);
      expect(existsSync(join(home, "admin-api-token"))).toBe(false);
      expect(existsSync(join(home, "service-state.json"))).toBe(false);
      expect(existsSync(join(codexHome, "config.toml"))).toBe(false);

      const malformed = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "__update-badge", "unexpected"], {
        env, encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024,
      });
      expect(malformed.status).toBe(64);
      expect(malformed.stdout).toBe("");
      expect(readFileSync(cachePath, "utf8")).toBe(cache);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
