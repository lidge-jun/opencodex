import { describe, expect, test } from "bun:test";
import { NATIVE_OPENAI_MODELS } from "../src/codex/catalog/native-models";
import type { OcxConfig } from "../src/types";
import {
  BASELINE_VISION_MODELS,
  isVisionEligibleModel,
  modelAcceptsImageInput,
  visionBackendForCandidate,
  visionEligibleModelOptions,
  type VisionCandidateModel,
} from "../src/vision/eligibility";

const emptyConfig: Pick<OcxConfig, "providers"> = { providers: {} };

function configWithProviders(providers: NonNullable<OcxConfig["providers"]>): Pick<OcxConfig, "providers"> {
  return { providers };
}

describe("vision eligibility core", () => {
  test("1. text-only exclusion discriminates against image-capable rows", () => {
    // openrouter / openai/gpt-5.4-mini is text-only in generated metadata.
    expect(
      isVisionEligibleModel(emptyConfig, {
        provider: "openrouter",
        id: "openai/gpt-5.4-mini",
      }),
    ).toBe(false);

    // anthropic / claude-haiku-4-5 is text+image — proves discrimination, not blanket rejection.
    expect(
      isVisionEligibleModel(emptyConfig, {
        provider: "anthropic",
        id: "claude-haiku-4-5",
      }),
    ).toBe(true);
  });

  test("2. noVisionModels is a hard disqualifier even when modalities advertise image", () => {
    // applyProviderConfigHints rewrites noVisionModels rows to advertise image input.
    // Membership must disqualify the describer BEFORE that rewritten modality list is trusted.
    const config = configWithProviders({
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        noVisionModels: ["glm-5.2"],
      },
    });
    const candidate: VisionCandidateModel = {
      provider: "opencode-go",
      id: "glm-5.2",
      inputModalities: ["text", "image"],
    };
    expect(isVisionEligibleModel(config, candidate)).toBe(false);
    expect(modelAcceptsImageInput(config, candidate)).toBe(false);
  });

  test("3a. silent catalog rows fall back to generated metadata (live /api/models shape)", () => {
    // anthropic / claude-opus-4-6 carries ["text","image"] in the generated table, but live
    // /api/models rows omit inputModalities entirely.
    expect(
      isVisionEligibleModel(emptyConfig, {
        provider: "anthropic",
        id: "claude-opus-4-6",
      }),
    ).toBe(true);
  });

  test("3b. completely unknown models stay eligible via the undefined tri-state", () => {
    const candidate: VisionCandidateModel = {
      provider: "anthropic",
      id: "claude-future-9",
    };
    // Assert the tri-state directly — cases 3a and 3b would otherwise be indistinguishable
    // and the fallback branch would never actually be driven.
    expect(modelAcceptsImageInput(emptyConfig, candidate)).toBeUndefined();
    expect(isVisionEligibleModel(emptyConfig, candidate)).toBe(true);
  });

  test("4. every native OpenAI slug is vision-eligible", () => {
    // Deliberately not pinned to a count: an 8th native slug shipping is not a
    // regression in this predicate, and a length assertion would fail for the
    // wrong reason.
    expect(NATIVE_OPENAI_MODELS.length).toBeGreaterThan(0);
    for (const id of NATIVE_OPENAI_MODELS) {
      expect(
        isVisionEligibleModel(emptyConfig, {
          provider: "openai",
          id,
          native: true,
        }),
      ).toBe(true);
    }
  });

  test("9. the exact candidate shapes the management write gate will synthesize", () => {
    // WP2's PUT guard falls back to `{ provider: openai|anthropic, id }` when no
    // catalog row matches. These three cases pin that path, because collapsing
    // undefined into false here would silently start rejecting models the runtime
    // has always accepted (tests/vision-reasoning-contract.test.ts:149-152 pins
    // `custom-vision` at HTTP 200).
    expect(modelAcceptsImageInput(emptyConfig, { provider: "openai", id: "custom-vision" })).toBeUndefined();
    // The openai table's only text-only rows are codex-mini-latest, gpt-4, o3-mini;
    // these are the sole ids the synthesized fallback can legitimately reject.
    expect(modelAcceptsImageInput(emptyConfig, { provider: "openai", id: "o3-mini" })).toBe(false);
    expect(modelAcceptsImageInput(emptyConfig, { provider: "anthropic", id: "claude-haiku-4-5" })).toBe(true);
  });

  test("10. a suffixed variant of a blind model is disqualified too", () => {
    // modelInList (src/types.ts:208-213) matches the pre-colon prefix, so a
    // `:extended` variant of a noVisionModels entry is still a sidecar consumer.
    // Without this, a blind model could re-enter the picker under a suffix.
    const config = configWithProviders({
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        noVisionModels: ["glm-5.2"],
      },
    });
    expect(modelAcceptsImageInput(config, {
      provider: "opencode-go",
      id: "glm-5.2:extended",
      inputModalities: ["text", "image"],
    })).toBe(false);
  });

  test("11. registry-backed noVisionModels still disqualifies a persisted provider row", () => {
    // Catalog enrichment adds this registry list before it adds image to the row. A config
    // saved before Umans gained the classification must reach the same enrichment here.
    const config = configWithProviders({
      umans: {
        adapter: "anthropic",
        baseUrl: "https://api.code.umans.ai",
      },
    });
    expect(modelAcceptsImageInput(config, {
      provider: "umans",
      id: "umans-glm-5.2",
      inputModalities: ["text", "image"],
    })).toBe(false);
  });

  test("12. only the selected Anthropic OAuth provider contributes Anthropic options", () => {
    const config = configWithProviders({
      anthropic: {
        adapter: "anthropic",
        authMode: "oauth",
        baseUrl: "https://api.anthropic.com",
      },
      umans: {
        adapter: "anthropic",
        baseUrl: "https://api.code.umans.ai",
      },
    });
    const options = visionEligibleModelOptions(
      config,
      [
        { provider: "anthropic", id: "claude-oauth-vision", inputModalities: ["text", "image"] },
        { provider: "umans", id: "umans-coder", inputModalities: ["text", "image"] },
      ],
      ["anthropic"],
      "anthropic",
    );
    expect(options.map(option => option.value)).toContain("claude-oauth-vision");
    expect(options.map(option => option.value)).not.toContain("umans-coder");
  });

  test("12b. with no resolvable Anthropic executor, no Anthropic catalog row is offered", () => {
    // `findAnthropicVisionProvider` requires an enabled OAuth row with a healthy account, so a
    // key-auth canonical provider dispatches nothing. Offering its rows would surface an option
    // that only fails later, at describe time. The baseline still keeps the side populated.
    const config = configWithProviders({
      anthropic: {
        adapter: "anthropic",
        authMode: "key",
        baseUrl: "https://api.anthropic.com",
      },
    });
    const options = visionEligibleModelOptions(
      config,
      [{ provider: "anthropic", id: "claude-key-only", inputModalities: ["text", "image"] }],
      ["anthropic"],
    );
    expect(options.map(option => option.value)).toEqual([BASELINE_VISION_MODELS.anthropic]);
  });

  test("13. a baseline listed as blind is dropped without removing the other backend baseline", () => {
    const config = configWithProviders({
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        noVisionModels: [BASELINE_VISION_MODELS.openai],
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
      },
    });
    expect(visionEligibleModelOptions(config, [], ["openai", "anthropic"], "anthropic").map(option => option.value)).toEqual([
      BASELINE_VISION_MODELS.anthropic,
    ]);
  });

  test("14. a non-native row's explicit text-only modality wins over a colliding native slug", () => {
    expect(modelAcceptsImageInput(emptyConfig, {
      provider: "custom-openai-compatible",
      id: "gpt-5.4-mini",
      inputModalities: ["text"],
    })).toBe(false);
  });

  test("5. openai baseline is present when that side is enabled", () => {
    const options = visionEligibleModelOptions(emptyConfig, [], ["openai"]);
    expect(options.map((o) => o.value)).toEqual([BASELINE_VISION_MODELS.openai]);
    expect(options.every((o) => o.backend === "openai")).toBe(true);
    expect(options.some((o) => o.backend === "anthropic")).toBe(false);
  });

  test("6. anthropic baseline is present when that side is enabled", () => {
    const options = visionEligibleModelOptions(emptyConfig, [], ["anthropic"]);
    expect(options.map((o) => o.value)).toEqual([BASELINE_VISION_MODELS.anthropic]);
    expect(options.every((o) => o.backend === "anthropic")).toBe(true);
    expect(options.some((o) => o.backend === "openai")).toBe(false);
  });

  test("7. baseline is not duplicated when the catalog also lists it", () => {
    const config = configWithProviders({
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
      },
    });
    const options = visionEligibleModelOptions(
      config,
      [
        {
          provider: "anthropic",
          id: BASELINE_VISION_MODELS.anthropic,
          inputModalities: ["text", "image"],
        },
      ],
      ["anthropic"],
    );
    const matches = options.filter((o) => o.value === BASELINE_VISION_MODELS.anthropic);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.baseline).toBe(true);
  });

  test("8. non-forward rows map to routed; absent unless routed is enabled", () => {
    // cursor has no DEDICATED describe executor — the row now belongs to the
    // "routed" loopback executor (#2188 roadmap 170 revised) and appears only
    // when the caller enables that backend, as a NAMESPACED value.
    const config = configWithProviders({
      cursor: {
        adapter: "openai-chat",
        baseUrl: "https://api2.cursor.sh",
      },
    });
    const candidate: VisionCandidateModel = {
      provider: "cursor",
      id: "cursor-vision-capable",
      inputModalities: ["text", "image"],
    };
    expect(visionBackendForCandidate(config, candidate)).toBe("routed");
    expect(isVisionEligibleModel(config, candidate)).toBe(true);
    const options = visionEligibleModelOptions(config, [candidate], ["openai", "anthropic"]);
    expect(options.some((o) => o.value === candidate.id)).toBe(false);
    // baselines still appear for the enabled backends
    expect(options.map((o) => o.value)).toEqual([
      BASELINE_VISION_MODELS.openai,
      BASELINE_VISION_MODELS.anthropic,
    ]);
    // enabling routed surfaces the row, namespaced.
    const withRouted = visionEligibleModelOptions(config, [candidate], ["openai", "anthropic", "routed"]);
    expect(withRouted.some((o) => o.value === "cursor/cursor-vision-capable" && o.backend === "routed")).toBe(true);
  });
});
