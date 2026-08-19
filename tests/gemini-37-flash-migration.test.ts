import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODEL_CONTEXT_WINDOWS,
  ANTIGRAVITY_MODEL_EFFORTS,
  ANTIGRAVITY_MODEL_INPUT_MODALITIES,
  canonicalAntigravityUsageModel,
  parseAntigravityAvailableModels,
  resolveAntigravityEffortWireModel,
  retiredAntigravityFlashTier,
} from "../src/providers/antigravity-models";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { projectModelRenames } from "../src/providers/model-rename-migration";
import { EXPECTED_PRICE_OVERLAYS } from "../src/usage/expected-prices";
import { mapReasoningEffort } from "../src/reasoning-effort";
import { resolveMatchedPrice } from "../src/usage/cost";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

// Google takes the previous Antigravity Flash generation off Cloud Code Assist almost
// immediately once the next one ships. That makes 3.6 -> 3.7 a REPLACEMENT, and the
// interesting failures are all silent: a saved selection that keeps resolving to a dead
// wire id, a tier that quietly disappears, or historical spend that gets relabelled.

const RETIRED_TIERS: Record<string, string> = {
  "gemini-3.6-flash": "medium",
  "gemini-3.6-flash-low": "low",
  "gemini-3.6-flash-medium": "medium",
  "gemini-3.6-flash-high": "high",
  "gemini-3.5-flash-extra-low": "low",
  "gemini-3.5-flash-low": "medium",
  "gemini-3.5-flash-mid": "medium",
  "gemini-3.5-flash-high": "high",
  "gemini-3-flash-agent": "high",
};

describe("Gemini 3.7 Flash replaces 3.6 on Antigravity", () => {
  test("3.7 is the only picker-visible Flash model", () => {
    expect(ANTIGRAVITY_MODELS).toContain("gemini-3.7-flash");
    for (const retired of Object.keys(RETIRED_TIERS)) {
      expect(ANTIGRAVITY_MODELS).not.toContain(retired);
    }
  });

  test("the provider default points at the live model", () => {
    const entry = PROVIDER_REGISTRY.find(row => row.id === "google-antigravity");
    expect(entry?.defaultModel).toBe("gemini-3.7-flash");
    expect(entry?.models).toContain("gemini-3.7-flash");
  });

  test("capability maps describe 3.7 rather than inheriting a fallback", () => {
    expect(ANTIGRAVITY_MODEL_CONTEXT_WINDOWS["gemini-3.7-flash"]).toBe(1_048_576);
    expect(ANTIGRAVITY_MODEL_EFFORTS["gemini-3.7-flash"]).toEqual(["low", "medium", "high"]);
    // Google documents video/audio/PDF support, but this proxy only carries text and
    // image parts — advertising more would be a promise the wire cannot keep.
    expect(ANTIGRAVITY_MODEL_INPUT_MODALITIES["gemini-3.7-flash"]).toEqual(["text", "image"]);
  });
});

describe("retired Flash ids keep routing AND keep their tier", () => {
  // The regression this guards: aliasing a retired id to 3.7 makes it a "suffix model",
  // and the resolver deliberately sends no thinkingConfig for those — so a saved
  // gemini-3.6-flash-high would become an untiered call without anyone noticing.
  test.each(Object.entries(RETIRED_TIERS))(
    "%s routes to 3.7 carrying thinkingLevel %s",
    (retired, expectedLevel) => {
      const resolved = resolveAntigravityEffortWireModel(retired);
      expect(resolved.wireModelId).toBe("gemini-3.7-flash-tiered");
      expect(resolved.thinkingLevel).toBe(expectedLevel);
    },
  );

  test("an explicit effort still wins over the id's historical tier", () => {
    const resolved = resolveAntigravityEffortWireModel("gemini-3.6-flash-low", "high");
    expect(resolved.wireModelId).toBe("gemini-3.7-flash-tiered");
    expect(resolved.thinkingLevel).toBe("high");
  });

  test("every retired id is declared, so none silently loses its tier", () => {
    for (const [retired, tier] of Object.entries(RETIRED_TIERS)) {
      expect(retiredAntigravityFlashTier(retired)).toBe(tier);
    }
    expect(retiredAntigravityFlashTier("gemini-3.7-flash")).toBeUndefined();
  });
});

describe("3.7 reasoning control", () => {
  test("an unset effort still sends the documented medium default", () => {
    const resolved = resolveAntigravityEffortWireModel("gemini-3.7-flash");
    expect(resolved.wireModelId).toBe("gemini-3.7-flash-tiered");
    // Without an explicit branch this model falls through to the resolver's final rule
    // and returns no thinkingConfig at all, silently ignoring reasoning effort.
    expect(resolved.thinkingLevel).toBe("medium");
  });

  test.each(["low", "medium", "high"])("%s is passed through", level => {
    expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", level).thinkingLevel).toBe(level);
  });

  test("minimal never reaches CCA", () => {
    // Google documents minimal as unsupported for this generation: it errors rather
    // than degrading, so it must fall back to the default instead of being forwarded.
    expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", "minimal").thinkingLevel).toBe("medium");
  });

  test("efforts above the enum clamp to high", () => {
    for (const effort of ["xhigh", "max", "ultra"]) {
      expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", effort).thinkingLevel).toBe("high");
    }
  });
});

describe("stale discovery cannot republish a retired model", () => {
  test("a CCA payload still listing 3.6 tiers yields no retired picker row", () => {
    const payload = {
      models: Object.fromEntries(
        ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high", "gemini-3.7-flash"]
          .map(id => [id, { maxTokens: 1_048_576, supportsImages: true }]),
      ),
      agentModelSorts: [{
        groups: [{
          modelIds: ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high", "gemini-3.7-flash"],
        }],
      }],
    };
    const ids = parseAntigravityAvailableModels(payload)?.map(model => model.id) ?? [];
    expect(ids).toContain("gemini-3.7-flash");
    for (const retired of Object.keys(RETIRED_TIERS)) {
      expect(ids).not.toContain(retired);
    }
  });
});

describe("a saved config survives the retirement", () => {
  function configWith(selected: string[]): OcxConfig {
    return {
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          selectedModels: selected,
          defaultModel: selected[0],
        },
      },
    } as unknown as OcxConfig;
  }

  test("an allowlist naming only the retired model is migrated, not emptied", () => {
    // selectedModels is an exact-match allowlist and OAuth reconciliation does not
    // touch it, so without this migration the user's catalog loses Flash entirely.
    const { config, changed } = projectModelRenames(configWith(["gemini-3.6-flash"]));
    expect(changed).toBe(true);
    const prov = config.providers["google-antigravity"]!;
    expect(prov.selectedModels).toEqual(["gemini-3.7-flash"]);
    expect(prov.defaultModel).toBe("gemini-3.7-flash");
  });

  test("migrating a tier id does not duplicate an already-present 3.7 entry", () => {
    const { config } = projectModelRenames(configWith(["gemini-3.6-flash-high", "gemini-3.7-flash"]));
    expect(config.providers["google-antigravity"]!.selectedModels).toEqual(["gemini-3.7-flash"]);
  });

  test("an unrelated selection is left alone", () => {
    const { config } = projectModelRenames(configWith(["claude-sonnet-4-6"]));
    expect(config.providers["google-antigravity"]!.selectedModels).toEqual(["claude-sonnet-4-6"]);
  });

  test("a saved effort map keyed by a retired id is dropped, but the other records are renamed", () => {
    // Renaming the KEY while keeping the VALUE is the trap: the adapter maps effort
    // before it resolves CCA routing, so a surviving `high -> gemini-3.6-flash-high`
    // entry would feed a dead wire id in as an effort name and silently degrade the
    // request to the default tier instead of honouring "high".
    //
    // Dropping MORE than that map would be its own bug: catalog enrichment treats an
    // existing `{}` as already-populated and skips the registry's records, so the user
    // would keep routing correctly while losing the reasoning picker.
    const config = {
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          models: ["gemini-3.6-flash"],
          modelReasoningEffortMap: {
            "gemini-3.6-flash": { high: "gemini-3.6-flash-high", low: "gemini-3.6-flash-low" },
          },
          modelReasoningEfforts: { "gemini-3.6-flash": ["low", "medium", "high"] },
          modelContextWindows: { "gemini-3.6-flash": 1_048_576 },
          modelInputModalities: { "gemini-3.6-flash": ["text", "image"] },
        },
      },
    } as unknown as OcxConfig;

    const { config: migrated } = projectModelRenames(config);
    const prov = migrated.providers["google-antigravity"]!;
    const map = prov.modelReasoningEffortMap ?? {};
    expect(map["gemini-3.6-flash"]).toBeUndefined();
    expect(map["gemini-3.7-flash"]).toBeUndefined();
    // The descriptive records move to the new id rather than vanishing.
    expect(prov.modelReasoningEfforts?.["gemini-3.7-flash"]).toEqual(["low", "medium", "high"]);
    expect(prov.modelReasoningEfforts?.["gemini-3.6-flash"]).toBeUndefined();
    expect(prov.modelContextWindows?.["gemini-3.7-flash"]).toBe(1_048_576);
    expect(prov.modelInputModalities?.["gemini-3.7-flash"]).toEqual(["text", "image"]);
  });

  test("a request under the retired effort map still reaches 3.7 at the requested tier", () => {
    const config = {
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          models: ["gemini-3.6-flash"],
          modelReasoningEffortMap: {
            "gemini-3.6-flash": { high: "gemini-3.6-flash-high" },
          },
        },
      },
    } as unknown as OcxConfig;
    projectModelRenames(config);
    const prov = config.providers["google-antigravity"]!;
    const mapped = mapReasoningEffort(prov, "gemini-3.6-flash", "high");
    expect(resolveAntigravityEffortWireModel("gemini-3.6-flash", mapped)).toEqual({
      wireModelId: "gemini-3.7-flash-tiered",
      thinkingLevel: "high",
    });
  });
});

describe("retirement does not rewrite history", () => {
  test("past usage rows still aggregate under the model that was actually called", () => {
    // Routing sends new 3.6 calls to 3.7, but a usage row written last month records a
    // request the user made against 3.6. Collapsing it into 3.7 would move historical
    // spend onto a model that did not exist then.
    for (const retired of Object.keys(RETIRED_TIERS)) {
      expect(canonicalAntigravityUsageModel(retired)).toBe(retired);
    }
  });

  test("the retired price rows are retained so old requests still cost something", () => {
    const priced = new Set(
      EXPECTED_PRICE_OVERLAYS.filter(row => row.provider === "google-antigravity").map(row => row.modelId),
    );
    for (const retired of Object.keys(RETIRED_TIERS)) expect(priced.has(retired)).toBe(true);
  });

  test("the 3.7 Antigravity price is derived, not claimed as verified", () => {
    // The number is proven from Google's pricing page, but CCA billing equivalence is
    // not published — so the status must not assert more than we can show.
    const row = EXPECTED_PRICE_OVERLAYS.find(
      entry => entry.provider === "google-antigravity" && entry.modelId === "gemini-3.7-flash",
    );
    expect(row?.status).toBe("verified-derived");
    expect(row?.cost4).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
  });

  test("cost resolution actually selects that overlay rather than generated metadata", () => {
    // Declaring the overlay is not enough. Bundled generated metadata is consulted FIRST
    // and returns status "verified", so a cost on the google/gemini-3.7-flash source row
    // would shadow this overlay and assert a CCA billing equivalence Google never
    // published. The source record omits cost precisely so this lookup lands here.
    const matched = resolveMatchedPrice("google-antigravity", "gemini-3.7-flash");
    expect(matched?.status).toBe("verified-derived");
    expect(matched?.cost4).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
    expect(matched?.source).not.toBe("jawcode");
  });
});

// Google renamed the live Flash wire ids to a `-tiered` spelling. The base id keeps
// 404ing, and the failure is invisible from the picker: the catalog, the usage log and
// the price overlays all still name the base id, so only the request path can prove the
// rename landed. These tests were driven red against the pre-fix tree — every one of
// them returned the un-suffixed id.
describe("the -tiered wire rename reaches the request path", () => {
  function directProvider(): OcxProviderConfig {
    return {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "google-test-key",
      authMode: "key",
    } as OcxProviderConfig;
  }

  function directRequest(modelId: string): OcxParsedRequest {
    return {
      modelId,
      context: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      options: {},
    } as OcxParsedRequest;
  }

  test.each([
    ["gemini-3.7-flash", "gemini-3.7-flash-tiered"],
    ["gemini-3.6-flash", "gemini-3.6-flash-tiered"],
  ])("direct AI Studio sends %s as %s in the URL path", async (requested, wire) => {
    const req = await createGoogleAdapter(directProvider()).buildRequest(directRequest(requested));
    expect(req.url).toContain(`/v1beta/models/${wire}:generateContent`);
    // Not vacuous: the dead base id must not survive anywhere in the path.
    expect(req.url).not.toContain(`/models/${requested}:`);
  });

  test("a model without a rename keeps its own id on the wire", async () => {
    // 3.5 is not deprecated; a blanket suffix would break the generation that still works.
    const req = await createGoogleAdapter(directProvider()).buildRequest(directRequest("gemini-3.5-flash"));
    expect(req.url).toContain("/v1beta/models/gemini-3.5-flash:generateContent");
    expect(req.url).not.toContain("-tiered");
  });

  test("the rename is confined to the wire, leaving the user-facing id intact", () => {
    // The picker, the usage rows and the price overlays are all keyed on the base id.
    // If the rename leaked into them, saved selections and historical spend would move.
    expect(ANTIGRAVITY_MODELS).toContain("gemini-3.7-flash");
    expect(ANTIGRAVITY_MODELS).not.toContain("gemini-3.7-flash-tiered");
    expect(canonicalAntigravityUsageModel("gemini-3.7-flash")).toBe("gemini-3.7-flash");
    expect(resolveMatchedPrice("google-antigravity", "gemini-3.7-flash")?.cost4).toBeDefined();
  });

  test("the collapsed picker row still carries a context window after the rename", () => {
    // The map derives alias entries from the WIRE table, so renaming the wire key without
    // keeping the picker entry would silently blank the window for every retired id.
    expect(ANTIGRAVITY_MODEL_CONTEXT_WINDOWS["gemini-3.7-flash"]).toBe(1_048_576);
    for (const retired of Object.keys(RETIRED_TIERS)) {
      expect(ANTIGRAVITY_MODEL_CONTEXT_WINDOWS[retired]).toBe(1_048_576);
    }
  });
});
