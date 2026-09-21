import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const isolatedCodexHome = mkdtempSync(join(tmpdir(), "ocx-config-codex-home-"));

setDefaultTimeout(SPAWN_BUDGET_MS);

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: isolatedCodexHome, ...env },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
}

function freshConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-config-"));
  const config = {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        proxy: "http://route_user:route_password@egress.test:3128",
      },
      blsc: {
        adapter: "openai-chat",
        baseUrl: "https://llmapi.blsc.cn",
        modelCosts: {
          "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
          "sk-abcdef1234567890": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
        },
      },
    },
    defaultProvider: "openai",
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
  return dir;
}

describe("ocx config display redaction", () => {
  test("provider proxy credentials stay masked in show, get, and set output", () => {
    const dir = freshConfig();
    const secret = "route_password";
    try {
      const show = runCli(["config", "show", "--json"], { OPENCODEX_HOME: dir });
      expect(show.status).toBe(0);
      expect(show.stdout).not.toContain(secret);
      expect(JSON.parse(show.stdout).providers.openai.proxy).toBe("********");

      const get = runCli(["config", "get", "providers.openai.proxy"], { OPENCODEX_HOME: dir });
      expect(get.status).toBe(0);
      expect(get.stdout.trim()).toBe("********");

      const set = runCli([
        "config", "set", "providers.openai.proxy",
        "http://next_user:next_password@egress.test:8080", "--json",
      ], { OPENCODEX_HOME: dir });
      expect(set.status).toBe(0);
      expect(set.stdout).not.toContain("next_password");
      expect(JSON.parse(set.stdout).value).toBe("********");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("config show --json never prints secret-shaped modelCosts keys", () => {
    const dir = freshConfig();
    try {
      const result = runCli(["config", "show", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("sk-abcdef1234567890");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.providers.blsc.modelCosts).toEqual({
        "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      });
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("config get providers.<name>.modelCosts --json drops secret-shaped keys", () => {
    const dir = freshConfig();
    try {
      const result = runCli(["config", "get", "providers.blsc.modelCosts", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("sk-abcdef1234567890");
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toEqual({
        "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      });
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});
