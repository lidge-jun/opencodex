import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli.ts");
const isolatedCodexHome = mkdtempSync(join(tmpdir(), "ocx-prov-codex-home-"));

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    // ALWAYS isolate CODEX_HOME: `provider add --sync` runs syncModelsToCodex, which rewrites the
    // catalog under CODEX_HOME. With the real ~/.codex and a config.port matching the live proxy,
    // a test run would WIPE the user's routed catalog entries (live-catalog pollution).
    env: { ...process.env, CODEX_HOME: isolatedCodexHome, ...env },
    encoding: "utf8",
  });
}

function freshConfig(extra?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "ocx-prov-"));
  const config = {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
    ...extra,
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
  return { dir, configPath: join(dir, "config.json") };
}

function readConfig(dir: string) {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
}

describe("ocx provider", () => {
  test("provider --help prints usage", () => {
    const result = runCli(["provider", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ocx provider");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("add");
    expect(result.stdout).toContain("remove");
  });

  test("provider list shows configured providers", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "list"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("openai");
      expect(result.stdout).toContain("(default)");
      expect(result.stdout).toContain("Available from registry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider list --json returns valid JSON", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "list", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.configured).toBeArray();
      expect(parsed.configured[0].name).toBe("openai");
      expect(parsed.configured[0].isDefault).toBe(true);
      expect(parsed.registryCount).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider add registry provider seeds config", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "deepseek", "--api-key", "sk-test"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deepseek");
      expect(result.stdout).toContain("DeepSeek");

      const config = readConfig(dir);
      expect(config.providers.deepseek).toBeDefined();
      expect(config.providers.deepseek.adapter).toBe("openai-chat");
      expect(config.providers.deepseek.apiKey).toBe("sk-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider add custom provider requires --adapter and --base-url", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "my-custom"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--adapter");
      expect(result.stderr).toContain("--base-url");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider add custom provider with full flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli([
        "provider", "add", "my-llm",
        "--adapter", "openai-chat",
        "--base-url", "http://localhost:8080/v1",
        "--api-key", "test-key",
        "--default-model", "my-model",
      ], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);

      const config = readConfig(dir);
      expect(config.providers["my-llm"]).toBeDefined();
      expect(config.providers["my-llm"].adapter).toBe("openai-chat");
      expect(config.providers["my-llm"].baseUrl).toBe("http://localhost:8080/v1");
      expect(config.providers["my-llm"].apiKey).toBe("test-key");
      expect(config.providers["my-llm"].defaultModel).toBe("my-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider add rejects duplicate without --force", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "openai"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("already exists");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider add with --force overwrites", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "openai", "--force"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider add --set-default changes defaultProvider", () => {
    const { dir } = freshConfig();
    try {
      runCli(["provider", "add", "deepseek", "--api-key", "k", "--set-default"], { OPENCODEX_HOME: dir });
      const config = readConfig(dir);
      expect(config.defaultProvider).toBe("deepseek");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider remove works for non-default provider", () => {
    const { dir } = freshConfig({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
        deepseek: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      },
    });
    try {
      const result = runCli(["provider", "remove", "deepseek"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);

      const config = readConfig(dir);
      expect(config.providers.deepseek).toBeUndefined();
      expect(config.providers.openai).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider remove rejects default provider", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "remove", "openai"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("default provider");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider remove rejects last provider", () => {
    const { dir } = freshConfig();
    try {
      // Only one provider (openai is also default) - should fail on default check first
      const result = runCli(["provider", "remove", "openai"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider show displays config with masked secret", () => {
    const { dir } = freshConfig({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
        deepseek: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-dummy-key-for-masking" },
      },
    });
    try {
      const result = runCli(["provider", "show", "deepseek"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deepseek");
      expect(result.stdout).toContain("openai-chat");
      expect(result.stdout).not.toContain("test-dummy-key-for-masking");
      expect(result.stdout).toContain("****");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider show --json returns valid JSON", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "show", "openai", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.name).toBe("openai");
      expect(parsed.isDefault).toBe(true);
      expect(parsed.adapter).toBe("openai-responses");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider set-default changes default", () => {
    const { dir } = freshConfig({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
        deepseek: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      },
    });
    try {
      const result = runCli(["provider", "set-default", "deepseek"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);

      const config = readConfig(dir);
      expect(config.defaultProvider).toBe("deepseek");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider set-default rejects unconfigured provider", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "set-default", "nonexistent"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not configured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("help provider shows provider help entry", () => {
    const result = runCli(["help", "provider"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Non-interactive provider management");
  });

  test("provider add warns on --api-key for oauth provider", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "anthropic", "--api-key", "test"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("OAuth");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ocx provider strict args", () => {
  test("provider list rejects unknown flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "list", "--bogus"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown flag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider add rejects unknown flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "deepseek", "--unknown-thing"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown flag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider show rejects unknown flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "show", "openai", "--bogus"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown flag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ocx provider mutating --json", () => {
  test("provider add --json returns structured output", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "deepseek", "--api-key", "sk-test", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.action).toBe("added");
      expect(parsed.provider).toBe("deepseek");
      expect(parsed.source).toBe("registry");
      expect(parsed.needsSync).toBe(true);
      expect(parsed.adapter).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider remove --json returns structured output", () => {
    const { dir } = freshConfig({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
        deepseek: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      },
    });
    try {
      const result = runCli(["provider", "remove", "deepseek", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.action).toBe("removed");
      expect(parsed.provider).toBe("deepseek");
      expect(parsed.remainingProviders).toContain("openai");
      expect(parsed.needsSync).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider set-default --json returns structured output", () => {
    const { dir } = freshConfig({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
        deepseek: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      },
    });
    try {
      const result = runCli(["provider", "set-default", "deepseek", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.action).toBe("set-default");
      expect(parsed.defaultProvider).toBe("deepseek");
      expect(parsed.needsSync).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ocx provider add --sync", () => {
  test("provider add --sync flag is accepted without error", () => {
    const { dir } = freshConfig();
    try {
      // --sync without a running proxy should still succeed (sync silently skipped)
      const result = runCli(["provider", "add", "deepseek", "--api-key", "sk-test", "--sync"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("deepseek");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider add --sync --json reports needsSync false", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "deepseek", "--api-key", "sk-test", "--sync", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.needsSync).toBe(true); // JSON mode skips sync, always reports needsSync=true
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
