import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("Codex CLI updater zero-effect boundary", () => {
  (process.platform === "win32" && process.arch === "x64" ? test : test.skip)(
    "published Node launcher attest observes explicit files without executing targets or changing state", () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-codex-attest-zero-effect-"));
      roots.push(root);
      const prefix = join(root, "explicit-prefix");
      const codexRoot = join(prefix, "node_modules", "@openai", "codex");
      const npmRoot = join(root, "tools", "node_modules", "npm");
      const home = join(root, "home");
      for (const path of [join(codexRoot, "bin"), join(npmRoot, "bin"), home]) mkdirSync(path, { recursive: true });
      const candidate = join(codexRoot, "bin", "codex.js");
      const npmCli = join(npmRoot, "bin", "npm-cli.js");
      const node = join(root, "tools", "node.exe");
      const candidateMarker = join(root, "candidate-executed.txt");
      const npmMarker = join(root, "npm-executed.txt");
      const selectedMarker = join(root, "selected-executed.txt");
      const selectedCandidate = join(root, "selected.cmd");
      const markedScript = (marker: string) =>
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); throw new Error("must not execute");`;
      writeFileSync(candidate, markedScript(candidateMarker));
      writeFileSync(npmCli, markedScript(npmMarker));
      writeFileSync(node, "synthetic Node bytes for identity observation only");
      writeFileSync(selectedCandidate, `@echo off\r\necho executed>"${selectedMarker}"\r\n`);
      writeFileSync(join(codexRoot, "package.json"), JSON.stringify({
        name: "@openai/codex", version: "1.2.3", bin: { codex: "bin/codex.js" },
      }));
      writeFileSync(join(npmRoot, "package.json"), JSON.stringify({
        name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" },
      }));
      const stateFiles = ["codex-shim.json", "codex-runtime.json", "config.json"].map(name => join(home, name));
      for (const path of stateFiles) writeFileSync(path, "{broken");
      const result = spawnSync("node", [
        repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "attest",
        "--candidate", candidate, "--npm-prefix", prefix, "--npm-cli", npmCli, "--node", node, "--json",
      ], {
        cwd: repoRoot(), encoding: "utf8", timeout: 15_000, windowsHide: true,
        env: {
          ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home, CODEX_CLI_PATH: selectedCandidate,
          npm_config_registry: "http://127.0.0.1:9", npm_config_offline: "true",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        candidateSource: "explicit-cli", status: "observed", reason: "identity_observed",
        installationIdentityObserved: true, packageVersion: "1.2.3", npmVersion: "11.0.0",
        selectionAttested: false, managed: false, applyAllowed: false,
        proof: "windows-handle-bound", toolchain: "observed-only",
      });
      expect(report.identityDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.stdout).not.toContain("ocx-codex-attest-zero-effect-");
      for (const path of stateFiles) expect(readFileSync(path, "utf8")).toBe("{broken");
      for (const marker of [candidateMarker, npmMarker, selectedMarker]) expect(existsSync(marker)).toBe(false);
    },
  );

  (process.platform === "win32" && process.arch === "x64" ? test : test.skip)(
    "bare attest identifies the configured candidate through the proof-bound snapshot, without explicit paths",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-codex-attest-selected-"));
      roots.push(root);
      const prefix = join(root, "npm");
      const codexRoot = join(prefix, "node_modules", "@openai", "codex");
      const tools = join(root, "tools");
      const npmRoot = join(tools, "node_modules", "npm");
      const home = join(root, "home");
      for (const path of [join(codexRoot, "bin"), join(npmRoot, "bin"), home]) mkdirSync(path, { recursive: true });
      writeFileSync(join(prefix, "codex.cmd"), [
        "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL",
        "CALL :find_dp0", "", 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      ].join("\r\n") + "\r\n");
      writeFileSync(join(codexRoot, "package.json"), JSON.stringify({
        name: "@openai/codex", version: "1.2.3", bin: { codex: "bin/codex.js" },
      }));
      writeFileSync(join(codexRoot, "bin", "codex.js"), 'throw new Error("candidate must never execute");');
      writeFileSync(join(npmRoot, "package.json"), JSON.stringify({
        name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" },
      }));
      writeFileSync(join(npmRoot, "bin", "npm-cli.js"), 'throw new Error("npm must never execute");');
      writeFileSync(join(tools, "node.exe"), "synthetic Node bytes for identity observation only");
      // The child PATH puts the synthetic toolchain first; the real Node running the
      // launcher is resolved absolutely so spawn never picks up the fake node.exe.
      const nodeBin = (process.env.PATH ?? "").split(";").map(dir => join(dir, "node.exe")).find(existsSync);
      expect(nodeBin).toBeTruthy();
      const result = spawnSync(nodeBin!, [
        repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "attest", "--json",
      ], {
        cwd: repoRoot(), encoding: "utf8", timeout: 15_000, windowsHide: true,
        env: {
          ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home,
          CODEX_CLI_PATH: join(prefix, "codex.cmd"),
          PATH: tools + ";" + (process.env.PATH ?? ""),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        candidateSource: "selected", status: "observed", reason: "identity_observed",
        installationIdentityObserved: true, packageVersion: "1.2.3", npmVersion: "11.0.0",
        selectionAttested: false, managed: false, applyAllowed: false,
        proof: "windows-handle-bound", toolchain: "observed-only",
      });
      expect(report.identityDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.stdout).not.toContain("ocx-codex-attest-selected-");
    },
  );

  test("direct Bun execution of the Node launcher fails before updater inspection", () => {
    const result = spawnSync(process.execPath, [
      repoPath("bin", "ocx.mjs"),
      "system", "codex-cli-update", "check", "--json",
    ], {
      cwd: repoRoot(), encoding: "utf8", timeout: 15_000,
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
    const result = spawnSync("node", [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "check", "--json"], {
      cwd: repoRoot(),
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
      repoPath("bin", "ocx.mjs"),
      "--ocx-internal-launch-proof=bad",
      "system", "codex-cli-update", "invalid",
    ], {
      cwd: repoRoot(), encoding: "utf8", timeout: 15_000,
      env: { ...process.env, OPENCODEX_HOME: home, CODEX_CLI_PATH: launcher }, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("codex-cli-update action must be check");
    expect(readFileSync(statePath)).toEqual(before);
    expect(existsSync(marker)).toBe(false);
  });
});
