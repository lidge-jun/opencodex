import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  OPENCODE_API_KEY_ENV,
  OPENCODE_API_KEY_ENV_REF,
  PI_API_KEY_ENV,
  PI_API_KEY_ENV_REF,
  SCHEMA_REQUIRED_OUTPUT_BUDGET,
  buildClientConfig,
  isExportClientId,
  normalizeExportModels,
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

  test("provider envelope names the OpenAI-compatible dialect and the env reference", () => {
    const provider = piConfig().providers.opencodex!;
    expect(provider.baseUrl).toBe(BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe(PI_API_KEY_ENV_REF);
    expect(provider.apiKey).toBe("$OPENCODEX_API_KEY");
  });

  test("cost is omitted on every entry — zeros would assert routed models are free", () => {
    for (const model of piConfig().providers.opencodex!.models) {
      expect(model).not.toHaveProperty("cost");
    }
    expect(JSON.stringify(piConfig())).not.toContain("cost");
  });

  test("reasoning is omitted — an effort list is not Pi's boolean", () => {
    for (const model of piConfig().providers.opencodex!.models) {
      expect(model).not.toHaveProperty("reasoning");
    }
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

describe("no credential ever reaches the output (accept criterion 3)", () => {
  const LIVE_KEY = "ocx_live_do_not_serialize_0123456789";

  test("neither serializer emits an ocx_ key even when one exists in config", () => {
    const withKey = cfg({ apiKeys: [{ key: LIVE_KEY }] } as Partial<OcxConfig>);
    const context = ctx({ config: withKey });
    for (const client of EXPORT_CLIENT_IDS) {
      const serialized = JSON.stringify(buildClientConfig(client, context));
      expect(serialized).not.toContain("ocx_");
      expect(serialized).not.toContain(LIVE_KEY);
    }
  });

  test("each client emits only its own documented env reference", () => {
    expect(JSON.stringify(opencodeConfig())).toContain(OPENCODE_API_KEY_ENV_REF);
    expect(JSON.stringify(piConfig())).toContain(PI_API_KEY_ENV_REF);
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
  test("covers exactly the two supported clients", () => {
    expect(EXPORT_CLIENT_IDS).toEqual(["opencode", "pi"]);
    expect(isExportClientId("opencode")).toBe(true);
    expect(isExportClientId("pi")).toBe(true);
    expect(isExportClientId("claude-desktop")).toBe(false);
  });

  test("each spec's id matches its registry key", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      expect(EXPORT_CLIENTS[id].id).toBe(id);
    }
  });

  test("filenames name the destination file, not the product", () => {
    expect(EXPORT_CLIENTS.opencode.filename).toBe("opencode.json");
    expect(EXPORT_CLIENTS.pi.filename).toBe("pi-models.json");
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

  test("apiKeyEnv and exportHint name the variable the config references", () => {
    expect(EXPORT_CLIENTS.opencode.apiKeyEnv).toBe(OPENCODE_API_KEY_ENV);
    expect(EXPORT_CLIENTS.opencode.exportHint).toContain(OPENCODE_API_KEY_ENV);
    expect(EXPORT_CLIENTS.pi.apiKeyEnv).toBe(PI_API_KEY_ENV);
    expect(EXPORT_CLIENTS.pi.exportHint).toContain(PI_API_KEY_ENV);
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
