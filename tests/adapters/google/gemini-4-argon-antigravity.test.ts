import { afterEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import { antigravityCliUserAgent } from "../../../src/adapters/client-fingerprint";
import {
  ANTIGRAVITY_CLI_REQUEST_UA,
  ANTIGRAVITY_DISCOVERY_UA,
  ANTIGRAVITY_REQUEST_UA,
  antigravityUserAgentForWireModel,
} from "../../../src/adapters/google-antigravity-wire";
import { buildModelsRequest } from "../../../src/oauth";
import {
  ANTIGRAVITY_KNOWN_PICKER_MODELS,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODEL_CONTEXT_WINDOWS,
  ANTIGRAVITY_MODEL_EFFORTS,
  ANTIGRAVITY_MODEL_INPUT_MODALITIES,
  canonicalAntigravityUsageModel,
  isAntigravitySuffixModelId,
  parseAntigravityAvailableModels,
  resolveAntigravityEffortWireModel,
} from "../../../src/providers/antigravity-models";
import { PROVIDER_REGISTRY } from "../../../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

// Verified 2026-10-14 against live CCA: Gemini 4 Argon answers only to the CLI family, and the
// IDE UA gets 404 "Requested entity was not found". The reverse also holds: under the CLI UA,
// gemini-3.7-flash-tiered and gemini-3.1-pro-low 404. Both strings are pinned exactly because
// the backend gates by family AND version.
const CLI_UA = "antigravity/cli/1.3.4 (os_type=darwin; arch=arm64; aidev_client; auth_method=oauth)";
const IDE_UA = "antigravity/ide/2.5.5 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "proj-123",
  apiKey: "ya29.token",
  modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS,
} as OcxProviderConfig;

function parsedWithEffort(modelId: string, effort?: string): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    context: { messages: [{ role: "user", content: "test" }], systemPrompt: [], tools: [] },
    options: effort ? { reasoning: effort } : {},
  } as unknown as OcxParsedRequest;
}

async function built(modelId: string, effort?: string) {
  const req = await createGoogleAdapter(provider).buildRequest(parsedWithEffort(modelId, effort));
  return { req, env: JSON.parse(req.body) };
}

const originalUaOverride = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
afterEach(() => {
  if (originalUaOverride === undefined) delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
  else process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = originalUaOverride;
});

describe("Gemini 4 Argon on Antigravity", () => {
  test("is a collapsed picker row with the 3.8 ladder shape", () => {
    expect(ANTIGRAVITY_MODELS).toContain("gemini-4-argon");
    for (const wire of ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]) {
      expect(ANTIGRAVITY_MODELS).not.toContain(wire);
      expect(ANTIGRAVITY_MODEL_CONTEXT_WINDOWS[wire]).toBe(1_048_576);
    }
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "google-antigravity");
    expect(entry?.models).toContain("gemini-4-argon");
    // Argon is gated to AI Ultra / Enterprise, so it must not become the default.
    expect(entry?.defaultModel).toBe("gemini-3.8-flash");
    expect(ANTIGRAVITY_MODEL_EFFORTS["gemini-4-argon"]).toEqual(["low", "medium", "high"]);
    expect(ANTIGRAVITY_MODEL_CONTEXT_WINDOWS["gemini-4-argon"]).toBe(1_048_576);
    expect(ANTIGRAVITY_MODEL_INPUT_MODALITIES["gemini-4-argon"]).toEqual(["text", "image"]);
  });

  test("each effort resolves to its verified suffix wire id with no thinkingLevel", () => {
    for (const [effort, wireModelId] of [
      ["low", "gemini-4-argon-low"],
      ["medium", "gemini-4-argon-medium"],
      ["high", "gemini-4-argon-high"],
      ["xhigh", "gemini-4-argon-high"],
      ["max", "gemini-4-argon-high"],
    ] as const) {
      expect(resolveAntigravityEffortWireModel("gemini-4-argon", effort)).toEqual({ wireModelId });
    }
    // Google's documented default thinking level.
    expect(resolveAntigravityEffortWireModel("gemini-4-argon")).toEqual({ wireModelId: "gemini-4-argon-medium" });
  });

  test("usage collapses every Argon wire id onto the picker id", () => {
    for (const wire of ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]) {
      expect(canonicalAntigravityUsageModel(wire)).toBe("gemini-4-argon");
    }
  });

  test("discovery collapses the complete Argon ladder into one row", () => {
    const modelIds = ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"];
    const rows = parseAntigravityAvailableModels({
      models: Object.fromEntries(modelIds.map(id => [id, { maxTokens: 1_048_576 }])),
      agentModelSorts: [{ groups: [{ modelIds }] }],
    })!;
    expect(rows.map(model => model.id)).toEqual(["gemini-4-argon"]);
    expect(rows[0]?.effortWireModelIds).toEqual({
      low: "gemini-4-argon-low",
      medium: "gemini-4-argon-medium",
      high: "gemini-4-argon-high",
    });
  });
});

describe("Antigravity User-Agent selection", () => {
  test("pins the CLI and IDE strings", () => {
    expect(ANTIGRAVITY_CLI_REQUEST_UA).toBe(CLI_UA);
    expect(ANTIGRAVITY_REQUEST_UA).toBe(IDE_UA);
  });

  test("only Argon wire ids take the CLI UA", () => {
    for (const wire of ["gemini-4-argon", "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]) {
      expect(antigravityUserAgentForWireModel(wire)).toBe(CLI_UA);
    }
    for (const wire of [
      "gemini-3.7-flash-tiered",
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
      "gemini-3.8-flash-medium",
      "gemini-3.1-flash-image",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
      // Near misses must not widen the CLI gate.
      "gemini-4-argon-max",
      "gemini-4-argon-tiered",
      "gemini-4-argonaut",
      "x-gemini-4-argon-high",
    ]) {
      expect(antigravityUserAgentForWireModel(wire)).toBe(IDE_UA);
    }
  });

  test("an Argon inference request carries the CLI UA and the suffix wire id", async () => {
    for (const [effort, wire] of [["low", "gemini-4-argon-low"], ["high", "gemini-4-argon-high"], [undefined, "gemini-4-argon-medium"]] as const) {
      const { req, env } = await built("gemini-4-argon", effort);
      expect(env.model).toBe(wire);
      expect(req.headers["User-Agent"]).toBe(CLI_UA);
      // The suffix already names the tier; a thinkingLevel beside it would state it twice.
      expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBeUndefined();
    }
  });

  test("every other model keeps the IDE UA, including the ids the CLI UA 404s", async () => {
    const cases: Array<[string, string | undefined, string]> = [
      ["gemini-3.7-flash", "low", "gemini-3.7-flash-tiered"],
      ["gemini-3.1-pro", "low", "gemini-3.1-pro-low"],
      ["gemini-3.1-pro", "high", "gemini-pro-agent"],
      ["gemini-3.8-flash", "medium", "gemini-3.8-flash-medium"],
      ["claude-sonnet-4-6", "high", "claude-sonnet-4-6"],
    ];
    for (const [modelId, effort, wire] of cases) {
      const { req, env } = await built(modelId, effort);
      expect(env.model).toBe(wire);
      expect(req.headers["User-Agent"]).toBe(IDE_UA);
    }
  });

  test("model discovery uses the CLI UA", () => {
    const prov = { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", liveModels: true } as OcxProviderConfig;
    const { url, headers } = buildModelsRequest(prov, "oauth-token", "google-antigravity");
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(ANTIGRAVITY_DISCOVERY_UA).toBe(CLI_UA);
    expect(headers["User-Agent"]).toBe(CLI_UA);
  });

  test("the IDE UA override does not replace the CLI UA", () => {
    process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = "custom-ua/1.2.3";
    expect(antigravityCliUserAgent()).toBe(CLI_UA);
  });
});

describe("Antigravity static lineup (3.8 / 4 / 5.5 / 5.5)", () => {
  test("is exactly the four confirmed base models", () => {
    expect(ANTIGRAVITY_MODELS).toEqual(["gemini-3.8-flash", "gemini-4-argon", "claude-opus-5-5", "claude-sonnet-5-5"]);
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "google-antigravity");
    expect(entry?.models).toEqual(ANTIGRAVITY_MODELS);
  });

  test("Claude 5.5 efforts ride their suffix wire ids on the IDE UA", async () => {
    for (const base of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(ANTIGRAVITY_MODEL_EFFORTS[base]).toEqual(["low", "medium", "high"]);
      expect(ANTIGRAVITY_MODEL_CONTEXT_WINDOWS[base]).toBe(1_000_000);
      expect(ANTIGRAVITY_MODEL_INPUT_MODALITIES[base]).toEqual(["text", "image"]);
      for (const effort of ["low", "medium", "high"] as const) {
        expect(resolveAntigravityEffortWireModel(base, effort)).toEqual({ wireModelId: `${base}-${effort}` });
        expect(canonicalAntigravityUsageModel(`${base}-${effort}`)).toBe(base);
      }
      expect(resolveAntigravityEffortWireModel(base)).toEqual({ wireModelId: `${base}-medium` });
      const { req, env } = await built(base, "high");
      expect(env.model).toBe(`${base}-high`);
      expect(req.headers["User-Agent"]).toBe(IDE_UA);
    }
  });

  test("models dropped from the lineup still route exactly as before", () => {
    for (const legacy of ["gemini-3.7-flash", "gemini-3.1-pro", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]) {
      expect(ANTIGRAVITY_MODELS).not.toContain(legacy);
      expect(ANTIGRAVITY_KNOWN_PICKER_MODELS).toContain(legacy);
      // A known base is not mistaken for a tier-encoding suffix id.
      expect(isAntigravitySuffixModelId(legacy)).toBe(false);
      expect(canonicalAntigravityUsageModel(legacy)).toBe(legacy);
    }
    expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", "low"))
      .toEqual({ wireModelId: "gemini-3.7-flash-tiered", thinkingLevel: "low" });
    expect(resolveAntigravityEffortWireModel("gemini-3.1-pro", "high")).toEqual({ wireModelId: "gemini-pro-agent", thinkingLevel: "high" });
    expect(resolveAntigravityEffortWireModel("claude-sonnet-4-6", "high"))
      .toEqual({ wireModelId: "claude-sonnet-4-6", thinkingLevel: "high" });
  });
});
