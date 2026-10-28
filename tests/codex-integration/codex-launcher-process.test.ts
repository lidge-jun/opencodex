import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

describe("ocx codex real CLI handoff", () => {
  for (const arg of ["--help", "--version"]) test(`missing Codex ${arg} reports the install hint`, () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-codex-missing-"));
    try {
      const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "codex", arg], {
        cwd: home, env: { ...process.env, PATH: "", OPENCODEX_HOME: home },
        encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("npm install -g @openai/codex");
      expect(result.stderr).not.toContain("cannot verify Codex shim bypass");
    } finally { removeTreeWithRetry(home); }
  }, SPAWN_BUDGET_MS);

  for (const args of [["--help"], ["exec", "--help"], ["help"], ["--version"], ["resume", "two words"]]) {
    test(`forwards ${args.join(" ")} without loading a service token`, () => {
      const home = mkdtempSync(join(tmpdir(), "ocx-codex-process-"));
      try {
        const bin = join(home, "bin");
        const codexHome = join(home, "codex-home");
        const ocxHome = join(home, "ocx-home");
        for (const dir of [bin, codexHome, ocxHome]) mkdirSync(dir);
        const probe = join(home, "probe.mjs");
        writeFileSync(probe, 'console.log(JSON.stringify({args:process.argv.slice(2),token:process.env.OPENCODEX_API_AUTH_TOKEN??null}));process.exit(23);\n');
        const command = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
        const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
        writeFileSync(command, process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${probe}" %*\r\nexit /b %errorlevel%\r\n`
          : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(probe)} "$@"\n`);
        if (process.platform !== "win32") chmodSync(command, 0o755);
        const config = 'model = "native-fixture"\n';
        const configPath = join(codexHome, "config.toml");
        writeFileSync(configPath, config);
        writeFileSync(join(ocxHome, "service-api-token"), "ocx_fixture_service_token");
        const env: NodeJS.ProcessEnv = {
          ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, PATHEXT: ".EXE;.CMD",
        };
        delete env.OPENCODEX_API_AUTH_TOKEN;
        delete env.OPENCODEX_ADMIN_AUTH_TOKEN;
        delete env.OCX_API_TOKEN_FILE;
        const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), "codex", ...args], {
          cwd: repoRoot(), env, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, windowsHide: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(23);
        expect(JSON.parse(result.stdout.trim())).toEqual({ args, token: null });
        expect(result.stderr).not.toContain("ocx_fixture_service_token");
        expect(readFileSync(configPath, "utf8")).toBe(config);
      } finally {
        removeTreeWithRetry(home);
      }
    }, SPAWN_BUDGET_MS);
  }
});
