import { describe, expect, test } from "bun:test";
import {
  CLAUDE_AGENT_SDK_PROVIDER_ID,
  CLAUDE_CLI_PROVIDER_ID,
  projectClaudeProviderRename,
} from "../../src/providers/claude-provider-rename-migration";
import { resolveDeprecatedProviderId } from "../../src/providers/deprecated-provider-aliases";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { projectStartupConfigRepairs } from "../../src/providers/model-rename-startup";
import type { OcxConfig } from "../../src/types";

const OLD = CLAUDE_CLI_PROVIDER_ID;
const NEW = CLAUDE_AGENT_SDK_PROVIDER_ID;

/**
 * A config as written while `claude-cli` was still the registry id: the provider row under the old
 * key, plus one of every cross-config reference shape the shared rewriter owns.
 */
function migratableConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: OLD,
    providers: {
      [OLD]: { adapter: OLD, baseUrl: "https://api.anthropic.com" },
    },
    disabledModels: [`${OLD}/claude-sonnet-5`, "anthropic/claude-sonnet-5"],
    customModels: [{ id: "mine", provider: OLD, modelId: "claude-sonnet-5" }],
    combos: { fast: { targets: [{ provider: OLD, model: "claude-sonnet-5" }] } },
    routingProfiles: {
      policy: {
        candidates: [
          { provider: OLD, model: "claude-sonnet-5" },
          { provider: "anthropic", model: "claude-sonnet-5" },
        ],
      },
    },
    providerContextCaps: { [OLD]: 1_000_000, anthropic: 200_000 },
  } as unknown as OcxConfig;
}

describe("claude provider rename projection", () => {
  test("moves the row and re-points every reference shape", () => {
    const projection = projectClaudeProviderRename(migratableConfig());
    expect(projection.changed).toBe(true);

    const providers = projection.config.providers!;
    expect(providers[OLD]).toBeUndefined();
    expect(providers[NEW]!.baseUrl).toBe("https://api.anthropic.com");
    expect(providers[NEW]!.adapter).toBe(NEW);

    expect(projection.config.defaultProvider).toBe(NEW);
    expect(projection.config.disabledModels).toEqual([`${NEW}/claude-sonnet-5`, "anthropic/claude-sonnet-5"]);
    expect(projection.config.customModels![0]!.provider).toBe(NEW);
    expect(projection.config.combos!.fast.targets[0]!.provider).toBe(NEW);
    expect(projection.config.routingProfiles!.policy.candidates[0]!.provider).toBe(NEW);

    const caps = projection.config.providerContextCaps as Record<string, number>;
    expect(caps[NEW]).toBe(1_000_000);
    expect(Object.hasOwn(caps, OLD)).toBe(false);

    expect(projection.warnings.join("\n")).toContain("moved provider");
  });

  test("rewrites the adapter id on a custom-named row that named the retired adapter", () => {
    const config = {
      providers: { "my-claude": { adapter: OLD, baseUrl: "https://api.anthropic.com" } },
    } as unknown as OcxConfig;
    const projection = projectClaudeProviderRename(config);
    expect(projection.changed).toBe(true);
    expect(projection.config.providers!["my-claude"]!.adapter).toBe(NEW);
    expect(projection.config.providers!["my-claude"]!.baseUrl).toBe("https://api.anthropic.com");
    expect(projection.warnings.join("\n")).toContain("custom provider row");
  });

  test("refuses to merge when the destination row already exists", () => {
    const config = {
      providers: {
        [OLD]: { adapter: OLD, baseUrl: "https://api.anthropic.com" },
        [NEW]: { adapter: NEW, baseUrl: "https://api.anthropic.com" },
      },
    } as unknown as OcxConfig;
    const projection = projectClaudeProviderRename(config);
    expect(projection.changed).toBe(false);
    expect(projection.config).toBe(config);
    expect(projection.warnings.join("\n")).toContain("already exists");
  });

  test("discards a half-applied projection when a destination key collides", () => {
    const config = {
      defaultProvider: OLD,
      providers: { [OLD]: { adapter: OLD } },
      providerContextCaps: { [OLD]: 100, [NEW]: 200 },
    } as unknown as OcxConfig;
    const projection = projectClaudeProviderRename(config);
    expect(projection.changed).toBe(false);
    expect(projection.config).toBe(config);
    // The clone was already partly rewritten when the collision surfaced; returning the original
    // is what keeps the caller from saving that half.
    expect(projection.config.defaultProvider).toBe(OLD);
    expect((projection.config.providers as Record<string, unknown>)[OLD]).toBeDefined();
    expect(projection.warnings.join("\n")).toContain("already hold values");
  });

  test("is a no-op when nothing names the retired id", () => {
    const config = { providers: { anthropic: { adapter: "anthropic" } } } as unknown as OcxConfig;
    const projection = projectClaudeProviderRename(config);
    expect(projection.changed).toBe(false);
    expect(projection.warnings).toEqual([]);
    expect(projection.config).toBe(config);
  });

  test("the retired id still resolves to the renamed registry row", () => {
    expect(resolveDeprecatedProviderId(OLD)).toBe(NEW);
    expect(resolveDeprecatedProviderId("anthropic")).toBe("anthropic");
    expect(getProviderRegistryEntry(OLD)?.id).toBe(NEW);
    expect(getProviderRegistryEntry(NEW)?.label).toBe("Claude Agent SDK (subscription)");
  });

  test("the shared startup pass carries the rename", () => {
    // The projection is only wired if the boot pass reaches it: a row renamed after the model and
    // context-window repairs would be repaired against a registry entry that no longer exists.
    const repaired = projectStartupConfigRepairs(migratableConfig());
    expect(repaired.changed).toBe(true);
    expect(repaired.config.providers![NEW]).toBeDefined();
    expect(repaired.config.providers![OLD]).toBeUndefined();
    expect(repaired.warnings.join("\n")).toContain("moved provider");
  });
});
