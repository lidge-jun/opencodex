import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("Codex CLI updater zero-effect boundary", () => {
  test("direct Bun execution of the Node launcher fails before updater inspection", () => {
    const result = spawnSync(process.execPath, [
      join(import.meta.dir, "..", "bin", "ocx.mjs"),
      "system", "codex-cli-update", "check", "--json",
    ], {
      cwd: join(import.meta.dir, ".."), encoding: "utf8", timeout: 15_000,
      env: { ...process.env }, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use the published Node launcher");
  });

  test("published Node launcher check neither executes the candidate launcher nor rewrites invalid state", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-codex-check-zero-effect-"));
    roots.push(root);
    const launcher = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
    const marker = join(root, "executed.txt");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(launcher, process.platform === "win32"
      ? `@echo off\r\necho executed>${marker}\r\n`
      : `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, "utf8");
    if (process.platform !== "win32") chmodSync(launcher, 0o755);
    const statePath = join(home, "codex-shim.json");
    writeFileSync(statePath, "{broken", "utf8");
    const before = readFileSync(statePath);
    const result = spawnSync("node", [join(import.meta.dir, "..", "bin", "ocx.mjs"), "system", "codex-cli-update", "check", "--json"], {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, OPENCODEX_HOME: home, CODEX_CLI_PATH: launcher },
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report.managed).toBe(false);
    expect(typeof report.reason).toBe("string");
    expect(report.candidateAvailable).toBe(true);
    expect(report.candidateSource).toBe("environment");
    expect(report.selectionAttested).toBe(false);
    for (const stale of ["selected", "selectedVersion", "selectionSource", "selectionEvidence"]) {
      expect(stale in report).toBe(false);
    }
    expect(readFileSync(statePath)).toEqual(before);
    expect(existsSync(marker)).toBe(false);
  });

  test("published Node launcher rejects malformed updater input before any repair or candidate command", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-codex-invalid-zero-effect-"));
    roots.push(root);
    const launcher = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
    const marker = join(root, "executed.txt");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(launcher, process.platform === "win32"
      ? `@echo off\r\necho executed>${marker}\r\n`
      : `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, "utf8");
    if (process.platform !== "win32") chmodSync(launcher, 0o755);
    const statePath = join(home, "codex-shim.json");
    writeFileSync(statePath, "{broken", "utf8");
    const before = readFileSync(statePath);
    const result = spawnSync("node", [
      join(import.meta.dir, "..", "bin", "ocx.mjs"),
      "--ocx-internal-launch-proof=bad",
      "system", "codex-cli-update", "invalid",
    ], {
      cwd: join(import.meta.dir, ".."), encoding: "utf8", timeout: 15_000,
      env: { ...process.env, OPENCODEX_HOME: home, CODEX_CLI_PATH: launcher }, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("codex-cli-update action must be check");
    expect(readFileSync(statePath)).toEqual(before);
    expect(existsSync(marker)).toBe(false);
  });
});
