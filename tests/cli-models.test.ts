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
  });
}

function freshConfig(extra?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "ocx-models-"));
  const config = {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      test: {
        adapter: "openai-chat",
        baseUrl: "http://localhost:8080/v1",
        defaultModel: "test-model-1",
        models: ["test-model-1", "test-model-2", "test-model-3"],
      },
    },
    defaultProvider: "openai",
    ...extra,
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
  return { dir };
}

describe("ocx models", () => {
  test("models lists all provider models", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("test-model-1");
      expect(result.stdout).toContain("test-model-2");
      expect(result.stdout).toContain("test-model-3");
      expect(result.stdout).toContain("* =");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models --provider filters to one provider", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "--provider", "test"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("test-model-1");
      expect(result.stdout).toContain("test:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models --provider rejects unknown provider", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "--provider", "nonexistent"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not configured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models --json returns valid JSON", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.models).toBeArray();
      expect(parsed.models.length).toBeGreaterThan(0);
      const testModels = parsed.models.filter((m: { provider: string }) => m.provider === "test");
      expect(testModels.length).toBe(3);
      expect(testModels[0].isDefault).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models --provider X --json combines flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "--provider", "test", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.models.every((m: { provider: string }) => m.provider === "test")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models --help prints usage", () => {
    const result = runCli(["models", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ocx models");
  });

  test("help models shows models help entry", () => {
    const result = runCli(["help", "models"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("List available models");
  });
});

describe("ocx models richer metadata", () => {
  test("models --json includes contextWindow and inputModalities", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-models-rich-"));
    const config = {
      port: 10100,
      providers: {
        test: {
          adapter: "openai-chat",
          baseUrl: "http://localhost:8080/v1",
          defaultModel: "model-a",
          models: ["model-a", "model-b"],
          modelContextWindows: { "model-a": 128000, "model-b": 32000 },
          modelInputModalities: { "model-a": ["text", "image"] },
          noVisionModels: ["model-b"],
          reasoningEfforts: ["low", "medium", "high"],
        },
      },
      defaultProvider: "test",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      const modelA = parsed.models.find((m: { model: string }) => m.model === "model-a");
      expect(modelA.contextWindow).toBe(128000);
      expect(modelA.inputModalities).toEqual(["text", "image"]);
      expect(modelA.reasoningEfforts).toEqual(["low", "medium", "high"]);

      const modelB = parsed.models.find((m: { model: string }) => m.model === "model-b");
      expect(modelB.contextWindow).toBe(32000);
      expect(modelB.inputModalities).toEqual(["text"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models rejects unknown flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "--bogus"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown flag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
