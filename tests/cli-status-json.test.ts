import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectListenTarget } from "../src/cli/status";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function runStatusJson(opencodexHome: string) {
  return spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: opencodexHome },
    encoding: "utf8",
  });
}

describe("CLI status JSON", () => {
  test("status --json prints valid read-only diagnostics without secrets", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-json-"));
    try {
      const configPath = join(opencodexHome, "config.json");
      writeFileSync(configPath, JSON.stringify({
        port: 9,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            apiKey: "sk-test-secret",
          },
        },
        defaultProvider: "openai",
        codexAutoStart: false,
      }), "utf8");

      const beforeFiles = readdirSync(opencodexHome).sort();
      const result = runStatusJson(opencodexHome);
      const afterFiles = readdirSync(opencodexHome).sort();

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(afterFiles).toEqual(beforeFiles);
      expect(existsSync(join(opencodexHome, "ocx.pid"))).toBe(false);

      const parsed = JSON.parse(result.stdout) as {
        schemaVersion?: unknown;
        proxy?: { running?: unknown; pid?: unknown; health?: { ok?: unknown; url?: unknown; message?: unknown } };
        dashboard?: { url?: unknown };
        listen?: { port?: unknown; source?: unknown };
        paths?: { config?: unknown; pid?: unknown; runtime?: unknown };
        runtime?: { source?: unknown };
        codexAutostart?: unknown;
        startup?: {
          status?: unknown;
          rebootSafe?: unknown;
          routingInjected?: unknown;
          serviceInstalled?: unknown;
          shimInstalled?: unknown;
          shimHealthy?: unknown;
          shimCoverage?: unknown;
          serviceSupported?: unknown;
          commands?: unknown;
        };
        defaultProvider?: unknown;
        config?: { source?: unknown; error?: unknown };
        service?: { summary?: unknown };
        codexShim?: { summary?: unknown };
        codexRuntime?: {
          path?: unknown;
          version?: unknown;
          source?: unknown;
          warning?: unknown;
          newerAvailable?: unknown;
          catalogClamp?: { active?: unknown; removedEfforts?: unknown; runtimeVersion?: unknown };
        };
      };

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.proxy?.running).toBe(false);
      expect(parsed.proxy?.pid).toBeNull();
      expect(parsed.proxy?.health?.ok).toBe(false);
      expect(parsed.proxy?.health?.url).toBe("http://127.0.0.1:9/healthz");
      expect(typeof parsed.proxy?.health?.message).toBe("string");
      expect(parsed.dashboard?.url).toBe("http://localhost:9/");
      expect(parsed.listen?.port).toBe(9);
      expect(parsed.listen?.source).toBe("config");
      expect(parsed.paths?.config).toBe(configPath);
      expect(parsed.paths?.pid).toBe(join(opencodexHome, "ocx.pid"));
      expect(typeof parsed.paths?.runtime).toBe("string");
      expect(typeof parsed.runtime?.source).toBe("string");
      expect(parsed.codexAutostart).toBe(false);
      expect(["native", "protected", "at-risk"]).toContain(parsed.startup?.status);
      expect(typeof parsed.startup?.rebootSafe).toBe("boolean");
      expect(typeof parsed.startup?.routingInjected).toBe("boolean");
      expect(typeof parsed.startup?.serviceInstalled).toBe("boolean");
      expect(typeof parsed.startup?.shimInstalled).toBe("boolean");
      expect(typeof parsed.startup?.shimHealthy).toBe("boolean");
      expect(["full", "cli-only", "none"]).toContain(parsed.startup?.shimCoverage);
      expect(typeof parsed.startup?.serviceSupported).toBe("boolean");
      expect(typeof parsed.startup?.commands).toBe("object");
      expect(parsed.defaultProvider).toBe("openai");
      expect(parsed.config?.source).toBe("file");
      expect(parsed.config?.error).toBeNull();
      expect(typeof parsed.service?.summary).toBe("string");
      expect(typeof parsed.codexShim?.summary).toBe("string");
      expect(typeof parsed.codexRuntime?.path).toBe("string");
      expect(typeof parsed.codexRuntime?.source).toBe("string");
      expect(parsed.codexRuntime?.version === null || typeof parsed.codexRuntime?.version === "string").toBe(true);
      expect(parsed.codexRuntime?.warning === null || typeof parsed.codexRuntime?.warning === "string").toBe(true);
      expect(
        parsed.codexRuntime?.newerAvailable === null
        || (typeof parsed.codexRuntime?.newerAvailable === "object" && parsed.codexRuntime?.newerAvailable !== null),
      ).toBe(true);
      expect(parsed.codexRuntime?.catalogClamp?.active).toBe(false);
      expect(Array.isArray(parsed.codexRuntime?.catalogClamp?.removedEfforts)).toBe(true);
      expect(parsed.codexRuntime?.catalogClamp?.runtimeVersion).toBeNull();

      const serialized = JSON.stringify(parsed).toLowerCase();
      for (const forbidden of ["apikey", "sk-test-secret", "token", "refreshtoken", "authorization", "email"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("status --json reports catalogClamp.runtimeVersion when clamp is active", async () => {
    const { chmodSync } = await import("node:fs");
    const { persistEffortClamp, resetCodexRuntimeResolveCacheForTests } = await import("../src/codex/runtime");
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-clamp-"));
    try {
      writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");
      const fakeCodex = process.platform === "win32"
        ? join(opencodexHome, "bin", "codex.cmd")
        : join(opencodexHome, "bin", "codex");
      mkdirSync(join(opencodexHome, "bin"), { recursive: true });
      if (process.platform === "win32") {
        writeFileSync(fakeCodex, "@echo off\r\necho codex-cli 0.133.0\r\n", "utf8");
      } else {
        writeFileSync(fakeCodex, "#!/bin/sh\necho 'codex-cli 0.133.0'\n", "utf8");
        chmodSync(fakeCodex, 0o755);
      }
      persistEffortClamp({
        runtimePath: fakeCodex,
        runtimeVersion: "0.133.0",
        removedEfforts: ["max", "ultra"],
        affectedModels: ["gpt-5.6-sol"],
      }, { configDir: opencodexHome });
      resetCodexRuntimeResolveCacheForTests();

      const result = spawnSync(process.execPath, [cliPath, "status", "--json"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENCODEX_HOME: opencodexHome,
          CODEX_CLI_PATH: fakeCodex,
          PATH: "",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        codexRuntime?: {
          version?: string | null;
          catalogClamp?: { active?: boolean; removedEfforts?: string[]; runtimeVersion?: string | null };
        };
      };
      expect(parsed.codexRuntime?.version).toBe("0.133.0");
      expect(parsed.codexRuntime?.catalogClamp).toEqual({
        active: true,
        removedEfforts: ["max", "ultra"],
        runtimeVersion: "0.133.0",
      });
    } finally {
      resetCodexRuntimeResolveCacheForTests();
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("status rejects unknown flags instead of silently printing human text", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-json-"));
    try {
      writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status", "--yaml"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: opencodexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: ocx status [--json]");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("status --json rejects additional flags", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-json-"));
    try {
      writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({
        port: 9,
        providers: {},
        defaultProvider: "openai",
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status", "--json", "--yaml"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: opencodexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: ocx status [--json]");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("status --json on malformed config remains read-only and secret-safe", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-json-"));
    try {
      const configPath = join(opencodexHome, "config.json");
      writeFileSync(configPath, '{ "apiKey": "sk-status-secret", invalid json', "utf8");
      const beforeFiles = readdirSync(opencodexHome).sort();

      const result = runStatusJson(opencodexHome);
      const afterFiles = readdirSync(opencodexHome).sort();

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(afterFiles).toEqual(beforeFiles);
      expect(afterFiles.some(name => name.startsWith("config.json.invalid-"))).toBe(false);

      const parsed = JSON.parse(result.stdout) as {
        config?: { source?: unknown; error?: unknown };
        paths?: { config?: unknown };
      };
      expect(parsed.paths?.config).toBe(configPath);
      expect(parsed.config?.source).toBe("fallback");
      expect(parsed.config?.error).toBe("invalid_json");

      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain("sk-status-secret");
      expect(serialized).not.toContain("apiKey");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("listen target prefers current runtime port metadata", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "0.0.0.0" },
      123,
      { pid: 123, port: 58195, hostname: "0.0.0.0" },
    );

    expect(target.source).toBe("runtime");
    expect(target.port).toBe(58195);
    expect(target.healthUrl).toBe("http://127.0.0.1:58195/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:58195/");
  });

  test("listen target brackets raw IPv6 hostnames in the health URL", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "::1" },
      123,
      { pid: 123, port: 58195, hostname: "::1" },
    );

    expect(target.healthUrl).toBe("http://[::1]:58195/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:58195/");
  });

  test("listen target ignores stale runtime port metadata", () => {
    const target = selectListenTarget(
      { port: 10100, hostname: "127.0.0.1" },
      123,
      { pid: 999, port: 58195 },
    );

    expect(target.source).toBe("config");
    expect(target.port).toBe(10100);
    expect(target.healthUrl).toBe("http://127.0.0.1:10100/healthz");
    expect(target.dashboardUrl).toBe("http://localhost:10100/");
  });
});
