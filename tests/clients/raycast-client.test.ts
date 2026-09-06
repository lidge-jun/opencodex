import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_CLIENTS,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  raycastAiDir,
  raycastConfigPath,
  type ExportContext,
  type ExportModel,
  type RaycastGeneratedConfig,
} from "../../src/clients/config-export";
import { exportPresentationLabel } from "../../src/clients/model-presentation";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CONFIG = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

// One model per cell of the vision x reasoning matrix, so every ability
// branch is exercised by a row that differs from its neighbours in one axis.
const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000, inputModalities: ["text", "image"] },
  { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000, reasoningEfforts: ["low", "medium", "high"] },
  { namespaced: "mystery/model", provider: "mystery", id: "model" },
  { namespaced: "google/gemini-3-pro", provider: "google", id: "gemini-3-pro", contextWindow: 1_048_576, inputModalities: ["text", "image"], reasoningEfforts: ["low", "high"] },
];

function context(models: readonly ExportModel[] = MODELS): ExportContext {
  return { baseUrl: "http://127.0.0.1:10100/v1", config: CONFIG, models };
}

// A provider the user wrote by hand: the merge must carry it through every
// apply, refresh and disable untouched.
const LMSTUDIO = { id: "lmstudio", name: "LM Studio", base_url: "http://localhost:1234/v1", models: [] };
const USER_SEED = [
  "providers:",
  "  - id: lmstudio",
  "    name: LM Studio",
  "    base_url: http://localhost:1234/v1",
  "    models: []",
  "",
].join(String.fromCharCode(10));

function ourProvider(document: RaycastGeneratedConfig) {
  return document.providers.find(provider => provider.id === OPENCODE_PROVIDER_ID)!;
}

function abilitiesOf(document: RaycastGeneratedConfig, id: string): Record<string, boolean> {
  const model = ourProvider(document).models.find(entry => entry.id === id)!;
  return Object.fromEntries(Object.entries(model.abilities).map(([name, ability]) => [name, ability.supported]));
}

let home: string;
let store: IntegrationStateStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-raycast-"));
  store = createIntegrationStateStore(mkdtempSync(join(tmpdir(), "ocx-raycast-store-")));
});

afterEach(() => {
  removeTreeWithRetry(home);
});

/** Raycast "installed" for our purposes: the `ai` directory exists. */
function installRaycast(seed?: string): string {
  const spec = INTEGRATION_CLIENTS.raycast;
  mkdirSync(spec.detectDir({}, home), { recursive: true });
  const configPath = spec.configPath({}, home);
  if (seed !== undefined) writeFileSync(configPath, seed);
  return configPath;
}

function readProviders(configPath: string): RaycastGeneratedConfig {
  return Bun.YAML.parse(readFileSync(configPath, "utf8")) as RaycastGeneratedConfig;
}

function request(models: readonly ExportModel[] = MODELS) {
  return { clientId: "raycast" as const, models, config: CONFIG, port: 10100, env: {}, home, store };
}

describe("Raycast client config", () => {
  /*
   * The shape is Raycast's, not ours: `providers` is a SEQUENCE, `base_url`
   * ends in `/v1` without `/chat/completions`, and there is no `api_keys` at
   * all because a loopback bind is unauthenticated. Every model carries all
   * five abilities so Raycast never has to guess at a missing one.
   */
  test("emits one provider element with the documented field vocabulary", () => {
    const document = buildClientConfig("raycast", context()) as RaycastGeneratedConfig;
    expect(Object.keys(document)).toEqual(["providers"]);
    expect(document.providers.map(provider => provider.id)).toEqual([OPENCODE_PROVIDER_ID]);

    const provider = ourProvider(document);
    expect(Object.keys(provider)).toEqual(["id", "name", "base_url", "models"]);
    expect(provider.name).toBe("OpenCodex");
    expect(provider.base_url).toBe("http://127.0.0.1:10100/v1");
    expect(Object.keys(provider)).not.toContain("api_keys");

    for (const model of provider.models) {
      expect(Object.keys(model.abilities)).toEqual(["temperature", "vision", "system_message", "tools", "reasoning_effort"]);
    }
    const claude = provider.models.find(model => model.id === "anthropic/claude-opus-5")!;
    // Raycast shows `name` verbatim with no provider suffix; capability tables
    // supply the product label when ExportModel has no operator override.
    expect(claude.name).toBe("Claude Opus 5");
    expect(claude.context).toBe(200_000);
    // No authoritative window means the key is absent, not zero or null.
    const unknown = provider.models.find(model => model.id === "mystery/model")!;
    expect("context" in unknown).toBe(false);
  });

  test("uses product labels instead of raw slugs or provider suffixes", () => {
    expect(exportPresentationLabel({
      namespaced: "anthropic/claude-fable-5-1", provider: "anthropic", id: "claude-fable-5-1",
    })).toBe("Claude Fable 5.1");
    expect(exportPresentationLabel({
      namespaced: "cursor/composer-2.5", provider: "cursor", id: "composer-2.5",
    })).toBe("Composer 2.5");
    expect(exportPresentationLabel({
      namespaced: "mystery/model", provider: "mystery", id: "model", displayName: "Custom Name",
    })).toBe("Custom Name");
  });

  /*
   * Abilities follow the catalog row, not the vendor name. Temperature and
   * reasoning_effort are the same bit inverted: Raycast's own template notes
   * that reasoning models commonly reject temperature. system_message and
   * tools are always on, the same stance as Hermes.
   */
  test("maps vision and reasoning ladders onto abilities per model", () => {
    const document = buildClientConfig("raycast", context()) as RaycastGeneratedConfig;
    expect(abilitiesOf(document, "anthropic/claude-opus-5")).toEqual({
      temperature: true, vision: true, system_message: true, tools: true, reasoning_effort: false,
    });
    expect(abilitiesOf(document, "openai/gpt-5.6-sol")).toEqual({
      temperature: false, vision: false, system_message: true, tools: true, reasoning_effort: true,
    });
    expect(abilitiesOf(document, "mystery/model")).toEqual({
      temperature: true, vision: false, system_message: true, tools: true, reasoning_effort: false,
    });
    expect(abilitiesOf(document, "google/gemini-3-pro")).toEqual({
      temperature: false, vision: true, system_message: true, tools: true, reasoning_effort: true,
    });
  });

  test("native YAML round-trips, leads with our element, and never carries a credential", () => {
    const sentinel = ["sk", "live", "raycast", "sentinel"].join("-");
    const withKey = { ...CONFIG, apiKeys: [{ key: sentinel }] } as OcxConfig;
    const built = buildClientConfigText("raycast", { ...context(), config: withKey });
    expect(built.format).toBe("yaml");
    expect(built.text.startsWith(["providers:", "  - id: opencodex"].join(String.fromCharCode(10)))).toBe(true);
    expect(Bun.YAML.parse(built.text)).toEqual(built.document as never);
    expect(built.text).not.toContain(sentinel);
    expect(built.text).not.toContain("api_keys");
  });

  test("the contribution owns the providers element selected by our id", () => {
    const contribution = buildClientContribution("raycast", context());
    expect(contribution.clientId).toBe("raycast");
    expect(contribution.fragments.map(fragment => fragment.path)).toEqual([["providers", `[id=${OPENCODE_PROVIDER_ID}]`]]);
    expect((contribution.fragments[0]!.value as { id: string }).id).toBe(OPENCODE_PROVIDER_ID);
  });

  test("resolves under the home directory and ignores XDG_CONFIG_HOME", () => {
    // Raycast hardcodes ~/.config/raycast on macOS and Windows alike; honoring
    // XDG here would name a file Raycast never reads.
    const env = { XDG_CONFIG_HOME: join(home, "elsewhere") };
    expect(raycastAiDir(env, home)).toBe(join(home, ".config", "raycast", "ai"));
    expect(raycastConfigPath(env, home)).toBe(join(home, ".config", "raycast", "ai", "providers.yaml"));
    expect(INTEGRATION_CLIENTS.raycast.configPath(env, home)).toBe(raycastConfigPath(env, home));
    expect(INTEGRATION_CLIENTS.raycast.detectDir(env, home)).toBe(raycastAiDir(env, home));
  });

  test("ships as a loopback-only integration with no env var to export", () => {
    const spec = EXPORT_CLIENTS.raycast;
    // `api_keys` is read literally, so a remote bind would need a plaintext
    // secret on disk; the spec refuses instead.
    expect(spec.loopbackOnly).toBe(true);
    expect(spec.apiKeyEnv).toBe("");
    expect(spec.format).toBe("yaml");
    // Not a bare providers.yaml: a download would collide with other clients'.
    expect(spec.filename).toBe("raycast-providers.yaml");
  });

  /*
   * The whole point of the `[id=opencodex]` selector: the user's own element
   * survives every operation, we replace only ours, and a disable leaves the
   * sequence exactly as the user wrote it.
   */
  test("apply, refresh and disable touch only our element of the sequence", () => {
    const configPath = installRaycast(USER_SEED);

    const applied = applyIntegration(request());
    expect(applied.ok).toBe(true);
    const afterApply = readProviders(configPath);
    expect(new Set(afterApply.providers.map(provider => provider.id))).toEqual(new Set(["lmstudio", OPENCODE_PROVIDER_ID]));
    expect(afterApply.providers.find(provider => provider.id === "lmstudio")).toEqual(LMSTUDIO);
    expect(ourProvider(afterApply).models.map(model => model.id)).toEqual(MODELS.map(model => model.namespaced).sort());

    // A smaller catalog rewrites our element in place and nothing else.
    const fewer = MODELS.filter(model => model.namespaced !== "mystery/model");
    const refreshed = refreshIntegration(request(fewer));
    expect(refreshed.ok).toBe(true);
    const afterRefresh = readProviders(configPath);
    expect(afterRefresh.providers.map(provider => provider.id)).toEqual(afterApply.providers.map(provider => provider.id));
    expect(afterRefresh.providers.find(provider => provider.id === "lmstudio")).toEqual(LMSTUDIO);
    expect(ourProvider(afterRefresh).models.map(model => model.id)).toEqual(fewer.map(model => model.namespaced).sort());

    const disabled = disableIntegration(request(fewer));
    expect(disabled.ok).toBe(true);
    const afterDisable = readProviders(configPath);
    expect(afterDisable.providers).toEqual([LMSTUDIO]);
  });

  test("the default catalog refresh updates an owned Raycast provider", async () => {
    const configPath = installRaycast(USER_SEED);
    expect(applyIntegration(request()).ok).toBe(true);
    const fewer = MODELS.filter(model => model.namespaced !== "mystery/model");
    let loads = 0;

    const outcomes = await refreshOwnedCatalogIntegrations({
      models: async () => {
        loads += 1;
        return fewer;
      },
      config: CONFIG,
      port: 10100,
      env: {},
      home,
      store,
    });

    expect(outcomes).toEqual([{ client: "raycast", ok: true, changed: true }]);
    expect(loads).toBe(1);
    expect(readProviders(configPath).providers.find(provider => provider.id === "lmstudio")).toEqual(LMSTUDIO);
    expect(ourProvider(readProviders(configPath)).models.map(model => model.id))
      .toEqual(fewer.map(model => model.namespaced).sort());
  });

  test("refuses a file whose providers is a map rather than a sequence", () => {
    // `providers: {}` is a container we would have to REPLACE with `[]` to
    // write our element, and replacing a user's container is never a success.
    const configPath = installRaycast("providers: {}" + String.fromCharCode(10));
    const result = applyIntegration(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe("providers: {}" + String.fromCharCode(10));
  });

  test("refuses when the ai directory does not exist yet", () => {
    // The directory appears only after "Reveal Providers Config" in Raycast's
    // AI settings, which is the signal that Custom Providers is reachable.
    const result = applyIntegration(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_installed");
  });
});
