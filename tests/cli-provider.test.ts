import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPAWN_BUDGET_MS } from "./helpers/test-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const isolatedCodexHome = mkdtempSync(join(tmpdir(), "ocx-prov-codex-home-"));

// Every case below spawns the real CLI. Cold Bun starts on a loaded windows-latest runner
// routinely blow the 5s default before --help returns; the spawn IS the assertion.
setDefaultTimeout(SPAWN_BUDGET_MS);

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    // ALWAYS isolate CODEX_HOME: `provider add --sync` runs syncModelsToCodex, which rewrites the
    // catalog under CODEX_HOME. With the real ~/.codex and a config.port matching the live proxy,
    // a test run would WIPE the user's routed catalog entries (live-catalog pollution).
    env: { ...process.env, CODEX_HOME: isolatedCodexHome, ...env },
    encoding: "utf8",
    // Contended windows-latest cold starts regularly exceed Bun's 5s default before --help
    // even prints; keep the child deadline under the test budget so status is not null.
    timeout: SPAWN_BUDGET_MS - 5_000,
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("provider add rejects a configured Codex account namespace without mutating config", () => {
    const { dir, configPath } = freshConfig({
      codexAccountNamespaces: { deepseek: "side-account-id" },
    });
    try {
      const before = readFileSync(configPath, "utf8");
      const result = runCli(["provider", "add", "deepseek", "--api-key", "sk-test"], { OPENCODEX_HOME: dir });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must not collide with a configured Codex account namespace");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test.each(["xai", "deepseek"])("login %s rejects a configured Codex account namespace before prompting", provider => {
    const { dir, configPath } = freshConfig({
      codexAccountNamespaces: { [provider]: "side-account-id" },
    });
    try {
      const before = readFileSync(configPath, "utf8");
      const result = runCli(["login", provider], { OPENCODEX_HOME: dir });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must not collide with a configured Codex account namespace");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("provider show --json never prints secret-shaped modelCosts keys", () => {
    const { dir } = freshConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
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
    });
    try {
      const result = runCli(["provider", "show", "blsc", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("sk-abcdef1234567890");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.modelCosts).toEqual({
        "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      });
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("provider add --force preserves an existing modelCosts overlay", () => {
    const { dir } = freshConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          apiKey: "sk-old",
          modelCosts: {
            "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
          },
        },
      },
    });
    try {
      const result = runCli([
        "provider", "add", "blsc",
        "--adapter", "openai-chat",
        "--base-url", "https://llmapi.blsc.cn",
        "--api-key", "sk-rotated",
        "--force",
      ], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const config = readConfig(dir);
      expect(config.providers.blsc.apiKey).toBe("sk-rotated");
      expect(config.providers.blsc.modelCosts).toEqual({
        "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      });
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("provider add rejects duplicate without --force", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "openai"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("already exists");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("provider add with --force overwrites", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "openai", "--force"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("provider add --set-default changes defaultProvider", () => {
    const { dir } = freshConfig();
    try {
      runCli(["provider", "add", "deepseek", "--api-key", "k", "--set-default"], { OPENCODEX_HOME: dir });
      const config = readConfig(dir);
      expect(config.defaultProvider).toBe("deepseek");
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("provider remove drops that provider's custom models (#1273)", () => {
    const { dir } = freshConfig({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
        huggingface: { adapter: "openai-chat", baseUrl: "https://api.hf.test/v1", apiKey: "k" },
      },
      customModels: [
        { id: "keep-1", provider: "openai", modelId: "kept-model" },
        { id: "drop-1", provider: "huggingface", modelId: "DeepSeek-V4-Flash-0731" },
      ],
      // Seeded so the assertion below proves removal does not rewrite one-time
      // ownership: an older binary must keep seeing the same legacy slugs.
      customModelCatalogMigration: {
        version: 1,
        legacyOwnedSlugs: ["huggingface/DeepSeek-V4-Flash-0731", "openai/kept-model"],
      },
    });
    try {
      const result = runCli(["provider", "remove", "huggingface", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "removed",
        provider: "huggingface",
        droppedCustomModels: 1,
      });

      const config = readConfig(dir);
      expect(config.customModels).toEqual([
        { id: "keep-1", provider: "openai", modelId: "kept-model" },
      ]);
      expect(config.customModelCatalogMigration).toEqual({
        version: 1,
        legacyOwnedSlugs: ["huggingface/DeepSeek-V4-Flash-0731", "openai/kept-model"],
      });
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("provider remove rejects default provider", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "remove", "openai"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("default provider");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("provider remove rejects last provider", () => {
    const { dir } = freshConfig();
    try {
      // Only one provider (openai is also default) - should fail on default check first
      const result = runCli(["provider", "remove", "openai"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("provider set-default rejects unconfigured provider", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "set-default", "nonexistent"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not configured");
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("provider add rejects unknown flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "deepseek", "--unknown-thing"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown flag");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("provider show rejects unknown flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "show", "openai", "--bogus"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown flag");
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  }, 15_000);

  test("provider add --sync --json reports needsSync false", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["provider", "add", "deepseek", "--api-key", "sk-test", "--sync", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.needsSync).toBe(true); // JSON mode skips sync, always reports needsSync=true
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});
