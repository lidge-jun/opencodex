import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLD_SPAWN_WARMUP_HOOK_BUDGET_MS, warmModuleGraph } from "../helpers/cold-spawn-warmup";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { configuredReasoningEfforts } from "../../src/reasoning-effort";
import { isModelTextOnly } from "../../src/vision";
import type { OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

setDefaultTimeout(SPAWN_BUDGET_MS);

function runCli(args: string[], env: Record<string, string> = {}, recordAttempts = false) {
  const fixtureHome = env.OPENCODEX_HOME;
  const preload = fixtureHome ? join(fixtureHome, "no-live-sync.ts") : undefined;
  if (preload) {
    mkdirSync(join(fixtureHome!, "codex"), { recursive: true });
    writeFileSync(preload, `
      import { mock } from "bun:test";
      import { appendFileSync } from "node:fs";
      const marker = ${JSON.stringify(join(fixtureHome!, "network-attempts.log"))};
      const record = kind => { if (${recordAttempts}) appendFileSync(marker, kind + "\\n"); };
      const path = ${JSON.stringify(join(repoRoot, "src/server/proxy-liveness.ts"))};
      const original = await import(path);
      mock.module(path, () => ({ ...original, findLiveProxy: async () => { record("liveness"); return null; } }));
      if (process.env.OCX_TEST_TRACK_KEYCHAIN === "1") {
        const keys = await import(${JSON.stringify(join(repoRoot, "src/providers/api-key-resolve.ts"))});
        keys.setProviderKeychainEntryFactoryForTests(() => ({
          getPassword: () => { appendFileSync(${JSON.stringify(join(fixtureHome!, "keychain-attempts.log"))}, "read\\n"); return "fixture-secret"; },
          setPassword: () => {}, deletePassword: () => true,
        }));
        if (process.env.OCX_TEST_PROBE_KEYCHAIN === "1") keys.resolveProviderApiKey("keychain:control");
      }
      globalThis.fetch = () => { record("fetch"); throw new Error("fixture network forbidden"); };
      if (process.env.OCX_TEST_PROBE_NETWORK === "1") {
        try { await globalThis.fetch("https://fixture.test"); }
        catch (error) { if (!(error instanceof Error) || error.message !== "fixture network forbidden") throw error; }
      }
    `);
  }
  const result = spawnSync(process.execPath, [...(preload ? ["--preload", preload] : []), cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env, ...(fixtureHome ? { CODEX_HOME: join(fixtureHome, "codex") } : {}) },
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
  // src/cli/index.ts has roughly fifty top-level imports, so every ocx subcommand pays the same
  // static graph. This file's first spawned child is the one that loads it.
  beforeAll(async () => {
    await warmModuleGraph({ graph: "cli-index/models", entry: cliPath });
  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);

  test.each(["valid", "malformed", "retired-provider"])("local listings leave %s configuration untouched", kind => {
    const { dir } = freshConfig(kind === "retired-provider" ? {
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" }, "opencode-free": {} },
    } : undefined);
    const configPath = join(dir, "config.json");
    const authPath = join(dir, "auth.json");
    mkdirSync(join(dir, "codex"), { recursive: true });
    writeFileSync(join(dir, "no-live-sync.ts"), "");
    writeFileSync(authPath, "{}");
    if (kind === "malformed") writeFileSync(configPath, "{ invalid json");
    if (process.platform !== "win32") {
      chmodSync(dir, 0o755);
      chmodSync(configPath, 0o644);
      chmodSync(authPath, 0o644);
    }
    try {
      const contents = readFileSync(configPath, "utf8");
      const names = readdirSync(dir).sort();
      const modes = [dir, configPath, authPath].map(path => statSync(path).mode & 0o777);
      for (const args of [["models", "--json"], ["models", "list-custom", "--json"]]) {
        const result = runCli(args, { OPENCODEX_HOME: dir });
        expect(result.status).toBe(0);
        const json = JSON.parse(result.stdout);
        if (args.includes("list-custom")) expect(Array.isArray(json)).toBe(true);
        else expect(Array.isArray(json.models)).toBe(true);
        if (kind === "retired-provider") expect(result.stderr).toContain("opencode-free support was removed");
        if (kind === "malformed") expect(result.stderr).toMatch(/invalid|parse/i);
        expect(readFileSync(configPath, "utf8")).toBe(contents);
        expect(readdirSync(dir).sort()).toEqual(names);
        if (process.platform !== "win32") expect([dir, configPath, authPath].map(path => statSync(path).mode & 0o777)).toEqual(modes);
      }
      if (kind === "retired-provider") {
        const filtered = runCli(["models", "--provider", "opencode-free"], { OPENCODEX_HOME: dir });
        expect(filtered.status).toBe(1);
        expect(filtered.stderr).toContain("opencode-free support was removed");
        expect(filtered.stderr).toContain("not configured");
        expect(readFileSync(configPath, "utf8")).toBe(contents);
        expect(readdirSync(dir).sort()).toEqual(names);
      }
    } finally { removeTreeWithRetry(dir); }
  });

  test("models help describes local router-known IDs and process-local cache", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "--help"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("router-known");
      expect(result.stdout).toContain("process-local");
    } finally { removeTreeWithRetry(dir); }
  });

  test("lists a custom-only router-known model with its saved metadata", () => {
    const { dir } = freshConfig({
      providers: { test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: [] } },
      customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "test",
        modelId: "custom-only", contextWindow: 90000, inputModalities: ["text", "image"], reasoningEfforts: [] }],
    });
    try {
      const result = runCli(["models", "--provider", "test", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).models).toContainEqual(expect.objectContaining({
        provider: "test", model: "custom-only", contextWindow: 90000,
        inputModalities: ["text", "image"], reasoningEfforts: [],
      }));
    } finally { removeTreeWithRetry(dir); }
  });

  test("model capabilities and custom rows precede provider noVision hints", () => {
    const { dir } = freshConfig({
      providers: { test: { adapter: "openai-chat", baseUrl: "https://example.test/v1",
        models: ["base", "custom", "cap"], contextWindow: 120000,
        noVisionModels: ["base", "custom", "cap"], modelInputModalities: { base: ["text", "image"] },
        modelCapabilities: { cap: { inputModalities: ["text"] } } } },
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "test", modelId: "custom",
          contextWindow: 90000, inputModalities: ["text", "image"], reasoningEfforts: [] },
        { id: "22222222-2222-4222-8222-222222222222", provider: "test", modelId: "cap",
          inputModalities: ["text", "image"] },
      ],
    });
    try {
      const configBefore = readFileSync(join(dir, "config.json"), "utf8");
      const result = runCli(["models", "--provider", "test", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.find((row: { model: string }) => row.model === "base").inputModalities).toEqual(["text"]);
      expect(rows.find((row: { model: string }) => row.model === "custom")).toMatchObject({
        contextWindow: 90000, inputModalities: ["text", "image"], reasoningEfforts: [],
      });
      expect(rows.find((row: { model: string }) => row.model === "cap").inputModalities).toEqual(["text"]);
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(configBefore);
    } finally { removeTreeWithRetry(dir); }
  });

  test("registry noVision union survives an existing saved list", () => {
    for (const saved of [[], ["unrelated"]]) {
      const { dir } = freshConfig({ providers: { deepseek: { adapter: "openai-chat",
        baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"], noVisionModels: saved,
        modelInputModalities: { "deepseek-chat": ["text", "image"] } } } });
      try {
        const result = runCli(["models", "--provider", "deepseek", "--json"], { OPENCODEX_HOME: dir });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).models.find((row: { model: string }) => row.model === "deepseek-chat").inputModalities)
          .toEqual(["text"]);
      } finally { removeTreeWithRetry(dir); }
    }
  });

  test("custom and capability modalities override registry noVision in order", () => {
    for (const [capability, expected] of [[undefined, ["text", "image"]], [["text"], ["text"]]] as const) {
      const { dir } = freshConfig({ providers: { deepseek: { adapter: "openai-chat",
        baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"], noVisionModels: ["unrelated"],
        ...(capability ? { modelCapabilities: { "deepseek-chat": { inputModalities: capability } } } : {}) } },
        customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "deepseek",
          modelId: "deepseek-chat", inputModalities: ["text", "image"] }] });
      try {
        const result = runCli(["models", "--provider", "deepseek", "--json"], { OPENCODEX_HOME: dir });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).models.find((row: { model: string }) => row.model === "deepseek-chat").inputModalities)
          .toEqual(expected);
      } finally { removeTreeWithRetry(dir); }
    }
  });

  test("OpenAI API context windows honor registry caps and fill partial saved maps", () => {
    for (const [saved, expected] of [[2000000, 1050000], [600000, 600000]] as const) {
      const { dir } = freshConfig({ providers: { "openai-apikey": { adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1", authMode: "key", models: ["gpt-6-astra"],
        modelContextWindows: { "gpt-6-astra": saved } } } });
      try {
        const result = runCli(["models", "--provider", "openai-apikey", "--json"], { OPENCODEX_HOME: dir });
        expect(result.status).toBe(0);
        const rows = JSON.parse(result.stdout).models;
        expect(rows.find((row: { model: string }) => row.model === "gpt-6-astra").contextWindow).toBe(expected);
        expect(rows.find((row: { model: string }) => row.model === "gpt-6-luna").contextWindow).toBe(1050000);
      } finally { removeTreeWithRetry(dir); }
    }
  });

  test("listing honors provider caps and canonical native custom context limits", () => {
    const { dir } = freshConfig({
      providers: {
        "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", models: ["gpt-6-astra"] },
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      },
      providerContextCaps: { "openai-apikey": 100000, openai: 100000 },
      customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "openai", modelId: "gpt-6-luna", contextWindow: 2000000 }],
    });
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "openai-apikey" && row.model === "gpt-6-astra").contextWindow).toBe(100000);
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "openai" && row.model === "gpt-6-luna").contextWindow).toBe(100000);
    } finally { removeTreeWithRetry(dir); }
  });

  test("listing respects explicit reasoning capability denial for seeded models", () => {
    const { dir } = freshConfig({ providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1",
      models: ["grok-4.7"], modelCapabilities: { "grok-4.7": { supportsReasoningEffort: false } } } } });
    try {
      const result = runCli(["models", "--provider", "xai", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).models.find((row: { model: string }) => row.model === "grok-4.7").reasoningEfforts).toEqual([]);
    } finally { removeTreeWithRetry(dir); }
  });

  test("listing bounds custom native reasoning to pinned levels and preserves empty ladders", () => {
    const { dir } = freshConfig({ providers: { test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: [] } },
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "test", modelId: "gpt-6-luna", reasoningEfforts: ["ultra"] },
        { id: "22222222-2222-4222-8222-222222222222", provider: "test", modelId: "gpt-6-astra", reasoningEfforts: [] },
      ] });
    try {
      const result = runCli(["models", "--provider", "test", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.find((row: { model: string }) => row.model === "gpt-6-luna").reasoningEfforts).toEqual(["medium"]);
      expect(rows.find((row: { model: string }) => row.model === "gpt-6-astra").reasoningEfforts).toEqual([]);
    } finally { removeTreeWithRetry(dir); }
  });

  test("custom reasoning ladders honor credential-scoped learned refusals after native bounds", () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "fixture-key-a", models: [] };
    const { dir } = freshConfig({ providers: { test: provider, other: { ...provider, apiKey: "fixture-key-b" } },
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "test", modelId: "gpt-6-luna", reasoningEfforts: ["medium", "high", "ultra"] },
        { id: "22222222-2222-4222-8222-222222222222", provider: "other", modelId: "gpt-6-luna", reasoningEfforts: ["medium", "high", "ultra"] },
        { id: "33333333-3333-4333-8333-333333333333", provider: "test", modelId: "only-high", reasoningEfforts: ["high"] },
        { id: "44444444-4444-4444-8444-444444444444", provider: "test", modelId: "empty", reasoningEfforts: [] },
      ] });
    try {
      const modulePath = join(repoRoot, "src/providers/reasoning-metadata.ts");
      const setup = spawnSync(process.execPath, ["-e", `
        import { recordUnsupportedReasoningEffort, flushReasoningSupportCache } from ${JSON.stringify(modulePath)};
        const provider = ${JSON.stringify(provider)};
        if (!recordUnsupportedReasoningEffort(provider, "gpt-6-luna", "high")) throw new Error("native refusal not recorded");
        if (!recordUnsupportedReasoningEffort(provider, "only-high", "high")) throw new Error("sole refusal not recorded");
        await flushReasoningSupportCache();
      `], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: dir }, encoding: "utf8", timeout: INTERNAL_DEADLINE_MS });
      expect(setup.status, setup.stderr).toBe(0);
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      const efforts = (providerName: string, model: string) => rows.find((row: { provider: string; model: string }) => row.provider === providerName && row.model === model).reasoningEfforts;
      expect(efforts("test", "gpt-6-luna")).toEqual(["medium"]);
      expect(efforts("other", "gpt-6-luna")).toEqual(["medium", "high"]);
      expect(efforts("test", "only-high")).toEqual(["high"]);
      expect(efforts("test", "empty")).toEqual([]);
    } finally { removeTreeWithRetry(dir); }
  });

  test("passive custom and configured ladders do not consult the OS keychain", () => {
    const { dir } = freshConfig({ providers: {
      eligible: { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "keychain:eligible", models: ["configured"], noReasoningModels: ["denied"], modelReasoningEfforts: { configured: ["low", "high"] } },
      other: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "keychain:other", models: ["configured"], modelReasoningEfforts: { configured: ["low", "high"] } },
    }, customModels: [
      { id: "11111111-1111-4111-8111-111111111111", provider: "eligible", modelId: "custom", reasoningEfforts: ["low", "high"] },
      { id: "22222222-2222-4222-8222-222222222222", provider: "eligible", modelId: "empty", reasoningEfforts: [] },
      { id: "33333333-3333-4333-8333-333333333333", provider: "other", modelId: "custom", reasoningEfforts: ["low", "high"] },
      { id: "44444444-4444-4444-8444-444444444444", provider: "eligible", modelId: "denied", reasoningEfforts: ["low", "high"] },
    ] });
    try {
      const marker = join(dir, "keychain-attempts.log");
      const env = { OPENCODEX_HOME: dir, OCX_TEST_TRACK_KEYCHAIN: "1" };
      const result = runCli(["models", "--json"], env);
      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
      const rows = JSON.parse(result.stdout).models;
      const efforts = (provider: string, model: string) => rows.find((row: { provider: string; model: string }) => row.provider === provider && row.model === model).reasoningEfforts;
      expect(efforts("eligible", "custom")).toBeNull();
      expect(efforts("eligible", "configured")).toBeNull();
      expect(efforts("eligible", "empty")).toEqual([]);
      expect(efforts("eligible", "denied")).toEqual([]);
      expect(efforts("other", "custom")).toEqual(["low", "high"]);
      expect(efforts("other", "configured")).toEqual(["low", "high"]);
      const control = runCli(["models", "--json"], { ...env, OCX_TEST_PROBE_KEYCHAIN: "1" });
      expect(control.status).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("read\n");
    } finally { removeTreeWithRetry(dir); }
  });

  test("sparse canonical native custom rows inherit native metadata without leaking to gateways", () => {
    const { dir } = freshConfig({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
        relay: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: [] },
      },
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "openai", modelId: "gpt-6-luna" },
        { id: "22222222-2222-4222-8222-222222222222", provider: "relay", modelId: "gpt-6-luna" },
        { id: "33333333-3333-4333-8333-333333333333", provider: "openai", modelId: "gpt-6-astra", inputModalities: ["text"], reasoningEfforts: [] },
      ],
    });
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "openai" && row.model === "gpt-6-luna"))
        .toMatchObject({ inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] });
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "relay" && row.model === "gpt-6-luna"))
        .toMatchObject({ inputModalities: null, reasoningEfforts: null });
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "openai" && row.model === "gpt-6-astra"))
        .toMatchObject({ inputModalities: ["text"], reasoningEfforts: [] });
    } finally { removeTreeWithRetry(dir); }
  });

  test("canonical native custom metadata honors provider vision restrictions", () => {
    for (const restriction of [
      { noVisionModels: ["gpt-6-luna"] },
      { modelInputModalities: { "gpt-6-luna": ["text"] } },
    ]) {
      const { dir } = freshConfig({ providers: { openai: { adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", ...restriction } },
        customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "openai", modelId: "gpt-6-luna" }] });
      try {
        const result = runCli(["models", "--provider", "openai", "--json"], { OPENCODEX_HOME: dir });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).models.find((row: { model: string }) => row.model === "gpt-6-luna").inputModalities).toEqual(["text"]);
      } finally { removeTreeWithRetry(dir); }
    }
  });

  test("canonical native custom metadata honors provider reasoning restrictions", () => {
    for (const restriction of [
      { noReasoningModels: ["gpt-6-luna"] },
      { modelCapabilities: { "gpt-6-luna": { supportsReasoningEffort: false } } },
    ]) {
      const { dir } = freshConfig({ providers: { openai: { adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", ...restriction } },
        customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "openai", modelId: "gpt-6-luna" }] });
      try {
        const result = runCli(["models", "--provider", "openai", "--json"], { OPENCODEX_HOME: dir });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).models.find((row: { model: string }) => row.model === "gpt-6-luna").reasoningEfforts).toEqual([]);
      } finally { removeTreeWithRetry(dir); }
    }
  });

  test("listing applies opt-in vendor context inference and provider caps", () => {
    const { dir } = freshConfig({
      providers: {
        relay: { adapter: "openai-chat", baseUrl: "https://example.test/v1", inferContextWindow: true, models: ["claude-sonnet-5-5"] },
        plain: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: ["claude-sonnet-5-5"] },
      },
      providerContextCaps: { relay: 350000 },
      customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "relay", modelId: "claude-opus-5-5" }],
    });
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "relay" && row.model === "claude-opus-5-5").contextWindow).toBe(350000);
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "relay" && row.model === "claude-sonnet-5-5").contextWindow).toBe(350000);
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "plain" && row.model === "claude-sonnet-5-5").contextWindow).toBeNull();
    } finally { removeTreeWithRetry(dir); }
  });

  test("listing prefers Azure metadata and applies configured-row cap fallback offline", () => {
    const { dir } = freshConfig({
      providers: { "custom-azure": { adapter: "openai-chat", baseUrl: "https://resource.openai.azure.com/openai",
        inferContextWindow: true, models: ["claude-opus-5-5", "unknown-model"] } },
      providerContextCaps: { "custom-azure": 350000 },
      customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "custom-azure",
        modelId: "claude-sonnet-5-5", contextWindow: 190000 }],
    });
    writeFileSync(join(dir, "azure-model-metadata-cache.json"), JSON.stringify({
      version: 1, fetchedAt: Date.now(), models: { "claude-opus-5-5": { contextWindow: 333333 } },
    }));
    try {
      const result = runCli(["models", "--provider", "custom-azure", "--json"], { OPENCODEX_HOME: dir }, true);
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.find((row: { model: string }) => row.model === "claude-opus-5-5").contextWindow).toBe(333333);
      expect(rows.find((row: { model: string }) => row.model === "unknown-model").contextWindow).toBe(350000);
      expect(rows.find((row: { model: string }) => row.model === "claude-sonnet-5-5").contextWindow).toBe(190000);
      expect(existsSync(join(dir, "network-attempts.log"))).toBe(false);
    } finally { removeTreeWithRetry(dir); }
  });

  test.each([
    ["xai", "grok-composer-2.5-fast", 350000],
    ["relay", "custom-only", null],
  ])("custom context inheritance for %s/%s", (providerName, modelId, expected) => {
    const { dir } = freshConfig({
      providers: {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1" },
        relay: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: [], contextWindow: 200000 },
      },
      providerContextCaps: { xai: 350000, relay: 100000 },
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "xai", modelId: "grok-composer-2.5-fast" },
        { id: "22222222-2222-4222-8222-222222222222", provider: "relay", modelId: "custom-only" },
      ],
    });
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.find((row: { provider: string; model: string }) => row.provider === providerName && row.model === modelId).contextWindow).toBe(expected);
    } finally { removeTreeWithRetry(dir); }
  });

  test("custom rows inherit context for guarded registry-known IDs", () => {
    const { dir } = freshConfig({
      providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", models: ["grok-4.7"] } },
      providerContextCaps: { xai: 350000 },
      customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "xai", modelId: "grok-4.6" }],
    });
    try {
      const result = runCli(["models", "--provider", "xai", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).models.find((row: { model: string }) => row.model === "grok-4.6").contextWindow).toBe(350000);
    } finally { removeTreeWithRetry(dir); }
  });

  test("listing uses offline Azure modalities beneath explicit restrictions", () => {
    const { dir } = freshConfig({ providers: {
      azureopen: { adapter: "openai-chat", baseUrl: "https://resource.openai.azure.com/openai", models: ["gpt-4o"] },
      azurerestricted: { adapter: "openai-chat", baseUrl: "https://resource.openai.azure.com/openai", models: ["gpt-4o"], noVisionModels: ["gpt-4o"] },
    } });
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir }, true);
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "azureopen" && row.model === "gpt-4o").inputModalities).toEqual(["text", "image"]);
      expect(rows.find((row: { provider: string; model: string }) => row.provider === "azurerestricted" && row.model === "gpt-4o").inputModalities).toEqual(["text"]);
      expect(existsSync(join(dir, "network-attempts.log"))).toBe(false);
    } finally { removeTreeWithRetry(dir); }
  });

  test("human listing renders identifiers safely while JSON preserves their values", () => {
    const modelId = `custom${String.fromCharCode(27)}a${String.fromCharCode(0x9d)}b${String.fromCharCode(0x2028)}c`;
    const { dir } = freshConfig({ providers: { relay: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: [] } },
      customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "relay", modelId }] });
    try {
      const human = runCli(["models", "--provider", "relay"], { OPENCODEX_HOME: dir });
      expect(human.status).toBe(0);
      for (const code of [27, 0x9d, 0x2028]) expect(human.stdout).not.toContain(String.fromCharCode(code));
      expect(human.stdout).toContain("custom\\x1ba\\u009db\\u2028c");
      const json = runCli(["models", "--provider", "relay", "--json"], { OPENCODEX_HOME: dir });
      expect(json.status).toBe(0);
      for (const code of [27, 0x9d, 0x2028]) expect(json.stdout).not.toContain(String.fromCharCode(code));
      expect(JSON.parse(json.stdout).models[0].model).toBe(modelId);
      const customHuman = runCli(["models", "list-custom"], { OPENCODEX_HOME: dir });
      expect(customHuman.status).toBe(0);
      for (const code of [27, 0x9d, 0x2028]) expect(customHuman.stdout).not.toContain(String.fromCharCode(code));
      expect(customHuman.stdout).toContain("custom\\x1ba\\u009db\\u2028c");
      const customJson = runCli(["models", "list-custom", "--json"], { OPENCODEX_HOME: dir });
      expect(customJson.status).toBe(0);
      for (const code of [27, 0x9d, 0x2028]) expect(customJson.stdout).not.toContain(String.fromCharCode(code));
      expect(JSON.parse(customJson.stdout)[0].modelId).toBe(modelId);
    } finally { removeTreeWithRetry(dir); }
  });

  test("listing reads a stale reasoning snapshot without attempting network or liveness", () => {
    const { dir } = freshConfig({ providers: { test: { adapter: "openai-chat",
      baseUrl: "https://opencode.ai/zen/go/v1", models: ["fixture-model"] } } });
    const file = join(dir, "reasoning-metadata-cache.json");
    const snapshot = JSON.stringify({ version: 1, fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
      source: "test", providers: { "opencode-go": { "fixture-model": {
        reasoning: true, options: [{ type: "effort", values: ["low", "high"] }],
      } } } });
    writeFileSync(file, snapshot);
    try {
      const result = runCli(["models", "--provider", "test", "--json"], { OPENCODEX_HOME: dir }, true);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).models[0].reasoningEfforts).toEqual(["low", "high"]);
      expect(existsSync(join(dir, "network-attempts.log"))).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(snapshot);
      const control = runCli(["models", "--provider", "test", "--json"],
        { OPENCODEX_HOME: dir, OCX_TEST_PROBE_NETWORK: "1" }, true);
      expect(control.status).toBe(0);
      expect(readFileSync(join(dir, "network-attempts.log"), "utf8")).toContain("fetch");
    } finally { removeTreeWithRetry(dir); }
  });

  test("keeps default first, deduplicates per provider and uses provider-wide modalities", () => {
    const { dir } = freshConfig({ providers: {
      one: { adapter: "openai-chat", baseUrl: "https://one.example/v1", defaultModel: "default-only",
        models: ["duplicate", "duplicate"], inputModalities: ["text"] },
      two: { adapter: "openai-chat", baseUrl: "https://two.example/v1", models: ["duplicate"] },
    }, customModels: [{ id: "11111111-1111-4111-8111-111111111111", provider: "one", modelId: "duplicate" }] });
    try {
      const json = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.models.filter((row: { provider: string }) => row.provider === "one").map((row: { model: string }) => row.model))
        .toEqual(["default-only", "duplicate"]);
      expect(parsed.models.filter((row: { model: string }) => row.model === "duplicate")).toHaveLength(2);
      expect(parsed.models.find((row: { provider: string }) => row.provider === "one").inputModalities).toEqual(["text"]);
      expect(parsed.note).toContain("this process's discovery cache");
      const human = runCli(["models"], { OPENCODEX_HOME: dir });
      expect(human.stdout).toContain("this process's discovery cache");
    } finally { removeTreeWithRetry(dir); }
  });

  test("legacy key preset router seeds and mimo-free's special guard match routing", () => {
    const { dir } = freshConfig({ providers: {
      deepseek: { adapter: "openai-chat", baseUrl: "https://other.example/v1", models: ["my-model"] },
      "mimo-free": { adapter: "openai-chat", baseUrl: "https://other.example/v1", models: ["my-model"] },
    } });
    try {
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models as Array<{ provider: string; model: string }>;
      expect(rows.filter(row => row.provider === "deepseek").map(row => row.model)).toContain("deepseek-chat");
      expect(rows.filter(row => row.provider === "mimo-free").map(row => row.model)).toEqual(["my-model"]);
    } finally { removeTreeWithRetry(dir); }
    const matching = freshConfig({ providers: { "mimo-free": { adapter: "mimo-free",
      baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat", authMode: "key", models: ["my-model"] } } });
    try {
      const result = runCli(["models", "--provider", "mimo-free", "--json"], { OPENCODEX_HOME: matching.dir });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).models.map((row: { model: string }) => row.model)).toContain("mimo-auto");
    } finally { removeTreeWithRetry(matching.dir); }
  });

  test("partial saved Kimi effort maps keep registry wire ladder values", () => {
    const { dir } = freshConfig({ providers: { "kimi-code": { adapter: "openai-chat",
      baseUrl: "https://api.kimi.com/coding/v1", authMode: "key", models: ["kimi-for-coding"],
      modelReasoningEfforts: { "kimi-for-coding": ["max"] },
      modelReasoningEffortMap: { unrelated: { high: "high" } } } } });
    try {
      const result = runCli(["models", "--provider", "kimi-code", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const row = JSON.parse(result.stdout).models.find((item: { model: string }) => item.model === "kimi-for-coding");
      expect(row.reasoningEfforts).toEqual(["low", "high", "max"]);
    } finally { removeTreeWithRetry(dir); }
  });

  test("configured models expose automatic prices, overrides and unknowns without persisting defaults", () => {
    const { dir } = freshConfig({ providers: { relay: {
      adapter: "openai-chat", baseUrl: "https://example.com/v1",
      models: ["claude-sonnet-4-6", "gpt-4o", "unknown-model"],
      modelCosts: { "gpt-4o": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    } } });
    try {
      const before = readFileSync(join(dir, "config.json"), "utf8");
      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows[0].price.cost4).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
      expect(rows[1].price).toMatchObject({ source: "user", cost4: { input: 0, output: 0 } });
      expect(rows[2].price).toBeNull();
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
      const human = runCli(["models"], { OPENCODEX_HOME: dir });
      expect(human.stdout).toContain("~$3/$15 input/output per 1M tokens");
      expect(human.stdout).toContain("price unknown");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("models --provider rejects unknown provider", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "--provider", "nonexistent"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not configured");
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  // The registry-sync merge must go through the router's guarded derivation, not a raw
  // registry read: a provider whose transport diverges from its namesake registry entry
  // gets nothing, a matching one gets the seed, and stale saved configs gain new seed ids
  // while saved models stay first. cline is a registry entry with preserveCustomDestination
  // (fixed key destination), so the transport guard actually discriminates for it.
  test("registry seed syncs into a stale saved config when the transport matches", () => {
    const { dir } = freshConfig({ providers: { cline: {
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      authMode: "key",
      apiKey: "sk-test",
      defaultModel: "anthropic/claude-sonnet-4-6",
      // Deliberately predates the current seed: saved subset, plus one custom-only id.
      models: ["anthropic/claude-sonnet-4-6", "custom-only-model"],
    } } });
    try {
      const result = runCli(["models", "--provider", "cline", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models.map((m: { model: string; isDefault: boolean }) => m);
      expect(rows[0]).toMatchObject({ model: "anthropic/claude-sonnet-4-6", isDefault: true });
      expect(rows[1]).toMatchObject({ model: "custom-only-model", isDefault: false });
      // Seed ids absent from the stale saved config still appear.
      const ids = rows.map((m: { model: string }) => m.model);
      expect(ids).toContain("openai/gpt-4o");
      expect(ids).toContain("google/gemini-2.5-pro");
      // No duplicate rows: saved ids also come back from the router union, and the
      // per-provider seen-dedupe must collapse them.
      expect(new Set(ids).size).toBe(ids.length);
      expect(rows.filter((m: { isDefault: boolean }) => m.isDefault)).toHaveLength(1);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("registry seed does NOT leak into a provider whose transport diverges from its namesake", () => {
    const { dir } = freshConfig({ providers: { cline: {
      adapter: "openai-chat",
      baseUrl: "https://elsewhere.example.com/v1",
      authMode: "key",
      apiKey: "sk-test",
      defaultModel: "my-model",
      models: ["my-model"],
    } } });
    try {
      // The cline registry entry carries a non-empty seed (the matching-transport test
      // above receives it), so listing only the saved id here means the transport guard
      // is what excluded the seed, not an empty registry.
      const result = runCli(["models", "--provider", "cline", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models;
      expect(rows.map((m: { model: string }) => m.model)).toEqual(["my-model"]);
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          // claude-fable-5-4 and Claude-fable-5-3 are unseeded siblings that inherit the
          // configured claude-fable-5 family window; Fable 5.2 is now a seeded id.
          models: ["claude-fable-5-4", "Claude-fable-5-3", "claude-fable-5-1", "unknown-model"],
          contextWindow: 128000,
          modelContextWindows: { "claude-fable-5": 1000000, "claude-fable-5-1": 800000 },
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

      const anthropicWindows = Object.fromEntries(parsed.models
        .filter((m: { provider: string }) => m.provider === "anthropic")
        .map((m: { model: string; contextWindow: number }) => [m.model, m.contextWindow]));
      expect(anthropicWindows).toMatchObject({
        "claude-fable-5-4": 1000000,
        "Claude-fable-5-3": 1000000,
        "claude-fable-5-1": 800000,
        "unknown-model": 128000,
      });
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("the effort ladder is the one the runtime resolves, as with the modality", () => {
    // `configuredReasoningEfforts` is what the catalog and the effort cap resolve
    // through. Restating part of it here reported a ladder for a model the proxy
    // strips reasoning from, and echoed a level Codex does not declare.
    const dir = mkdtempSync(join(tmpdir(), "ocx-models-efforts-"));
    const provider = {
      adapter: "openai-chat",
      baseUrl: "http://localhost:8080/v1",
      allowPrivateNetwork: true,
      defaultModel: "model-a",
      models: ["model-a", "model-b", "model-c"],
      reasoningEfforts: ["low", "medium", "high"],
      noReasoningModels: ["model-b"],
      modelReasoningEfforts: { "model-c": ["high", "bogus", "low"] },
    };
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ port: 10122, providers: { test: provider }, defaultProvider: "test" }),
      "utf8",
    );
    try {
      const config = provider as unknown as OcxProviderConfig;
      // Ground truth first: what the proxy itself will do with this config.
      expect(configuredReasoningEfforts(config, "model-a")).toEqual(["low", "medium", "high"]);
      // An empty ladder is not the same claim as "no override": it says this model
      // intentionally exposes no effort control, which is why it must survive to the row.
      expect(configuredReasoningEfforts(config, "model-b")).toEqual([]);
      expect(configuredReasoningEfforts(config, "model-c")).toEqual(["low", "high"]);

      const result = runCli(["models", "--json"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const rows = JSON.parse(result.stdout).models as { model: string; reasoningEfforts: unknown }[];
      const ladderOf = (model: string) => rows.find((m) => m.model === model)?.reasoningEfforts;

      expect(ladderOf("model-a")).toEqual(["low", "medium", "high"]);
      expect(ladderOf("model-b")).toEqual([]);
      expect(ladderOf("model-c")).toEqual(["low", "high"]);
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });

  test("models rejects unknown flags", () => {
    const { dir } = freshConfig();
    try {
      const result = runCli(["models", "--bogus"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown flag");
    } finally {
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
        removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
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
      removeTreeWithRetry(dir);
    }
  });
});

describe("#2491 the removal selector uses the shared equivalence relation", () => {
  /**
   * `slugEquals` compared the raw and encoded spellings of ONE id, so a selector written in
   * the NATIVE slash form matched only the slash row while the encoded form matched both.
   * Catalog filtering and persisted sync had already agreed on the collision class through
   * `slugEquivalenceKey`; this command disagreed with both on the same config.
   */
  test("a native-slash selector sees the same collision the encoded one does", () => {
    const { dir } = freshConfig({
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "test", modelId: "openai/gpt-5.5" },
        { id: "22222222-2222-4222-8222-222222222222", provider: "test", modelId: "openai-gpt-5.5" },
      ],
    });
    try {
      // Before: this deleted the slash row outright, because slugEquals matched only it.
      const result = runCli(["models", "remove", "test/openai/gpt-5.5", "--yes"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ambiguous");
      // Refusing is the right default for a destructive command: nothing was removed.
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(config.customModels).toHaveLength(2);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("an unambiguous slash selector still removes its row", () => {
    // Widening the relation must not make ordinary removal ambiguous.
    const { dir } = freshConfig({
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "test", modelId: "openai/gpt-5.5" },
        { id: "33333333-3333-4333-8333-333333333333", provider: "test", modelId: "unrelated" },
      ],
    });
    try {
      const result = runCli(["models", "remove", "test/openai/gpt-5.5", "--yes"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(config.customModels.map((m: { modelId: string }) => m.modelId)).toEqual(["unrelated"]);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("a provider-qualified selector does not match a native id under another provider", () => {
    const { dir } = freshConfig({
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "openai", modelId: "gpt-5.5" },
        { id: "22222222-2222-4222-8222-222222222222", provider: "test", modelId: "openai/gpt-5.5" },
      ],
    });
    try {
      const result = runCli(["models", "remove", "openai/gpt-5.5", "--yes"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(config.customModels).toEqual([
        expect.objectContaining({ provider: "test", modelId: "openai/gpt-5.5" }),
      ]);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("a provider-qualified selector cannot remove a sole row from another provider", () => {
    const { dir } = freshConfig({
      customModels: [
        { id: "22222222-2222-4222-8222-222222222222", provider: "test", modelId: "openai/gpt-5.5" },
      ],
    });
    try {
      const result = runCli(["models", "remove", "openai/gpt-5.5", "--yes"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not found");
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(config.customModels).toEqual([
        expect.objectContaining({ provider: "test", modelId: "openai/gpt-5.5" }),
      ]);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  /**
   * A provider may publish a native id that is itself namespaced under its own name, so
   * `acme` owning `acme/turbo` makes the selector `acme/turbo` name that row exactly while
   * ALSO reading as the provider-qualified form of a sibling `turbo`. The resolver was called
   * once per row with a singleton roster, so each row matched its own reading, the command saw
   * two matches and aborted — the exact native spelling could never remove its own row.
   */
  test("a self-namespaced selector removes the row it names exactly", () => {
    const { dir } = freshConfig({
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "acme", modelId: "acme/turbo" },
        { id: "22222222-2222-4222-8222-222222222222", provider: "acme", modelId: "turbo" },
      ],
    });
    try {
      const result = runCli(["models", "remove", "acme/turbo", "--yes"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      // The sibling survives: the selector named the native row, not the qualified reading.
      expect(config.customModels).toEqual([
        expect.objectContaining({ provider: "acme", modelId: "turbo" }),
      ]);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  /**
   * Guards the narrow path: with no sibling there is no collision, so this already worked and
   * must keep working. It pins the case the resolver-level fix covers, so a future change that
   * narrows the roster lookup cannot silently make a sole self-namespaced row unreachable.
   */
  test("a self-namespaced row is removable when it is the provider's only row", () => {
    const { dir } = freshConfig({
      customModels: [
        { id: "11111111-1111-4111-8111-111111111111", provider: "acme", modelId: "acme/turbo" },
      ],
    });
    try {
      const result = runCli(["models", "remove", "acme/turbo", "--yes"], { OPENCODEX_HOME: dir });
      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(config.customModels).toBeUndefined();
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});
