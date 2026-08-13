import { describe, expect, test } from "bun:test";
import {
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  GAJAE_API_KEY_ENV,
  HERMES_API_KEY_ENV_REF,
  LOOPBACK_API_KEY_PLACEHOLDER,
  OPENCLAW_API_KEY_ENV_REF,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  kimiModelAlias,
  type ExportContext,
  type ExportModel,
  type GajaeGeneratedConfig,
  type HermesGeneratedConfig,
  type KimiGeneratedConfig,
  type OpenclawGeneratedConfig,
} from "../src/clients/config-export";
import { serializeDocument } from "../src/integrations/serialize";
import type { OcxConfig } from "../src/types";

/**
 * Activation coverage for the four clients added in WP1
 * (devlog/_fin/260802_client_toggle_api/010 §2.4, 011 §3).
 */
const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000, displayName: "Claude Opus 4.8" },
  { namespaced: "gpt-5.5", provider: "openai", id: "gpt-5.5", native: true, contextWindow: 400_000 },
  // No authoritative context window: the "never guess metadata" case.
  { namespaced: "mystery/model", provider: "mystery", id: "model" },
];

const LOOPBACK: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

function ctx(config: OcxConfig = LOOPBACK): ExportContext {
  return { baseUrl: "http://127.0.0.1:10100/v1", models: MODELS, config };
}

describe("no client config ever carries a credential", () => {
  // Assembled rather than written out: privacy:scan flags token-shaped literals,
  // and it is right to — a fixture is not a reason to commit one.
  const SENTINEL = ["sk", "live", "do", "not", "serialize", "me"].join("-");
  const withKey = { ...LOOPBACK, apiKeys: [{ key: SENTINEL }] } as OcxConfig;

  test.each(EXPORT_CLIENT_IDS)("%s emits a reference or a placeholder, never a key", clientId => {
    const spec = EXPORT_CLIENTS[clientId];
    const text = serializeDocument(buildClientConfig(clientId, ctx(withKey)), spec.format);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(SENTINEL.slice(0, 3));
  });

  test("kimi uses the loopback placeholder because it cannot read env vars", () => {
    const doc = buildClientConfig("kimi", ctx()) as KimiGeneratedConfig;
    expect(doc.providers[OPENCODE_PROVIDER_ID]!.api_key).toBe(LOOPBACK_API_KEY_PLACEHOLDER);
  });

  test("gajae uses apiKeyEnv, not the apiKey footgun", () => {
    const doc = buildClientConfig("gajae", ctx()) as GajaeGeneratedConfig;
    const provider = doc.providers[OPENCODE_PROVIDER_ID]!;
    expect(provider.apiKeyEnv).toBe(GAJAE_API_KEY_ENV);
    // `apiKey` would fall back to treating the literal name as the token.
    expect(provider).not.toHaveProperty("apiKey");
  });
});

describe("hermes", () => {
  test("emits only the provider entry, never the user's default model", () => {
    const doc = buildClientConfig("hermes", ctx()) as HermesGeneratedConfig;
    expect(Object.keys(doc)).toEqual(["providers"]);
    const provider = doc.providers[OPENCODE_PROVIDER_ID]!;
    expect(provider.api_key).toBe(HERMES_API_KEY_ENV_REF);
    expect(provider.api_mode).toBe("chat_completions");
    expect(provider.discover_models).toBe(false);
    expect(provider.models).toEqual(["anthropic/claude-opus-4-8", "gpt-5.5", "mystery/model"]);
  });

  test("adds the admission header only on a non-loopback bind", () => {
    const loopback = buildClientConfig("hermes", ctx()) as HermesGeneratedConfig;
    expect(loopback.providers[OPENCODE_PROVIDER_ID]!.extra_headers).toBeUndefined();

    const remote = buildClientConfig("hermes", ctx({ ...LOOPBACK, hostname: "0.0.0.0" } as OcxConfig)) as HermesGeneratedConfig;
    expect(remote.providers[OPENCODE_PROVIDER_ID]!.extra_headers).toEqual({
      "x-opencodex-api-key": HERMES_API_KEY_ENV_REF,
    });
  });
});

describe("openclaw", () => {
  test("merges with the bundled catalog rather than replacing it", () => {
    const doc = buildClientConfig("openclaw", ctx()) as OpenclawGeneratedConfig;
    expect(doc.models.mode).toBe("merge");
    const provider = doc.models.providers[OPENCODE_PROVIDER_ID]!;
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe(OPENCLAW_API_KEY_ENV_REF);
    expect(provider.models.map(m => m.id)).toEqual(["anthropic/claude-opus-4-8", "gpt-5.5", "mystery/model"]);
    // A model with no authoritative window ships without one, not with a guess.
    expect(provider.models.find(m => m.id === "mystery/model")).not.toHaveProperty("contextWindow");
  });
});

describe("kimi", () => {
  test("omits a model with no authoritative context window entirely", () => {
    const doc = buildClientConfig("kimi", ctx()) as KimiGeneratedConfig;
    // max_context_size is mandatory and positive, so the model is left out
    // rather than shipped with an invented number.
    expect(Object.keys(doc.models)).toEqual([
      kimiModelAlias("anthropic/claude-opus-4-8"),
      kimiModelAlias("gpt-5.5"),
    ]);
    // Dropping models never drops the provider block.
    expect(doc.providers[OPENCODE_PROVIDER_ID]!.type).toBe("openai");
  });

  test("never asserts capabilities it cannot know", () => {
    const doc = buildClientConfig("kimi", ctx()) as KimiGeneratedConfig;
    for (const model of Object.values(doc.models)) {
      expect(model).not.toHaveProperty("capabilities");
    }
  });

  test("its document round-trips through the TOML parser", () => {
    const text = serializeDocument(buildClientConfig("kimi", ctx()), "toml");
    expect(Bun.TOML.parse(text)).toEqual(buildClientConfig("kimi", ctx()) as Record<string, unknown>);
  });
});

describe("gajae", () => {
  test("emits only schema-known fields, because unknown ones fail validation", () => {
    const doc = buildClientConfig("gajae", ctx()) as GajaeGeneratedConfig;
    const provider = doc.providers[OPENCODE_PROVIDER_ID]!;
    expect(Object.keys(provider).sort()).toEqual(["api", "apiKeyEnv", "baseUrl", "models"]);
    for (const model of provider.models) {
      for (const key of Object.keys(model)) {
        expect(["id", "name", "input", "contextWindow", "maxTokens"]).toContain(key);
      }
    }
  });
});

describe("contributions describe what a writer would own", () => {
  test("kimi owns its provider entry AND one model entry per emitted model", () => {
    const contribution = EXPORT_CLIENTS.kimi.buildContribution(ctx());
    const paths = contribution.fragments.map(f => f.path.join("."));
    expect(paths).toContain(`providers.${OPENCODE_PROVIDER_ID}`);
    expect(paths).toContain(`models.${kimiModelAlias("anthropic/claude-opus-4-8")}`);
    expect(paths).toContain(`models.${kimiModelAlias("gpt-5.5")}`);
    // The omitted model is not owned either — ownership follows what we wrote.
    expect(paths).not.toContain(`models.${kimiModelAlias("mystery/model")}`);
  });

  test("every client's fragments point at real entries in its own document", () => {
    for (const clientId of EXPORT_CLIENT_IDS) {
      const document = buildClientConfig(clientId, ctx()) as Record<string, unknown>;
      for (const fragment of EXPORT_CLIENTS[clientId].buildContribution(ctx()).fragments) {
        let cursor: unknown = document;
        for (const key of fragment.path) {
          expect(cursor && typeof cursor === "object").toBe(true);
          cursor = (cursor as Record<string, unknown>)[key];
        }
        expect(cursor).toEqual(fragment.value);
      }
    }
  });
});

describe("summarizers describe the bytes the user receives", () => {
  test("each client counts its own document shape", () => {
    for (const clientId of EXPORT_CLIENT_IDS) {
      const summary = EXPORT_CLIENTS[clientId].summarize(buildClientConfig(clientId, ctx()));
      expect(summary.modelCount).toBeGreaterThan(0);
      expect(summary.modelsWithoutLimits).toBeGreaterThanOrEqual(0);
      expect(summary.modelsWithoutLimits).toBeLessThanOrEqual(summary.modelCount);
    }
  });

  test("kimi reports only the models that survived the omission rule", () => {
    const summary = EXPORT_CLIENTS.kimi.summarize(buildClientConfig("kimi", ctx()));
    expect(summary.modelCount).toBe(2);
    expect(summary.modelsWithoutLimits).toBe(0);
  });
});
