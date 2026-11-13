import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearComboSelectionState, getCombo, noteComboSuccess, pickComboTarget, targetKey } from "../../src/combos";
import { clampComboCallerEffort, comboCapabilityGate, type ComboTargetRouter } from "../../src/combos/request-capability";
import { normalizeComboConfig } from "../../src/combos/types";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const textOnly: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "http://127.0.0.1:9/v1",
  modelCapabilities: { "text-model": { inputModalities: ["text"] } },
};
const vision: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "http://127.0.0.1:9/v1",
  modelCapabilities: { "vision-model": { inputModalities: ["text", "image"] } },
};

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 0, providers: { sub: textOnly, key: vision }, ...overrides } as OcxConfig;
}

const router = (cfg: OcxConfig): ComboTargetRouter => target => {
  const provider = cfg.providers[target.provider];
  return provider ? { providerName: target.provider, provider, modelId: target.model } : undefined;
};

const union = normalizeComboConfig({
  capabilityPolicy: "union",
  targets: [{ provider: "sub", model: "text-model" }, { provider: "key", model: "vision-model" }],
});
const imageBody = {
  model: "combo/x",
  input: [{ role: "user", content: [{ type: "input_text", text: "what is this" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
};
const textBody = { model: "combo/x", input: "hello" };
const first = union.targets[0]!;
const second = union.targets[1]!;

describe("combo capabilityPolicy: request filtering", () => {
  test("intersection never filters", () => {
    const cfg = config({ visionSidecar: { enabled: false } });
    const gate = comboCapabilityGate(cfg, { ...union, capabilityPolicy: undefined }, imageBody, router(cfg));
    expect(gate.eligible(first)).toBe(true);
    expect(gate.unservable).toBe(false);
  });

  test("a text-only member stays eligible for an image while the vision sidecar can describe it", () => {
    const cfg = config();
    const gate = comboCapabilityGate(cfg, union, imageBody, router(cfg));
    expect(gate.eligible(first)).toBe(true);
    expect(gate.eligible(second)).toBe(true);
  });

  test("with the sidecar disabled the text-only member is skipped and the vision member serves", () => {
    const cfg = config({ visionSidecar: { enabled: false } });
    const gate = comboCapabilityGate(cfg, union, imageBody, router(cfg));
    expect(gate.eligible(first)).toBe(false);
    expect(gate.eligible(second)).toBe(true);
    expect(gate.unservable).toBe(false);
  });

  test("a request without an image never filters", () => {
    const cfg = config({ visionSidecar: { enabled: false } });
    expect(comboCapabilityGate(cfg, union, textBody, router(cfg)).eligible(first)).toBe(true);
  });

  test("every enabled member unable opens the gate and reports unservable", () => {
    const cfg = config({ visionSidecar: { enabled: false }, providers: { sub: textOnly, key: { ...vision, disabled: true } } });
    const gate = comboCapabilityGate(cfg, union, imageBody, router(cfg));
    expect(gate.unservable).toBe(true);
    expect(gate.eligible(first)).toBe(true);
  });

  test("an unresolved route or unproven capability is treated as native, like the child's pass-through", () => {
    const cfg = config({ visionSidecar: { enabled: false }, providers: { sub: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1" }, key: vision } });
    const gate = comboCapabilityGate(cfg, union, imageBody, router(cfg));
    expect(gate.eligible(first)).toBe(true);
    expect(comboCapabilityGate(cfg, union, imageBody, () => undefined).eligible(first)).toBe(true);
  });
});

describe("combo capabilityPolicy: selection under each strategy", () => {
  afterEach(() => clearComboSelectionState());

  for (const strategy of ["failover", "round-robin"] as const) {
    test(`${strategy} never picks a member unable to take the image, and still uses it for text`, () => {
      const cfg = config({
        visionSidecar: { enabled: false },
        providers: {
          sub: { ...textOnly, apiKey: "k", models: ["text-model"], liveModels: false },
          key: { ...vision, apiKey: "k", models: ["vision-model"], liveModels: false },
        },
        combos: { u: { strategy, capabilityPolicy: "union", targets: [{ provider: "sub", model: "text-model" }, { provider: "key", model: "vision-model" }] } },
      });
      const combo = getCombo(cfg, "u")!;
      const picks = (body: unknown) => {
        const gate = comboCapabilityGate(cfg, combo, body, router(cfg));
        return Array.from({ length: 4 }, () => {
          const pick = pickComboTarget(cfg, "u", { eligible: gate.eligible })!;
          noteComboSuccess("u", combo, pick.target);
          return targetKey(pick.target);
        });
      };
      expect(new Set(picks(imageBody))).toEqual(new Set(["key/vision-model"]));
      clearComboSelectionState();
      expect(picks(textBody)).toContain("sub/text-model");
    });
  }
});

describe("combo capabilityPolicy: effort clamp", () => {
  const ask = (body: Record<string, unknown>, ladder: string[] | undefined) => {
    const clone = structuredClone(body);
    clampComboCallerEffort(clone, ladder, { provider: "sub" });
    return clone;
  };

  test("a rung the member lacks snaps to its highest rung at or below", () => {
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    try {
      expect(ask({ reasoning: { effort: "xhigh", summary: "auto" } }, ["low", "medium", "high"]).reasoning)
        .toEqual({ effort: "high", summary: "auto" });
      expect(ask({ reasoning_effort: "max" }, ["low", "high"]).reasoning_effort).toBe("high");
      expect(debug).toHaveBeenCalledWith("[opencodex] combo effort clamped to target ladder", expect.objectContaining({ requestedEffort: "xhigh", effort: "high" }));
    } finally {
      debug.mockRestore();
    }
  });

  test("a rung below the whole ladder rises to its lowest rung, the rule the default effort uses", () => {
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    try {
      expect(ask({ reasoning: { effort: "low" } }, ["high"]).reasoning).toEqual({ effort: "high" });
    } finally {
      debug.mockRestore();
    }
  });

  test("a rung the member has, an unknown ladder, or an empty ladder are left alone", () => {
    expect(ask({ reasoning: { effort: "medium" } }, ["low", "medium", "high"]).reasoning).toEqual({ effort: "medium" });
    expect(ask({ reasoning: { effort: "xhigh" } }, undefined).reasoning).toEqual({ effort: "xhigh" });
    expect(ask({ reasoning: { effort: "xhigh" } }, []).reasoning).toEqual({ effort: "xhigh" });
  });
});
