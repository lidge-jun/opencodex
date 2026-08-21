import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientPathError,
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  OPENCODE_API_KEY_ENV,
  OPENCODE_API_KEY_ENV_REF,
  LOOPBACK_API_KEY_PLACEHOLDER,
  SCHEMA_REQUIRED_OUTPUT_BUDGET,
  buildClientConfig,
  buildClientConfigText,
  isExportClientId,
  normalizeExportModels,
  ompModelsConfigPath,
  type DshGeneratedConfig,
  type ExportContext,
  type ExportModel,
  type OpencodeGeneratedConfig,
  type PiGeneratedConfig,
} from "../src/clients/config-export";
import { buildOpencodeProviderBlockFromCatalog, opencodeGlobalConfigPath } from "../src/cli/opencode";
import type { OcxConfig } from "../src/types";

/**
 * Fixture covering the four rows that exercise every emission branch: native,
 * routed-with-displayName, missing context window, and a context window below the
 * schema output budget (which must clamp).
 */
const FIXTURE: ExportModel[] = [
  { namespaced: "gpt-5.6-luna", native: true, provider: "openai", id: "gpt-5.6-luna", contextWindow: 272_000 },
  { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000, displayName: "Claude Opus 5" },
  { namespaced: "custom/no-context", provider: "custom", id: "no-context" },
  { namespaced: "tiny/small-ctx", provider: "tiny", id: "small-ctx", contextWindow: 8_000 },
];

const BASE_URL = "http://127.0.0.1:10100/v1";

function ctx(extra?: Partial<ExportContext>): ExportContext {
  return { baseUrl: BASE_URL, models: FIXTURE, ...extra };
}

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
    ...extra,
  } as OcxConfig;
}

/**
 * Captured from `buildOpencodeProviderBlockFromCatalog` BEFORE the serializer moved to
 * src/clients/config-export.ts, for the fixture above at port 10100 / 127.0.0.1. Inlined
 * rather than read from a file so the assertion survives without scratch state.
 *
 * The relocated builder must reproduce this byte-for-byte; the client-config path adds a
 * dedupe+sort precondition, so it is compared entry-by-entry against the same truth.
 */
const GOLDEN_OPENCODE_BLOCK = JSON.parse(
  '{"npm":"@ai-sdk/openai-compatible","name":"OpenCodex","options":{"baseURL":"http://127.0.0.1:10100/v1","apiKey":"{env:OPENCODEX_OPENCODE_API_KEY}"},"models":{"gpt-5.6-luna":{"name":"gpt-5.6-luna (native)","limit":{"context":272000,"output":32000}},"anthropic/claude-opus-5":{"name":"Claude Opus 5 (anthropic)","limit":{"context":200000,"output":32000}},"custom/no-context":{"name":"no-context (custom)"},"tiny/small-ctx":{"name":"small-ctx (tiny)","limit":{"context":8000,"output":8000}}}}',
) as {
  npm: string;
  name: string;
  options: Record<string, unknown>;
  models: Record<string, { name: string; limit?: { context: number; output: number } }>;
};

function opencodeConfig(context: ExportContext = ctx()): OpencodeGeneratedConfig {
  return buildClientConfig("opencode", context) as OpencodeGeneratedConfig;
}

function piConfig(context: ExportContext = ctx()): PiGeneratedConfig {
  return buildClientConfig("pi", context) as PiGeneratedConfig;
}

function dshConfig(context: ExportContext = ctx()): DshGeneratedConfig {
  return buildClientConfig("dsh", context) as DshGeneratedConfig;
}


describe("relocated OpenCode serializer (accept criterion 1)", () => {
  test("the moved builder reproduces the pre-refactor golden byte-for-byte", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, FIXTURE, "127.0.0.1");
    expect(JSON.stringify(block)).toBe(JSON.stringify(GOLDEN_OPENCODE_BLOCK));
  });

  test("buildClientConfig('opencode') emits the same entries as the golden", () => {
    const block = opencodeConfig().provider.opencodex!;
    expect(block.npm).toBe(GOLDEN_OPENCODE_BLOCK.npm);
    expect(block.name).toBe(GOLDEN_OPENCODE_BLOCK.name);
    expect(block.options).toEqual(GOLDEN_OPENCODE_BLOCK.options);
    // Sort order differs from the golden by design (dedupe+sort precondition); the
    // per-entry values are the truth being preserved.
    expect(Object.keys(block.models).sort()).toEqual(Object.keys(GOLDEN_OPENCODE_BLOCK.models).sort());
    for (const [key, expected] of Object.entries(GOLDEN_OPENCODE_BLOCK.models)) {
      expect(block.models[key]).toEqual(expected);
    }
  });

  test("carries the V1 schema and only the opencodex provider key", () => {
    const config = opencodeConfig();
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(Object.keys(config.provider)).toEqual(["opencodex"]);
  });

  test("a non-loopback bind moves admission to the header branch", () => {
    const block = opencodeConfig(ctx({ config: cfg({ hostname: "0.0.0.0" }) })).provider.opencodex!;
    expect(block.options.apiKey).toBeUndefined();
    expect(block.options.headers).toEqual({ "x-opencodex-api-key": OPENCODE_API_KEY_ENV_REF });
  });

  test("a loopback bind keeps the apiKey branch", () => {
    const block = opencodeConfig(ctx({ config: cfg({ hostname: "127.0.0.1" }) })).provider.opencodex!;
    expect(block.options.apiKey).toBe(OPENCODE_API_KEY_ENV_REF);
    expect(block.options.headers).toBeUndefined();
  });

  test("the label carries the provider suffix, not a bare display name", () => {
    const models = opencodeConfig().provider.opencodex!.models;
    expect(models["gpt-5.6-luna"]!.name).toBe("gpt-5.6-luna (native)");
    expect(models["anthropic/claude-opus-5"]!.name).toBe("Claude Opus 5 (anthropic)");
    expect(models["custom/no-context"]!.name).toBe("no-context (custom)");
  });

  test("a catalog row with no provider falls back to the routed label", () => {
    // Nullish fallback, preserved verbatim from the pre-move builder: an ABSENT provider
    // becomes "routed", while an empty string is passed through unchanged.
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      { namespaced: "mystery", id: "mystery" },
      { namespaced: "blank", id: "blank", provider: "" },
    ], "127.0.0.1");
    expect(block.models["mystery"]!.name).toBe("mystery (routed)");
    expect(block.models["blank"]!.name).toBe("blank ()");
  });

  test("a row whose id is absent labels from the namespaced selector", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      { namespaced: "acme/only-namespaced", provider: "acme" },
    ], "127.0.0.1");
    expect(block.models["acme/only-namespaced"]!.name).toBe("acme/only-namespaced (acme)");
  });

  test("a non-positive or non-finite context window drops the limit block entirely", () => {
    const block = buildOpencodeProviderBlockFromCatalog(10100, [
      { namespaced: "a/zero", provider: "a", id: "zero", contextWindow: 0 },
      { namespaced: "b/negative", provider: "b", id: "negative", contextWindow: -1 },
      { namespaced: "c/nan", provider: "c", id: "nan", contextWindow: Number.NaN },
    ], "127.0.0.1");
    for (const entry of Object.values(block.models)) {
      expect(entry.limit).toBeUndefined();
    }
  });
});

describe("Pi serializer (accept criterion 2)", () => {
  test("models is an array keyed by id, not a keyed object", () => {
    const provider = piConfig().providers.opencodex!;
    expect(Array.isArray(provider.models)).toBe(true);
    expect(provider.models.map(model => model.id)).toEqual([
      "anthropic/claude-opus-5",
      "custom/no-context",
      "gpt-5.6-luna",
      "tiny/small-ctx",
    ]);
  });

  test("provider envelope names the OpenAI-compatible dialect and the loopback placeholder", () => {
    const provider = piConfig().providers.opencodex!;
    expect(provider.baseUrl).toBe(BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe(LOOPBACK_API_KEY_PLACEHOLDER);
  });

  test("cost is omitted on every entry — zeros would assert routed models are free", () => {
    for (const model of piConfig().providers.opencodex!.models) {
      expect(model).not.toHaveProperty("cost");
    }
    expect(JSON.stringify(piConfig())).not.toContain("cost");
  });

  test("reasoning is emitted only for rows with a non-empty effort ladder", () => {
    // The shared fixture carries no ladder anywhere: every entry stays reasoning-free.
    for (const model of piConfig().providers.opencodex!.models) {
      expect(model).not.toHaveProperty("reasoning");
    }
    const config = piConfig(ctx({
      models: [
        { namespaced: "a/reasoning", provider: "a", id: "reasoning", reasoningEfforts: ["low", "high"] },
        { namespaced: "b/none", provider: "b", id: "none", reasoningEfforts: [] },
        { namespaced: "c/plain", provider: "c", id: "plain" },
        { namespaced: "d/off", provider: "d", id: "off", reasoningEfforts: ["none", "minimal", "low"] },
      ],
    }));
    const models = config.providers.opencodex!.models;
    expect(models.find(model => model.id === "a/reasoning")!.reasoning).toBe(true);
    // Pi's level scale is constrained to the ladder: members map to themselves, everything
    // else (incl. minimal, which the Codex ladder has no equivalent for) is hidden.
    expect(models.find(model => model.id === "a/reasoning")!.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
    // The none sentinel maps pi's off level to "none" (the proxy omits the parameter);
    // minimal maps to itself.
    expect(models.find(model => model.id === "d/off")!.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
    // An ultra-only ladder has no exact pi level: pi's max maps to the only declared tier
    // so the model's sole reasoning level is actually selectable.
    const ultraOnly = piConfig(ctx({
      models: [{ namespaced: "e/ultra", provider: "e", id: "ultra", reasoningEfforts: ["ultra"] }],
    }));
    expect(ultraOnly.providers.opencodex!.models[0]!.thinkingLevelMap).toMatchObject({
      max: "ultra",
      off: null,
      minimal: null,
    });
    // An explicit empty ladder is the catalog's "no reasoning" statement; no boolean.
    expect(models.find(model => model.id === "b/none")).not.toHaveProperty("reasoning");
    expect(models.find(model => model.id === "c/plain")).not.toHaveProperty("reasoning");
  });

  test("contextWindow and maxTokens are omitted when the context window is unknown", () => {
    const entry = piConfig().providers.opencodex!.models.find(model => model.id === "custom/no-context")!;
    expect(entry).not.toHaveProperty("contextWindow");
    expect(entry).not.toHaveProperty("maxTokens");
    expect(entry).toEqual({ id: "custom/no-context", name: "no-context (custom)", input: ["text"] });
  });

  test("maxTokens uses the schema budget and clamps to a smaller context window", () => {
    const models = piConfig().providers.opencodex!.models;
    const large = models.find(model => model.id === "gpt-5.6-luna")!;
    expect(large.contextWindow).toBe(272_000);
    expect(large.maxTokens).toBe(SCHEMA_REQUIRED_OUTPUT_BUDGET);
    const small = models.find(model => model.id === "tiny/small-ctx")!;
    expect(small.contextWindow).toBe(8_000);
    expect(small.maxTokens).toBe(8_000);
  });

  test("input defaults to text and passes through declared modalities", () => {
    const config = piConfig(ctx({
      models: [
        { namespaced: "a/plain", provider: "a", id: "plain" },
        { namespaced: "b/multi", provider: "b", id: "multi", inputModalities: ["text", "image"] },
        { namespaced: "c/empty", provider: "c", id: "empty", inputModalities: [] },
      ],
    }));
    const models = config.providers.opencodex!.models;
    expect(models.find(model => model.id === "a/plain")!.input).toEqual(["text"]);
    expect(models.find(model => model.id === "b/multi")!.input).toEqual(["text", "image"]);
    expect(models.find(model => model.id === "c/empty")!.input).toEqual(["text"]);
  });

  test("Pi reuses the OpenCode label rule verbatim", () => {
    const piNames = piConfig().providers.opencodex!.models.map(model => model.name).sort();
    const opencodeNames = Object.values(opencodeConfig().provider.opencodex!.models)
      .map(entry => entry.name)
      .sort();
    expect(piNames).toEqual(opencodeNames);
  });
});

describe("OMP serializer", () => {
  test("writes the full routed catalog in OMP's models.yml provider shape", () => {
    const built = buildClientConfigText("omp", ctx());
    expect(built.format).toBe("yaml");
    const document = buildClientConfig("omp", ctx()) as PiGeneratedConfig;
    expect(document.providers.opencodex!.models.map(model => model.id)).toEqual([
      "anthropic/claude-opus-5",
      "custom/no-context",
      "gpt-5.6-luna",
      "tiny/small-ctx",
    ]);
    expect(built.text).toContain("providers:");
    expect(built.text).toContain("anthropic/claude-opus-5");
    expect(built.text).toContain("apiKey: opencodex-loopback");
  });

  test("keeps the provider on completions while opting native OpenAI models into Responses", () => {
    const models = [
      {
        namespaced: "gpt-5.6-terra",
        native: true,
        provider: "openai",
        id: "gpt-5.6-terra",
        contextWindow: 272_000,
        inputModalities: ["text", "image"],
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
      {
        namespaced: "command-code/muse-spark-1.2",
        provider: "command-code",
        id: "muse-spark-1.2",
        contextWindow: 128_000,
        reasoningEfforts: ["medium", "xhigh"],
      },
    ] satisfies ExportModel[];
    const document = buildClientConfig("omp", ctx({ models })) as {
      providers: { opencodex: { api: string; models: Array<Record<string, unknown>> } };
    };
    const provider = document.providers.opencodex;
    expect(provider.api).toBe("openai-completions");

    const native = provider.models.find(model => model.id === "gpt-5.6-terra")!;
    expect(native.api).toBe("openai-responses");
    expect(native.input).toEqual(["text", "image"]);
    expect(native.reasoning).toBe(true);
    expect(native.thinking).toEqual({ mode: "effort", efforts: ["low", "high"], defaultLevel: "high" });

    const routed = provider.models.find(model => model.id === "command-code/muse-spark-1.2")!;
    expect(routed).not.toHaveProperty("api");
  });

  test("emits OMP reasoning metadata only for the accepted effort vocabulary", () => {
    const document = buildClientConfig("omp", ctx({
      models: [{
        namespaced: "gpt-5.6-luna",
        native: true,
        provider: "openai",
        id: "gpt-5.6-luna",
        reasoningEfforts: [" LOW ", "high", "ultra", "none", "high"],
        defaultReasoningEffort: "ULTRA",
      }],
    })) as {
      providers: { opencodex: { models: Array<Record<string, unknown>> } };
    };
    const model = document.providers.opencodex.models[0]!;
    expect(model.reasoning).toBe(true);
    expect(model.thinking).toEqual({ mode: "effort", efforts: ["low", "high"] });
  });

  test("does not emit reasoning or thinking when no supported efforts are declared", () => {
    const document = buildClientConfig("omp", ctx({
      models: [{
        namespaced: "command-code/muse-spark-1.2",
        provider: "command-code",
        id: "muse-spark-1.2",
        reasoningEfforts: ["ultra", "none"],
      }],
    })) as {
      providers: { opencodex: { models: Array<Record<string, unknown>> } };
    };
    expect(document.providers.opencodex.models[0]).not.toHaveProperty("reasoning");
    expect(document.providers.opencodex.models[0]).not.toHaveProperty("thinking");
  });
});

describe("DSH rc.6 serializer", () => {
  test("owns only llm-pi-ai.providers.opencodex with a loopback Responses profile", () => {
    const document = dshConfig();
    expect(Object.keys(document)).toEqual(["llm-pi-ai"]);
    expect(Object.keys(document["llm-pi-ai"].providers)).toEqual(["opencodex"]);
    const provider = document["llm-pi-ai"].providers.opencodex!;
    expect(provider.displayName).toBe("OpenCodex");
    expect(provider.api).toBe("openai-responses");
    expect(provider.baseURL).toBe(BASE_URL);
    expect(provider.headers).toEqual({ Authorization: "Bearer ocx_data_dsh" });
    expect(provider).not.toHaveProperty("apiKeyEnv");
    expect(document).not.toHaveProperty("agent-default-model");
    expect(document).not.toHaveProperty("deepseek-official");
  });

  test("exports only representable modalities and authoritative context windows", () => {
    const document = dshConfig(ctx({
      models: [
        { namespaced: "a/unknown", provider: "a", id: "unknown", inputModalities: ["video"] },
        { namespaced: "a/mixed", provider: "a", id: "mixed", inputModalities: ["audio", "image", "image"] },
        { namespaced: "a/audio", provider: "a", id: "audio", inputModalities: ["audio"] },
        { namespaced: "a/context", provider: "a", id: "context", contextWindow: 128_000.9 },
        { namespaced: "a/fraction", provider: "a", id: "fraction", contextWindow: 0.5 },
        { namespaced: "a/zero", provider: "a", id: "zero", contextWindow: 0 },
      ],
    }));
    const models = document["llm-pi-ai"].providers.opencodex!.models;
    expect(models.map(model => model.id)).toEqual(["a/context", "a/fraction", "a/mixed", "a/unknown", "a/zero"]);
    expect(models.find(model => model.id === "a/unknown")?.input).toEqual(["text"]);
    expect(models.find(model => model.id === "a/mixed")?.input).toEqual(["image"]);
    expect(models.find(model => model.id === "a/context")?.contextWindow).toBe(128_000);
    expect(models.find(model => model.id === "a/fraction")).not.toHaveProperty("contextWindow");
    expect(models.find(model => model.id === "a/zero")).not.toHaveProperty("contextWindow");
    for (const model of models) expect(model).not.toHaveProperty("maxTokens");
  });

  test("maps only authoritative effort levels to DSH level-to-wire entries", () => {
    const document = dshConfig(ctx({
      models: [
        {
          namespaced: "a/reasoning",
          provider: "a",
          id: "reasoning",
          reasoningEfforts: ["off", "minimal", " LOW ", "medium", "high", "xhigh", "ultra", "unknown", "low"],
        },
        { namespaced: "a/ultra", provider: "a", id: "ultra", reasoningEfforts: ["ultra"] },
        { namespaced: "a/none", provider: "a", id: "none", reasoningEfforts: ["off", "minimal"] },
      ],
    }));
    const models = document["llm-pi-ai"].providers.opencodex!.models;
    expect(models.find(model => model.id === "a/reasoning")?.reasoningEfforts).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "ultra",
    });
    expect(models.find(model => model.id === "a/ultra")?.reasoningEfforts).toEqual({ max: "ultra" });
    expect(models.find(model => model.id === "a/none")).not.toHaveProperty("reasoningEfforts");
    expect(JSON.stringify(document)).toContain('"ultra"');
    expect(JSON.stringify(document)).not.toContain('"minimal"');
    expect(JSON.stringify(document)).not.toContain('"off"');
  });

  test("Direct drops native OpenAI and OpenAI-backed combos, failing closed on unknown combos", () => {
    const models: ExportModel[] = [
      { namespaced: "gpt-5.6-luna", provider: "openai", id: "gpt-5.6-luna", native: true },
      { namespaced: "openai/gpt-routed", provider: "openai", id: "gpt-routed" },
      { namespaced: "safe/model", provider: "safe", id: "model" },
      { namespaced: "combo/safe", provider: "combo", id: "safe" },
      { namespaced: "combo/mixed", provider: "combo", id: "mixed" },
      { namespaced: "combo/unknown", provider: "combo", id: "unknown" },
    ];
    const direct = cfg({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "direct" },
        safe: { adapter: "openai-chat", baseUrl: "https://safe.example/v1" },
      },
      combos: {
        safe: { targets: [{ provider: "safe", model: "model" }] },
        mixed: { targets: [{ provider: "safe", model: "model" }, { provider: "openai", model: "gpt-5.6-luna" }] },
      },
    });
    const ids = dshConfig(ctx({ models, config: direct }))["llm-pi-ai"].providers.opencodex!.models.map(model => model.id);
    expect(ids).toEqual(["combo/safe", "safe/model"]);

    const pool = cfg({ ...direct, providers: { ...direct.providers, openai: { ...direct.providers.openai!, codexAccountMode: "pool" } } });
    expect(dshConfig(ctx({ models, config: pool }))["llm-pi-ai"].providers.opencodex!.models).toHaveLength(models.length);
  });
});

describe("no credential ever reaches the output (accept criterion 3)", () => {
  const LIVE_KEY = "ocx_live_do_not_serialize_0123456789";

  test("neither serializer emits an ocx_ key even when one exists in config", () => {
    const withKey = cfg({ apiKeys: [{ key: LIVE_KEY }] } as Partial<OcxConfig>);
    const context = ctx({ config: withKey });
    for (const client of EXPORT_CLIENT_IDS) {
      const serialized = JSON.stringify(buildClientConfig(client, context));
      // DSH requires this fixed non-secret loopback bearer. Remove only that
      // exact placeholder before checking that no credential-shaped value leaked.
      expect(serialized.replaceAll("ocx_data_dsh", "")).not.toContain("ocx_");
      expect(serialized).not.toContain(LIVE_KEY);
    }
  });

  test("each client emits only its own documented env reference", () => {
    expect(JSON.stringify(opencodeConfig())).toContain(OPENCODE_API_KEY_ENV_REF);
    expect(JSON.stringify(piConfig())).toContain(LOOPBACK_API_KEY_PLACEHOLDER);
    expect(JSON.stringify(piConfig())).not.toContain("{env:");
  });
});

describe("stable ordering (accept criterion 4)", () => {
  const shuffled: ExportModel[] = [FIXTURE[3]!, FIXTURE[1]!, FIXTURE[0]!, FIXTURE[2]!];

  test("shuffled input produces byte-identical output for both clients", () => {
    for (const client of EXPORT_CLIENT_IDS) {
      const first = JSON.stringify(buildClientConfig(client, ctx()));
      const second = JSON.stringify(buildClientConfig(client, ctx({ models: shuffled })));
      expect(second).toBe(first);
    }
  });

  test("repeated calls with the same input are byte-identical", () => {
    for (const client of EXPORT_CLIENT_IDS) {
      expect(JSON.stringify(buildClientConfig(client, ctx()))).toBe(JSON.stringify(buildClientConfig(client, ctx())));
    }
  });

  test("normalizeExportModels dedupes by namespaced with first-wins and sorts", () => {
    const normalized = normalizeExportModels([
      { namespaced: "z/last", provider: "z", id: "last" },
      { namespaced: "a/dup", provider: "a", id: "dup", displayName: "First wins" },
      { namespaced: "a/dup", provider: "a", id: "dup", displayName: "Second loses" },
    ]);
    expect(normalized.map(model => model.namespaced)).toEqual(["a/dup", "z/last"]);
    expect(normalized[0]!.displayName).toBe("First wins");
  });

  test("a duplicate namespaced row is emitted once by both serializers", () => {
    const dupes = ctx({
      models: [
        { namespaced: "gpt-5.6-luna", native: true, provider: "openai", id: "gpt-5.6-luna", contextWindow: 272_000 },
        { namespaced: "gpt-5.6-luna", provider: "openai", id: "gpt-5.6-luna", displayName: "Shadow" },
      ],
    });
    expect(Object.keys(opencodeConfig(dupes).provider.opencodex!.models)).toEqual(["gpt-5.6-luna"]);
    expect(piConfig(dupes).providers.opencodex!.models).toHaveLength(1);
    expect(piConfig(dupes).providers.opencodex!.models[0]!.name).toBe("gpt-5.6-luna (native)");
  });
});

describe("EXPORT_CLIENTS registry", () => {
  test("covers exactly the eleven file-toggle clients", () => {
    expect(EXPORT_CLIENT_IDS).toEqual(["opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "prime"]);
    for (const id of EXPORT_CLIENT_IDS) expect(isExportClientId(id)).toBe(true);
    // The exception clients keep their own surfaces and are not export clients.
    expect(isExportClientId("claude-desktop")).toBe(false);
    expect(isExportClientId("grok")).toBe(false);
  });

  /**
   * Full-text goldens, not field spot-checks. Adding four clients must not move
   * a single byte for the two that already shipped — indentation and the one
   * trailing newline included — and only a fixed expected string proves that.
   */
  test("opencode bytes are unchanged, to the last newline", () => {
    const built = buildClientConfigText("opencode", ctx({ config: cfg() }));
    expect(built.format).toBe("json");
    expect(built.text).toBe(`{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencodex": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCodex",
      "options": {
        "baseURL": "http://127.0.0.1:10100/v1",
        "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
      },
      "models": {
        "anthropic/claude-opus-5": {
          "name": "Claude Opus 5 (anthropic)",
          "limit": {
            "context": 200000,
            "output": 32000
          }
        },
        "custom/no-context": {
          "name": "no-context (custom)"
        },
        "gpt-5.6-luna": {
          "name": "gpt-5.6-luna (native)",
          "limit": {
            "context": 272000,
            "output": 32000
          }
        },
        "tiny/small-ctx": {
          "name": "small-ctx (tiny)",
          "limit": {
            "context": 8000,
            "output": 8000
          }
        }
      }
    }
  }
}
`);
  });

  test("pi bytes are unchanged, to the last newline", () => {
    const built = buildClientConfigText("pi", ctx({ config: cfg() }));
    expect(built.format).toBe("json");
    expect(built.text).toBe(`{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": [
            "text"
          ],
          "contextWindow": 200000,
          "maxTokens": 32000
        },
        {
          "id": "custom/no-context",
          "name": "no-context (custom)",
          "input": [
            "text"
          ]
        },
        {
          "id": "gpt-5.6-luna",
          "name": "gpt-5.6-luna (native)",
          "input": [
            "text"
          ],
          "contextWindow": 272000,
          "maxTokens": 32000
        },
        {
          "id": "tiny/small-ctx",
          "name": "small-ctx (tiny)",
          "input": [
            "text"
          ],
          "contextWindow": 8000,
          "maxTokens": 8000
        }
      ]
    }
  }
}
`);
  });

  test("every spec declares a format, a summarizer and a contribution", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      const spec = EXPORT_CLIENTS[id];
      expect(["json", "yaml", "toml", "json5"]).toContain(spec.format);
      expect(typeof spec.summarize).toBe("function");
      expect(typeof spec.buildContribution).toBe("function");
      // The filename's extension must match the declared format, so a reader
      // never has to guess which one is authoritative.
      const extension = spec.filename.slice(spec.filename.lastIndexOf(".") + 1);
      expect(extension).toBe(spec.format);
    }
  });

  test("each spec's id matches its registry key", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      expect(EXPORT_CLIENTS[id].id).toBe(id);
    }
  });

  test("every filename's extension matches its declared format", () => {
    const extensionFor = { json: "json", yaml: "yaml", toml: "toml", json5: "json5" } as const;
    for (const id of EXPORT_CLIENT_IDS) {
      const spec = EXPORT_CLIENTS[id];
      expect(spec.filename.endsWith(`.${extensionFor[spec.format]}`)).toBe(true);
    }
  });

  test("every spec can summarize its own document and name its fragments", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      expect(typeof EXPORT_CLIENTS[id].summarize).toBe("function");
      expect(typeof EXPORT_CLIENTS[id].buildContribution).toBe("function");
    }
  });

  test("filenames name the destination file, not the product", () => {
    expect(EXPORT_CLIENTS.opencode.filename).toBe("opencode.json");
    expect(EXPORT_CLIENTS.pi.filename).toBe("pi-models.json");
    expect(EXPORT_CLIENTS.omp.filename).toBe("omp-models.yaml");
    expect(EXPORT_CLIENTS.hermes.filename).toBe("hermes-config.yaml");
    expect(EXPORT_CLIENTS.openclaw.filename).toBe("openclaw.json5");
    expect(EXPORT_CLIENTS.kimi.filename).toBe("kimi-config.toml");
    expect(EXPORT_CLIENTS.gajae.filename).toBe("gajae-models.yaml");
    expect(EXPORT_CLIENTS.mcode.filename).toBe("mcode-config.yaml");
    expect(EXPORT_CLIENTS.zcode.filename).toBe("config.json");
  });

  test("the opencode destination reuses the launcher's XDG resolution", () => {
    const xdg = { XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv;
    expect(EXPORT_CLIENTS.opencode.destination(xdg)).toBe(opencodeGlobalConfigPath(xdg));
    expect(EXPORT_CLIENTS.opencode.destination(xdg)).toBe(join("/xdg", "opencode", "opencode.json"));
    const noXdg = {} as NodeJS.ProcessEnv;
    expect(EXPORT_CLIENTS.opencode.destination(noXdg)).toBe(join(homedir(), ".config", "opencode", "opencode.json"));
  });

  test("the pi destination is the documented global models file", () => {
    expect(EXPORT_CLIENTS.pi.destination({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".pi", "agent", "models.json"));
  });

  test("the OMP destination follows its global agent directory and profile selectors", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-omp-destination-"));
    try {
      const defaultAgentDir = join(home, ".omp", "agent");
      expect(ompModelsConfigPath({} as NodeJS.ProcessEnv, home)).toBe(join(defaultAgentDir, "models.yml"));

      mkdirSync(defaultAgentDir, { recursive: true });
      writeFileSync(join(defaultAgentDir, "models.yaml"), "providers: {}\n");
      expect(ompModelsConfigPath({} as NodeJS.ProcessEnv, home)).toBe(join(defaultAgentDir, "models.yaml"));
      writeFileSync(join(defaultAgentDir, "models.yml"), "providers: {}\n");
      expect(ompModelsConfigPath({} as NodeJS.ProcessEnv, home)).toBe(join(defaultAgentDir, "models.yml"));

      const configDir = "custom-omp";
      const configRoot = join(home, configDir);
      const profiled = { OMP_PROFILE: "work", PI_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
      expect(ompModelsConfigPath(profiled, home)).toBe(
        join(configRoot, "profiles", "work", "agent", "models.yml"),
      );
      expect(ompModelsConfigPath({ PI_CONFIG_DIR: configDir } as NodeJS.ProcessEnv, home)).toBe(
        join(configRoot, "agent", "models.yml"),
      );
      expect(ompModelsConfigPath({ PI_PROFILE: "legacy", PI_CONFIG_DIR: configDir } as NodeJS.ProcessEnv, home)).toBe(
        join(configRoot, "profiles", "legacy", "agent", "models.yml"),
      );
      // OMP_PROFILE wins by presence, so an explicit blank selects the default
      // profile instead of inheriting a legacy PI_PROFILE.
      expect(ompModelsConfigPath({
        OMP_PROFILE: "  ",
        PI_PROFILE: "legacy",
        PI_CONFIG_DIR: configDir,
      } as NodeJS.ProcessEnv, home)).toBe(
        join(configRoot, "agent", "models.yml"),
      );
      expect(() => ompModelsConfigPath({ OMP_PROFILE: ".." } as NodeJS.ProcessEnv, home)).toThrow(ClientPathError);
      expect(() => ompModelsConfigPath({ OMP_PROFILE: "NUL.txt" } as NodeJS.ProcessEnv, home)).toThrow(ClientPathError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("apiKeyEnv and exportHint name the variable the config references", () => {
    expect(EXPORT_CLIENTS.opencode.apiKeyEnv).toBe(OPENCODE_API_KEY_ENV);
    expect(EXPORT_CLIENTS.opencode.exportHint).toContain(OPENCODE_API_KEY_ENV);
    expect(EXPORT_CLIENTS.pi.apiKeyEnv).toBe("");
    expect(EXPORT_CLIENTS.pi.exportHint).toContain("loopback");
    for (const id of EXPORT_CLIENT_IDS) {
      expect(EXPORT_CLIENTS[id].exportHint).not.toContain("ocx_");
    }
  });

  test("build() on a spec matches buildClientConfig for the same context", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      expect(JSON.stringify(EXPORT_CLIENTS[id].build(ctx()))).toBe(JSON.stringify(buildClientConfig(id, ctx())));
    }
  });

  test("an empty catalog still yields a structurally valid document", () => {
    const empty = ctx({ models: [] });
    expect(opencodeConfig(empty).provider.opencodex!.models).toEqual({});
    expect(piConfig(empty).providers.opencodex!.models).toEqual([]);
  });
});
