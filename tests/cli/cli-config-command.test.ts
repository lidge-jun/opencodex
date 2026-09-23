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
        proxy: "direct",
        modelCosts: {
          "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
          "sk-abcdef1234567890": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
        },
      },
      nocreds: {
        adapter: "openai-chat",
        baseUrl: "https://nocreds.example",
        proxy: "http://127.0.0.1:7890",
      },
    },
    defaultProvider: "openai",
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
  return dir;
}

describe("ocx config display redaction", () => {
  test.each([
    "providers.openai.proxy ",
    "providers.openai.proxy.",
    "providers..openai. proxy .",
  ])("normalized proxy path %s keeps get and set output masked", (path) => {
    const dir = freshConfig();
    try {
      const get = runCli(["config", "get", path, "--json"], { OPENCODEX_HOME: dir });
      expect(get.status).toBe(0);
      expect(JSON.parse(get.stdout)).toBe("http://egress.test:3128/");
      expect(get.stdout + get.stderr).not.toContain("route_user");
      expect(get.stdout + get.stderr).not.toContain("route_password");

      const set = runCli([
        "config", "set", path,
        "http://next_user:next_password@egress.test:8080", "--json",
      ], { OPENCODEX_HOME: dir });
      expect(set.status).toBe(0);
      expect(JSON.parse(set.stdout).value).toBe("http://egress.test:8080/");
      expect(set.stdout + set.stderr).not.toContain("next_user");
      expect(set.stdout + set.stderr).not.toContain("next_password");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("provider proxy credentials stay masked in show, get, and set output", () => {
    const dir = freshConfig();
    const secret = "route_password";
    try {
      const show = runCli(["config", "show", "--json"], { OPENCODEX_HOME: dir });
      expect(show.status).toBe(0);
      expect(show.stdout).not.toContain(secret);
      const shown = JSON.parse(show.stdout).providers;
      // Credentialed URL: userinfo stripped, host/port kept for diagnostics.
      expect(shown.openai.proxy).toBe("http://egress.test:3128/");
      expect(show.stdout).not.toContain("route_user");
      // "direct" and credential-less URLs carry no secret and stay readable.
      expect(shown.blsc.proxy).toBe("direct");
      expect(shown.nocreds.proxy).toBe("http://127.0.0.1:7890");

      const get = runCli(["config", "get", "providers.openai.proxy"], { OPENCODEX_HOME: dir });
      expect(get.status).toBe(0);
      expect(get.stdout.trim()).toBe("http://egress.test:3128/");

      const getDirect = runCli(["config", "get", "providers.blsc.proxy"], { OPENCODEX_HOME: dir });
      expect(getDirect.status).toBe(0);
      expect(getDirect.stdout.trim()).toBe("direct");

      const set = runCli([
        "config", "set", "providers.openai.proxy",
        "http://next_user:next_password@egress.test:8080", "--json",
      ], { OPENCODEX_HOME: dir });
      expect(set.status).toBe(0);
      expect(set.stdout).not.toContain("next_password");
      expect(JSON.parse(set.stdout).value).toBe("http://egress.test:8080/");
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
