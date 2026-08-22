import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "./helpers/test-budget";
import { isModelTextOnly } from "../src/vision";
import type { OcxProviderConfig } from "../src/types";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

setDefaultTimeout(SPAWN_BUDGET_MS);

function runCli(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: INTERNAL_DEADLINE_MS,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  return result;
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
        allowPrivateNetwork: true,
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
          allowPrivateNetwork: true,
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

  test("a family entry classifies its tagged siblings, as the runtime does", () => {
    // isModelTextOnly matches noVisionModels with modelInList and reads
    // modelInputModalities with modelRecordValue, so a `gpt-oss` entry covers
    // `gpt-oss:120b`. This command must not report a different answer.
    const dir = mkdtempSync(join(tmpdir(), "ocx-models-family-"));
    const provider = {
      adapter: "openai-chat",
      baseUrl: "http://localhost:8080/v1",
      allowPrivateNetwork: true,
      defaultModel: "gpt-oss:120b",
      models: ["gpt-oss:120b"],
      modelContextWindows: { "gpt-oss": 131000 },
      noVisionModels: ["gpt-oss"],
      modelReasoningEfforts: { "gpt-oss": ["low", "high"] },
    };
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ port: 10121, providers: { test: provider }, defaultProvider: "test" }),
      "utf8",
    );
    try {
      // Ground truth first: what the proxy itself will do with this config.
      expect(isModelTextOnly(provider as unknown as OcxProviderConfig, "gpt-oss:120b")).toBe(true);

      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const row = JSON.parse(result.stdout).models
        .find((m: { model: string }) => m.model === "gpt-oss:120b");
      expect(row.inputModalities).toEqual(["text"]);
      expect(row.contextWindow).toBe(131000);
      expect(row.reasoningEfforts).toEqual(["low", "high"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a noVision family entry beats an exact modality entry, as the runtime does", () => {
    // isModelTextOnly returns true on the noVisionModels match before it ever reads
    // modelInputModalities, so an exact entry listing "image" does not grant vision.
    // Reporting ["text", "image"] here would advertise support the proxy then rejects.
    const dir = mkdtempSync(join(tmpdir(), "ocx-models-novision-"));
    const provider = {
      adapter: "openai-chat",
      baseUrl: "http://localhost:8080/v1",
      allowPrivateNetwork: true,
      defaultModel: "gpt-oss:120b",
      models: ["gpt-oss:120b"],
      noVisionModels: ["gpt-oss"],
      modelInputModalities: { "gpt-oss:120b": ["text", "image"] },
    };
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ port: 10123, providers: { test: provider }, defaultProvider: "test" }),
      "utf8",
    );
    try {
      // Ground truth first: the proxy treats this model as text-only.
      expect(isModelTextOnly(provider as unknown as OcxProviderConfig, "gpt-oss:120b")).toBe(true);

      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const row = JSON.parse(result.stdout).models
        .find((m: { model: string }) => m.model === "gpt-oss:120b");
      expect(row.inputModalities).toEqual(["text"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an exact entry still wins over the family entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-models-exact-"));
    const provider = {
      adapter: "openai-chat",
      baseUrl: "http://localhost:8080/v1",
      allowPrivateNetwork: true,
      defaultModel: "gpt-oss:20b",
      models: ["gpt-oss:20b"],
      modelContextWindows: { "gpt-oss": 131000, "gpt-oss:20b": 32000 },
    };
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ port: 10122, providers: { test: provider }, defaultProvider: "test" }),
      "utf8",
    );
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      const row = JSON.parse(result.stdout).models
        .find((m: { model: string }) => m.model === "gpt-oss:20b");
      expect(row.contextWindow).toBe(32000);
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

describe("ocx models custom slash ids", () => {
  test("models add accepts slash model ids", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "add", "test", "openai/gpt-5.5"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(config.customModels[0].modelId).toBe("openai/gpt-5.5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models remove accepts raw and encoded slash selectors", () => {
    for (const target of ["test/openai/gpt-5.5", "test/openai-gpt-5.5"]) {
      const { dir } = freshConfig();
      try {
        const add = runCli(["models", "add", "test", "openai/gpt-5.5"], { OPENCODEX_HOME: dir });
        expect(add.status).toBe(0);
        const remove = runCli(["models", "remove", target, "--yes"], { OPENCODEX_HOME: dir });
        expect(remove.status).toBe(0);
        const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
        expect(config.customModels ?? []).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("models add still rejects displayName with slash", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(
        ["models", "add", "test", "openai/gpt-5.5", "--display-name", "foo/bar"],
        { OPENCODEX_HOME: dir },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("displayName must not contain /");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models add rejects a slash id that encodes to an existing native id", () => {
    const { dir } = freshConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
        test: {
          adapter: "openai-chat",
          baseUrl: "http://localhost:8080/v1",
          allowPrivateNetwork: true,
          defaultModel: "openai-gpt-5.5",
          models: ["openai-gpt-5.5", "a-b/c"],
        },
      },
    });
    try {
      const slash = runCli(["models", "add", "test", "openai/gpt-5.5"], { OPENCODEX_HOME: dir });
      expect(slash.status).toBe(1);
      expect(slash.stderr).toContain("ambiguous");
      const multi = runCli(["models", "add", "test", "a/b-c"], { OPENCODEX_HOME: dir });
      expect(multi.status).toBe(1);
      expect(multi.stderr).toContain("ambiguous");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models add rejects a slash id that encodes to defaultModel only", () => {
    const { dir } = freshConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
        test: {
          adapter: "openai-chat",
          baseUrl: "http://localhost:8080/v1",
          allowPrivateNetwork: true,
          defaultModel: "openai-gpt-5.5",
          models: [],
        },
      },
    });
    try {
      const result = runCli(["models", "add", "test", "openai/gpt-5.5"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ambiguous");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("models remove rejects an encoded selector that matches more than one custom model", () => {
    const { dir } = freshConfig({
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "test", modelId: "openai/gpt-5.5" },
        { id: "22222222-2222-4222-8222-222222222222", provider: "test", modelId: "openai-gpt-5.5" },
      ],
    });
    try {
      const result = runCli(["models", "remove", "test/openai-gpt-5.5", "--yes"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ambiguous");
      expect(result.stderr).toContain("custom model id");
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(config.customModels).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
