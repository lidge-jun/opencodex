/** Haiku 5.5 seed/snapshot parity; provider-local row shapes follow Sonnet 5.5. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CURSOR_CAPABILITIES, cursorUmbrellaRows, resolveCursorSelection } from "../../src/adapters/cursor/catalog";
import { cursorModelEffortLadder, cursorEffortSuffix } from "../../src/adapters/cursor/effort-map";
import { DEVIN_MODEL_CONTEXT_WINDOWS } from "../../src/adapters/devin/live-models";
import { DESKTOP_PICKER_ID_SUGGESTIONS } from "../../src/claude/intercept/model-bindings";
import { getModelMetadata, resolveMetadataProvider } from "../../src/generated/model-metadata";
import { effectiveModelAliases } from "../../src/providers/default-aliases";
import { providerConfigSeed } from "../../src/providers/derive";
import { KIRO_MODELS, KIRO_MODEL_CONTEXT_WINDOWS, KIRO_MODEL_REASONING_EFFORTS, normalizeKiroModelId } from "../../src/providers/kiro-models";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { ANTHROPIC_MODELS, ANTHROPIC_MODEL_CONTEXT_WINDOWS, ANTHROPIC_MODEL_INPUT_MODALITIES, ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS, ANTHROPIC_MODEL_REASONING_EFFORTS } from "../../src/providers/registry/model-seeds";
import { repoPath } from "../helpers/repo-root";

const ID = "claude-haiku-5-5";
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
interface SnapshotRow { id: string; name: string; provider: string; api: string; baseUrl: string; reasoning: boolean; input: string[]; contextWindow: number; maxTokens: number; cost: Record<string, number>; }
const source = JSON.parse(readFileSync(repoPath("scripts/model-metadata.source.json"), "utf8")) as Record<string, Record<string, SnapshotRow>>;
const snapshotIds = [
  ["anthropic", ID], ...["", "global.", "us.", "eu.", "jp.", "au."].map(prefix => ["amazon-bedrock", `${prefix}anthropic.${ID}`]),
  ...["openrouter", "vercel-ai-gateway", "kilo", "zenmux"].map(provider => [provider, "anthropic/claude-haiku-5.5"]),
  ...["venice", "opencode-zen", "opencode-go", "github-copilot"].map(provider => [provider, ID]),
  ["cloudflare-ai-gateway", `anthropic/${ID}`],
];

describe("Claude Haiku 5.5 catalog", () => {
  test("Anthropic seeds expose 1M, 128K, vision and every effort without changing defaults", () => {
    expect(ANTHROPIC_MODELS.indexOf(ID)).toBe(ANTHROPIC_MODELS.indexOf("claude-haiku-4-5") - 1);
    expect(ANTHROPIC_MODEL_CONTEXT_WINDOWS[ID]).toBe(1_000_000);
    expect(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS[ID]).toBe(128_000);
    expect(ANTHROPIC_MODEL_INPUT_MODALITIES[ID]).toEqual(["text", "image"]);
    expect(ANTHROPIC_MODEL_REASONING_EFFORTS[ID]).toEqual(LEVELS);
    for (const name of ["anthropic", "anthropic-apikey", "claude-cli"]) {
      const entry = getProviderRegistryEntry(name)!;
      const provider = providerConfigSeed(entry);
      expect(provider.models).toContain(ID);
      expect(provider.modelContextWindows?.[ID]).toBe(1_000_000);
      expect(entry.defaultModel).toBe("claude-sonnet-5");
      expect(provider.defaultMaxOutputTokens).toBe(64_000);
    }
    expect(ANTHROPIC_MODEL_CONTEXT_WINDOWS["claude-haiku-4-5"]).toBe(200_000);
    expect(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS["claude-haiku-4-5"]).toBeUndefined();
    for (const id of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]) {
      expect(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS[id]).toBe(128_000);
      expect(ANTHROPIC_MODEL_CONTEXT_WINDOWS[id]).toBe(1_000_000);
    }
  });

  for (const [provider, id] of snapshotIds) {
    test(`${provider}/${id} snapshot preserves transport shape and published metadata`, () => {
      const row = source[provider][id];
      expect(row).toMatchObject({ id, provider, reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 });
      expect(row.name).toContain("Haiku 5.5");
      const sibling = provider === "opencode-go" ? source[provider]["deepseek-v4-flash"] : source[provider][id.replace("haiku", "sonnet")];
      expect(row.api).toBe(sibling.api);
      expect(row.baseUrl).toBe(sibling.baseUrl);
      const scale = provider === "venice" ? 1.25 : provider === "amazon-bedrock" && /^(us|eu|jp|au)\./.test(id) ? 1.1 : 1;
      for (const [key, rate] of Object.entries({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 })) {
        expect(row.cost[key]).toBeCloseTo(rate * scale, 10);
      }
      if (resolveMetadataProvider(provider)) {
        expect(getModelMetadata(provider, id)).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000, cost: row.cost });
      }
    });
  }

  test("preemptive Devin, Kiro and Desktop additions keep the current defaults", () => {
    for (const provider of ["devin"]) {
      const entry = getProviderRegistryEntry(provider)!;
      expect(entry.models).toContain(ID);
      expect(entry.defaultModel).toBe("swe-2");
    }
    expect(DEVIN_MODEL_CONTEXT_WINDOWS[ID]).toBe(1_000_000);
    expect(KIRO_MODELS).toContain("claude-haiku-5.5");
    expect(KIRO_MODEL_CONTEXT_WINDOWS["claude-haiku-5.5"]).toBe(1_000_000);
    expect(KIRO_MODEL_REASONING_EFFORTS["claude-haiku-5.5"]).toEqual(LEVELS);
    expect(normalizeKiroModelId(ID)).toBe("claude-haiku-5.5");
    expect(getProviderRegistryEntry("kiro")!.defaultModel).toBe("kiro-auto");
    expect(DESKTOP_PICKER_ID_SUGGESTIONS).toContain(ID);
  });

  test("Cursor exposes a regular-only FULL ladder with 1M context and exact display name", () => {
    expect(CURSOR_CAPABILITIES[ID]).toEqual({ displayName: "Claude Haiku 5.5", window: 1_000_000, defaultVariant: "regular", variants: { regular: { levels: LEVELS } } });
    expect(cursorUmbrellaRows().find(row => row.id === ID)).toMatchObject({ displayName: "Claude Haiku 5.5", window: 1_000_000, efforts: LEVELS, maxModeVerified: false });
    expect(cursorModelEffortLadder(ID)).toEqual(LEVELS);
    for (const level of LEVELS) {
      expect(cursorEffortSuffix(ID, level)).toBe(level);
      expect(resolveCursorSelection(ID, level).wireId).toBe(`${ID}-${level}`);
    }
  });

  test("two Haiku seeds suppress the built-in alias; explicit user alias has precedence", () => {
    const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", defaultAliases: true, models: [...ANTHROPIC_MODELS] };
    const builtin = effectiveModelAliases({ defaultModelAliases: false }, provider, provider.models);
    expect(builtin.has(ID)).toBe(false);
    expect(builtin.has("claude-haiku-4-5")).toBe(false);
    const explicit = effectiveModelAliases({ defaultModelAliases: false }, { ...provider, modelAliases: { [ID]: "haiku" } }, provider.models);
    expect(explicit.get(ID)).toEqual({ alias: "haiku", source: "user" });
    expect(explicit.has("claude-haiku-4-5")).toBe(false);
  });
});
