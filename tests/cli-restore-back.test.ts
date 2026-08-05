import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
const helpSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "help.ts"), "utf8");
const repoRoot = join(import.meta.dir, "..");

describe("ocx restore back", () => {
  test("restore/eject accept `back` to re-point codex at the RUNNING proxy only", () => {
    const restoreCase = cliSource.slice(cliSource.indexOf('case "restore":'), cliSource.indexOf('case "recover-history":'));

    // The reverse switch must be liveness-gated (never inject a dead port) and reuse the
    // same inject path as `ocx start` — no parallel injector.
    expect(restoreCase).toContain('if (args[1] === "back")');
    expect(restoreCase).toContain("await findLiveProxy()");
    expect(restoreCase).toContain("await syncModelsToCodex(live.port)");
    expect(restoreCase.indexOf("findLiveProxy()")).toBeLessThan(restoreCase.indexOf("syncModelsToCodex(live.port)"));
    expect(restoreCase).toContain("if (!synced.ok)");
    expect(restoreCase.indexOf("if (!synced.ok)")).toBeLessThan(restoreCase.indexOf("target.effectiveCodexHome"));
    expect(restoreCase).toContain("target.effectiveCodexHome");
    // The forward switch reports incomplete marker cleanup instead of claiming native success.
    expect(restoreCase).toContain("restoreNativeCodexAsync()");
    expect(restoreCase).toContain("process.exitCode = 1");
    expect(restoreCase).toContain("was not fully restored");
  });

  test("sync propagates injection refusal as a nonzero CLI result", () => {
    const syncCase = cliSource.slice(cliSource.indexOf('case "sync":'), cliSource.indexOf('case "v2":'));

    expect(syncCase).toContain("await syncModelsToCodex");
    expect(syncCase).toContain("if (!synced.ok)");
    expect(syncCase).toContain("process.exitCode = 1");
  });

  test("sync exits nonzero when managed-default cleanup is ambiguous", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-cli-sync-codex-"));
    const ocxHome = mkdtempSync(join(tmpdir(), "ocx-cli-sync-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), [
        "# Managed by opencodex: native subagent defaults table",
        "[agents]",
        "# Managed by opencodex: native subagent default",
        "",
        'default_subagent_model = "gpt-5.6-sol"',
        "",
      ].join("\n"), "utf8");
      writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
        providers: {},
        defaultProvider: "openai",
        checkForUpdates: false,
      }), "utf8");

      const result = spawnSync(process.execPath, ["run", "src/cli/index.ts", "sync"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CI: "1" },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Codex config injection refused");
      expect(result.stderr).toContain("Codex sync did not complete");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(ocxHome, { recursive: true, force: true });
    }
  });

  test("help documents both directions of the switch", () => {
    expect(helpSource).toContain("ocx restore [back]");
    expect(helpSource).toContain("ocx eject [back]");
    expect(helpSource).toContain("ocx restore back");
  });
});
