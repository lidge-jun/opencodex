import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  GAJAE_API_KEY_ENV,
  HERMES_API_KEY_ENV_REF,
  KIMI_LOOPBACK_PLACEHOLDER,
  OPENCLAW_API_KEY_ENV_REF,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  gajaeConfigPath,
  hermesConfigPath,
  kimiConfigPath,
  type ExportContext,
  type ExportModel,
  type GajaeGeneratedConfig,
  type HermesGeneratedConfig,
  type KimiGeneratedConfig,
  type OpenclawGeneratedConfig,
} from "../src/clients/config-export";
import type { OcxConfig } from "../src/types";

/**
 * WP1 coverage for the four clients added past OpenCode and Pi
 * (devlog/_plan/260802_client_toggle_api/010 §5, 011 §2).
 *
 * The no-secret assertions are the release-blocking ones: a config we generate
 * must carry an environment reference or a loopback placeholder, never a key.
 */
// Assembled at runtime: privacy:scan flags token-shaped literals anywhere in
// the tree, and a fixture is not a reason to commit one.
const SECRET = ["sk", "test", "DO", "NOT", "SERIALIZE", "0123456789"].join("-");

const LOOPBACK: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
  apiKeys: [{ key: SECRET }],
} as unknown as OcxConfig;

const REMOTE: OcxConfig = { ...LOOPBACK, hostname: "0.0.0.0" } as OcxConfig;

const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000, displayName: "Claude Opus 4.8" },
  { namespaced: "gpt-5.5", provider: "openai", id: "gpt-5.5", native: true, contextWindow: 400_000 },
  { namespaced: "local/no-window", provider: "local", id: "no-window" },
];

function ctx(config: OcxConfig = LOOPBACK): ExportContext {
  return { baseUrl: "http://127.0.0.1:10100/v1", models: MODELS, config };
}

describe("no secret reaches a client config", () => {
  test("a client is loopback-only exactly when it has nowhere to put the admission header", () => {
    // /v1/chat/completions rejects bearer credentials and requires the
    // dedicated x-opencodex-api-key header (AUTH_MATRIX in auth-cors.ts), so a
    // client whose schema has no header field cannot authenticate remotely at
    // all. Saying so beats exporting a config that 401s.
    const loopbackOnly = EXPORT_CLIENT_IDS.filter(id => EXPORT_CLIENTS[id].loopbackOnly);
    expect(loopbackOnly).toEqual(["pi", "kimi", "gajae"]);
  });

  test("every client that is not loopback-only carries the header on a remote bind", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      if (EXPORT_CLIENTS[id].loopbackOnly) continue;
      const { text } = buildClientConfigText(id, ctx(REMOTE));
      expect(text).toContain("x-opencodex-api-key");
    }
  });

  test("every client's bytes carry a reference or placeholder, never the key", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      const { text } = buildClientConfigText(id, ctx());
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("sk-");
    }
  });

  test("even a non-loopback bind never serializes the key", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      const { text } = buildClientConfigText(id, ctx(REMOTE));
      expect(text).not.toContain(SECRET);
    }
  });
});

describe("hermes", () => {
  test("emits an env reference and our selectors, and never the user's default model", () => {
    const doc = buildClientConfig("hermes", ctx()) as HermesGeneratedConfig;
    const block = doc.providers[OPENCODE_PROVIDER_ID]!;
    expect(block.api_key).toBe(HERMES_API_KEY_ENV_REF);
    expect(block.api_mode).toBe("chat_completions");
    expect(block.discover_models).toBe(false);
    expect(block.models).toEqual(["anthropic/claude-opus-4-8", "gpt-5.5", "local/no-window"]);
    expect(doc).not.toHaveProperty("model");
  });

  test("a non-loopback bind adds the admission header, loopback does not", () => {
    const loopback = buildClientConfig("hermes", ctx()) as HermesGeneratedConfig;
    expect(loopback.providers[OPENCODE_PROVIDER_ID]!.extra_headers).toBeUndefined();
    const remote = buildClientConfig("hermes", ctx(REMOTE)) as HermesGeneratedConfig;
    expect(remote.providers[OPENCODE_PROVIDER_ID]!.extra_headers).toEqual({
      "x-opencodex-api-key": HERMES_API_KEY_ENV_REF,
    });
  });

  test("HERMES_HOME wins over the platform default", () => {
    // `join` rather than a literal: the claim is that the override wins, and
    // spelling the separator by hand asserted POSIX layout instead — which is
    // false on Windows, where the same call returns backslashes.
    expect(hermesConfigPath({ HERMES_HOME: "/tmp/h" }, "/home/u")).toBe(join("/tmp/h", "config.yaml"));
  });
});

describe("openclaw", () => {
  test("merges with the bundled catalog and omits a window it cannot assert", () => {
    const doc = buildClientConfig("openclaw", ctx()) as OpenclawGeneratedConfig;
    expect(doc.models.mode).toBe("merge");
    const block = doc.models.providers[OPENCODE_PROVIDER_ID]!;
    expect(block.apiKey).toBe(OPENCLAW_API_KEY_ENV_REF);
    expect(block.api).toBe("openai-completions");
    expect(block.models.find(m => m.id === "local/no-window")).not.toHaveProperty("contextWindow");
    expect(block.models.find(m => m.id === "gpt-5.5")?.contextWindow).toBe(400_000);
    // agents.defaults is deliberately absent: we do not pick the user's model.
    expect(doc).not.toHaveProperty("agents");
  });
});

describe("kimi", () => {
  test("omits models with no authoritative window rather than guessing one", () => {
    const doc = buildClientConfig("kimi", ctx()) as KimiGeneratedConfig;
    const aliases = Object.keys(doc.models);
    expect(aliases).toEqual([`${OPENCODE_PROVIDER_ID}/anthropic/claude-opus-4-8`, `${OPENCODE_PROVIDER_ID}/gpt-5.5`]);
    for (const block of Object.values(doc.models)) {
      expect(block.max_context_size).toBeGreaterThan(0);
    }
    // The provider table survives even though one model was dropped.
    expect(doc.providers[OPENCODE_PROVIDER_ID]!.type).toBe("openai");
  });

  test("uses the loopback placeholder because Kimi reads no environment", () => {
    const doc = buildClientConfig("kimi", ctx()) as KimiGeneratedConfig;
    expect(doc.providers[OPENCODE_PROVIDER_ID]!.api_key).toBe(KIMI_LOOPBACK_PLACEHOLDER);
  });

  test("never emits capabilities it cannot assert", () => {
    const { text } = buildClientConfigText("kimi", ctx());
    expect(text).not.toContain("capabilities");
  });

  test("KIMI_CODE_HOME wins over the default", () => {
    expect(kimiConfigPath({ KIMI_CODE_HOME: "/tmp/k" }, "/home/u")).toBe(join("/tmp/k", "config.toml"));
  });
});

describe("gajae", () => {
  test("uses apiKeyEnv, never apiKey, and emits only schema-known fields", () => {
    const doc = buildClientConfig("gajae", ctx()) as GajaeGeneratedConfig;
    const block = doc.providers[OPENCODE_PROVIDER_ID]!;
    expect(block.apiKeyEnv).toBe(GAJAE_API_KEY_ENV);
    expect(block).not.toHaveProperty("apiKey");
    expect(Object.keys(block).sort()).toEqual(["api", "apiKeyEnv", "baseUrl", "models"]);
    const allowed = new Set(["id", "name", "input", "contextWindow", "maxTokens"]);
    for (const model of block.models) {
      for (const key of Object.keys(model)) expect(allowed.has(key)).toBe(true);
    }
  });

  test("the destination is the documented models file", () => {
    expect(gajaeConfigPath({}, "/home/u")).toBe(join("/home/u", ".gjc", "agent", "models.yml"));
  });
});

describe("contributions name every fragment we own", () => {
  test("single-entry clients own exactly one path", () => {
    for (const id of ["opencode", "pi", "hermes", "openclaw", "gajae"] as const) {
      expect(buildClientContribution(id, ctx()).fragments).toHaveLength(1);
    }
  });

  test("kimi owns its provider block AND one entry per emitted model", () => {
    const contribution = buildClientContribution("kimi", ctx());
    expect(contribution.fragments.map(f => f.path)).toEqual([
      ["providers", OPENCODE_PROVIDER_ID],
      ["models", `${OPENCODE_PROVIDER_ID}/anthropic/claude-opus-4-8`],
      ["models", `${OPENCODE_PROVIDER_ID}/gpt-5.5`],
    ]);
  });

  test("a contribution's fragments match the document the builder produced", () => {
    const doc = buildClientConfig("openclaw", ctx()) as OpenclawGeneratedConfig;
    const [fragment] = buildClientContribution("openclaw", ctx()).fragments;
    expect(fragment!.value).toEqual(doc.models.providers[OPENCODE_PROVIDER_ID]);
  });
});

describe("serialized bytes", () => {
  test("every client round-trips through its own format's parser", () => {
    const parsers = {
      json: (t: string) => JSON.parse(t),
      json5: (t: string) => Bun.JSON5.parse(t),
      yaml: (t: string) => Bun.YAML.parse(t),
      toml: (t: string) => Bun.TOML.parse(t),
    } as const;
    for (const id of EXPORT_CLIENT_IDS) {
      const built = buildClientConfigText(id, ctx());
      expect(parsers[built.format](built.text)).toEqual(built.document as never);
    }
  });

  test("bytes are stable across identical calls", () => {
    for (const id of EXPORT_CLIENT_IDS) {
      expect(buildClientConfigText(id, ctx()).text).toBe(buildClientConfigText(id, ctx()).text);
    }
  });
});
