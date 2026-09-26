import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexShimReadinessWarnings } from "../../src/cli/codex-shim-readiness";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
// This case proves a real install followed by advisory collection, not startup latency.
const SHIM_INSTALL_CHILD_MS = process.platform === "win32" ? SPAWN_BUDGET_MS : undefined;
const SHIM_INSTALL_CLEANUP_MS = 5_000;
const SHIM_INSTALL_CASE_MS = SHIM_INSTALL_CHILD_MS === undefined
  ? 10_000
  : SHIM_INSTALL_CHILD_MS + SHIM_INSTALL_CLEANUP_MS;

const ready = {
  routingKind: "native" as const,
  externalProvider: null,
  processProxyEnvPresent: false,
  configuredProxyResolved: false,
};

describe("Codex shim install readiness", () => {
  test("a refused install exits unsuccessfully and preserves its reason", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-shim-refused-"));
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    mkdirSync(join(root, "codex-home"));
    mkdirSync(join(root, "ocx-home"));
    if (process.platform === "win32") writeFileSync(join(binDir, "codex.exe"), "fixture executable");
    try {
      const result = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: join(root, "codex-home"),
          OPENCODEX_HOME: join(root, "ocx-home"), PATH: process.platform === "win32"
            ? `${binDir}${delimiter}${join(process.env.SystemRoot ?? "C:\\Windows", "System32")}` : binDir },
        encoding: "utf8", timeout: SHIM_INSTALL_CHILD_MS,
      });
      expect(result.error).toBeUndefined();
      if (!result.stdout) throw new Error(result.stderr);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(process.platform === "win32"
        ? "Refusing to rename a real .exe" : "Could not find a codex executable");
    } finally { removeTreeWithRetry(root); }
  }, SHIM_INSTALL_CASE_MS);

  test("keeps a clean install green for native and managed routing", () => {
    expect(codexShimReadinessWarnings(ready)).toEqual([]);
    expect(codexShimReadinessWarnings({
      ...ready,
      routingKind: "opencodex-local",
    })).toEqual([]);
  });

  test("warns when an external provider is not routed through OpenCodex", () => {
    const warnings = codexShimReadinessWarnings({
      ...ready,
      routingKind: "unknown",
      externalProvider: "custom",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('external model_provider "custom"');
    expect(warnings[0]).toContain("live OpenCodex /v1 endpoint");
    expect(warnings[0]).toContain('wire_api = "responses"');

  });

  test("distinguishes user-owned local and remote routes", () => {
    const local = codexShimReadinessWarnings({
      ...ready,
      routingKind: "custom-local",
      externalProvider: "gateway",
    });
    expect(local).toHaveLength(1);
    expect(local[0]).toContain("user-owned local gateway");
    expect(local[0]).toContain("ocx doctor");

    const remote = codexShimReadinessWarnings({
      ...ready,
      routingKind: "custom-remote",
      externalProvider: "gateway",
    });
    expect(remote).toHaveLength(1);
    expect(remote[0]).toContain("remote gateway");
    expect(remote[0]).toContain("will not affect those requests");
  });

  test("warns about process-only proxy settings without exposing a URL", () => {
    const warnings = codexShimReadinessWarnings({
      ...ready,
      processProxyEnvPresent: true,
      configuredProxyResolved: false,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.proxy");
    expect(warnings[0]).toContain("may not inherit");
    expect(warnings[0]).not.toContain("://");

    expect(codexShimReadinessWarnings({
      ...ready,
      processProxyEnvPresent: true,
      configuredProxyResolved: true,
    })).toEqual([]);
  });

  test("the install command surfaces readiness warnings without leaking the proxy URL", () => {
    if (process.platform === "win32") return;

    const root = mkdtempSync(join(tmpdir(), "ocx-shim-readiness-"));
    const codexHome = join(root, "codex-home");
    const opencodexHome = join(root, "opencodex-home");
    const binDir = join(root, "bin");
    mkdirSync(codexHome);
    mkdirSync(opencodexHome);
    mkdirSync(binDir);
    try {
      writeFileSync(join(codexHome, "config.toml"), [
        'model_provider = "custom"',
        "",
        "[model_providers.custom]",
        'name = "OpenAI"',
        'wire_api = "responses"',
        "",
      ].join("\n"), "utf8");
      writeFileSync(join(opencodexHome, "config.json"), `${JSON.stringify({
        port: 10100,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
          },
        },
        defaultProvider: "openai",
      }, null, 2)}\n`, "utf8");
      const codex = join(binDir, "codex");
      writeFileSync(codex, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(codex, 0o755);

      const proxyUrl = "http://user:secret@127.0.0.1:7890";
      const result = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          OPENCODEX_HOME: opencodexHome,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toStartWith("⚠️  Codex autostart shim installed");
      expect(result.stderr).toContain('external model_provider "custom"');
      expect(result.stderr).toContain("config.proxy");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(proxyUrl);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("user:secret");
    } finally {
      removeTreeWithRetry(root);
    }
  }, 10_000);

  test("keeps install advisory when the Codex config cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-shim-unreadable-config-"));
    const codexHome = join(root, "codex-home");
    const opencodexHome = join(root, "opencodex-home");
    const binDir = join(root, "bin");
    mkdirSync(codexHome);
    mkdirSync(opencodexHome);
    mkdirSync(binDir);
    try {
      mkdirSync(join(codexHome, "config.toml"));
      const codex = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
      writeFileSync(
        codex,
        process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
        "utf8",
      );
      if (process.platform !== "win32") chmodSync(codex, 0o755);

      const result = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          OPENCODEX_HOME: opencodexHome,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: SHIM_INSTALL_CHILD_MS,
        killSignal: "SIGKILL",
      });

      if (result.error || result.signal !== null) {
        throw new Error(`Shim install fixture did not complete: error=${result.error?.name ?? "none"} signal=${result.signal ?? "none"}`);
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toStartWith("⚠️  Codex autostart shim installed");
      expect(result.stderr).toContain("Codex routing could not be verified");
      // A healthy no-op reports installed:false internally but must still exit successfully.
      const repeat = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
        encoding: "utf8", timeout: SHIM_INSTALL_CHILD_MS, killSignal: "SIGKILL",
      });
      expect(repeat.error).toBeUndefined();
      expect(repeat.status).toBe(0);
      expect(repeat.stdout).toContain("already installed");
      expect(repeat.stderr).toContain("Codex routing could not be verified");
      // Keep the marker and backing file, but break the launch-time ensure contract.
      writeFileSync(codex, readFileSync(codex, "utf8").replaceAll("ensure", "broken"));
      const damaged = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
        encoding: "utf8", timeout: SHIM_INSTALL_CHILD_MS, killSignal: "SIGKILL",
      });
      expect(damaged.error).toBeUndefined();
      expect(damaged.status).toBe(1);
      expect(damaged.stderr).toContain("unhealthy");
    } finally {
      removeTreeWithRetry(root);
    }
  }, SHIM_INSTALL_CASE_MS * 3);
});
