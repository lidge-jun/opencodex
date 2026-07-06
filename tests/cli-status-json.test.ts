import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
        defaultProvider?: unknown;
        config?: { source?: unknown; error?: unknown };
        service?: { summary?: unknown };
        codexShim?: { summary?: unknown };
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
      expect(parsed.defaultProvider).toBe("openai");
      expect(parsed.config?.source).toBe("file");
      expect(parsed.config?.error).toBeNull();
      expect(typeof parsed.service?.summary).toBe("string");
      expect(typeof parsed.codexShim?.summary).toBe("string");

      const serialized = JSON.stringify(parsed).toLowerCase();
      for (const forbidden of ["apikey", "sk-test-secret", "token", "refreshtoken", "authorization", "email"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
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
