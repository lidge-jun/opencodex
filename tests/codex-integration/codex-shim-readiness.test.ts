import { isolateCodexShimEnvironment, withInstalledShim } from "../helpers/codex-shim-install-fixture";
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
import { diagnoseCodexShim } from "../../src/codex/shim-diagnostics";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

isolateCodexShimEnvironment();

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
        ? "Refusing to rename a real .exe" : "Native Codex launcher not found");
    } finally { removeTreeWithRetry(root); }
  }, SHIM_INSTALL_CASE_MS);

  test("a runnable inactive install succeeds with activation guidance and becomes green on PATH", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ home, binDir, launchers }) => {
      const nativeBefore = readFileSync(launchers[0]);
      const env = { ...process.env, PATH: binDir, OPENCODEX_HOME: home };
      const inactive = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], { env, encoding: "utf8" });
      expect(inactive.status).toBe(0);
      expect(inactive.stdout).toStartWith("⚠️");
      expect(inactive.stdout).not.toContain("✅");
      expect(inactive.stderr).toContain("codex-shell-env.sh");
      const active = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], {
        env: { ...env, PATH: `${join(home, "bin")}:${binDir}` }, encoding: "utf8",
      });
      expect(active.status).toBe(0);
      expect(active.stdout).toStartWith("✅");
      expect(readFileSync(launchers[0])).toEqual(nativeBefore);
    });
  }, 20_000);

  test("refuses a foreign private launcher even when a previous overlay was runnable", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ home, wrappers, launchers, statePath }) => {
      const stateBefore = readFileSync(statePath);
      const nativeBefore = readFileSync(launchers[0]);
      const foreign = "#!/bin/sh\n# foreign launcher\nexit 0\n";
      writeFileSync(wrappers[0], foreign);
      const result = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], {
        env: { ...process.env, OPENCODEX_HOME: home }, encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("installation was refused");
      expect(result.stdout).not.toContain("✅");
      expect(readFileSync(wrappers[0], "utf8")).toBe(foreign);
      expect(readFileSync(launchers[0])).toEqual(nativeBefore);
      expect(readFileSync(statePath)).toEqual(stateBefore);
    });
  }, 20_000);

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
      // A base-url-less provider table is the Codex app's own routing placeholder, not an
      // external gateway, so the readiness verdict falls to the routing kind ("unknown"
      // here) rather than an external-owner label. A REAL external provider must carry a
      // base_url to count.
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
      expect(result.stdout).toStartWith(process.platform === "win32" ? "⚠️  Codex autostart shim installed" : "⚠️  Codex PATH shim installed");
      expect(result.stderr).toContain("Codex routing could not be verified");
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
      expect(result.stdout).toStartWith(process.platform === "win32" ? "⚠️  Codex autostart shim installed" : "⚠️  Codex PATH shim installed");
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
      const wrapper = process.platform === "win32" ? codex : join(opencodexHome, "bin", "codex");
      writeFileSync(wrapper, readFileSync(wrapper, "utf8").replaceAll("ensure", "broken"));
      const diagnosis = spawnSync(process.execPath, [cliPath, "codex-shim", "status"], {
        env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome, PATH: binDir },
        encoding: "utf8",
      });
      expect(diagnosis.stdout).toContain("unhealthy");
      const damaged = spawnSync(process.execPath, [cliPath, "codex-shim", "install"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: opencodexHome,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
        encoding: "utf8", timeout: SHIM_INSTALL_CHILD_MS, killSignal: "SIGKILL",
      });
      expect(damaged.error).toBeUndefined();
      expect(damaged.status).toBe(process.platform === "win32" ? 1 : 0);
      if (process.platform === "win32") expect(damaged.stderr).toContain("unhealthy");
      else expect(readFileSync(wrapper, "utf8")).toContain("ensure");
    } finally {
      removeTreeWithRetry(root);
    }
  }, SHIM_INSTALL_CASE_MS * 3);
});

describe("in-place Windows shim status verdict", () => {
  test("a damaged in-place wrapper says unhealthy instead of only 'shim present'", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-shim-inplace-verdict-"));
    const previous = process.env.OPENCODEX_HOME;
    try {
      const home = join(root, "ocx"); const bin = join(root, "bin"); mkdirSync(home); mkdirSync(bin);
      const wrapperPath = join(bin, "codex.cmd"); const backupPath = join(bin, "codex.opencodex-real.cmd");
      writeFileSync(backupPath, "@echo off\r\n");
      // Legacy in-place record, as Windows installs write it; readable on every host.
      writeFileSync(join(home, "codex-shim.json"), JSON.stringify({ platform: "win32", wrapperPath, originalPath: wrapperPath, backupPath }));
      process.env.OPENCODEX_HOME = home;
      const body = `@echo off\r\nrem opencodex codex autostart shim${"\r\nrem padding".repeat(20)}\r\n`;
      writeFileSync(wrapperPath, `${body}ocx codex-shim ensure\r\n`);
      expect(diagnoseCodexShim()).toMatchObject({ installed: true, healthy: true });
      expect(diagnoseCodexShim().summary).not.toContain("unhealthy");
      writeFileSync(wrapperPath, `${body}ocx codex-shim broken\r\n`);
      const damaged = diagnoseCodexShim();
      expect(damaged).toMatchObject({ installed: true, healthy: false });
      expect(damaged.summary).toContain("wrapper shim present");
      expect(damaged.summary).toContain("Codex autostart shim is unhealthy. Run ocx codex-shim install to repair it.");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(root);
    }
  });
});
