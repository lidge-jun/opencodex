import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10000,
  });
}

describe("ocx restart", () => {
  test("restart --help prints usage", () => {
    const result = runCli(["restart", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ocx restart");
  });

  test("help restart shows restart help entry", () => {
    const result = runCli(["help", "restart"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Stop the proxy and restart");
  });
});

describe("ocx health", () => {
  test("health --help prints usage", () => {
    const result = runCli(["health", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ocx health");
  });

  test("help health shows health help entry", () => {
    const result = runCli(["help", "health"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Check proxy health");
  });

  test("health exits 1 with no proxy running (isolated home)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-health-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      port: 19999,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      defaultProvider: "openai",
      codexAutoStart: false,
    }), "utf8");
    try {
      const result = runCli(["health"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("not healthy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("health --json exits 1 with valid JSON when no proxy", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-health-json-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      port: 19999,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      defaultProvider: "openai",
      codexAutoStart: false,
    }), "utf8");
    try {
      const result = runCli(["health", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.pid).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
