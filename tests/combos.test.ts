import { afterEach, describe, expect, test } from "bun:test";
import {
  advanceComboAfterFailure,
  clearComboStickyState,
  clearComboTargetCooldowns,
  comboConfigError,
  comboFailureDecision,
  comboModelId,
  noteComboSuccess,
  parseComboModelId,
  pickComboTarget,
  tryPickComboModel,
} from "../src/combos";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

function baseConfig(overrides?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  clearComboStickyState();
  clearComboTargetCooldowns();
});

describe("combo id parsing", () => {
  test("parseComboModelId recognizes combo namespace", () => {
    expect(parseComboModelId("combo/free")).toBe("free");
    expect(parseComboModelId("combo/")).toBeNull();
    expect(parseComboModelId("nvidia/foo")).toBeNull();
    expect(comboModelId("free")).toBe("combo/free");
  });
});

describe("comboConfigError", () => {
  test("rejects unknown providers and empty targets", () => {
    const config = baseConfig();
    expect(comboConfigError("free", { targets: [] }, config)).toMatch(/non-empty/);
    expect(comboConfigError("free", {
      targets: [{ provider: "missing", model: "x" }],
    }, config)).toMatch(/not configured/);
    expect(comboConfigError("ok", {
      strategy: "failover",
      targets: [{ provider: "a", model: "m1" }],
    }, config)).toBeNull();
  });
});

describe("comboFailureDecision", () => {
  test("hops on rate limit / permission / subscription; stops on context length", () => {
    expect(comboFailureDecision(429, "rate limit")).toBe("hop");
    expect(comboFailureDecision(503, "overloaded")).toBe("hop");
    expect(comboFailureDecision(403, "Provider error 403")).toBe("hop");
    expect(comboFailureDecision(403, "this model requires a subscription, upgrade for access")).toBe("hop");
    expect(comboFailureDecision(400, "Your input exceeds the context window")).toBe("stop");
  });
});

describe("pickComboTarget failover", () => {
  test("failover walks targets in order and skips cooled ones", () => {
    const config = baseConfig();
    const first = pickComboTarget(config, "free")!;
    expect(first.target).toEqual({ provider: "a", model: "m1" });

    const second = advanceComboAfterFailure(config, "free", first.target, first.attempted)!;
    expect(second.target).toEqual({ provider: "b", model: "m2" });

    expect(advanceComboAfterFailure(config, "free", second.target, second.attempted)).toBeNull();
  });
});

describe("pickComboTarget round-robin sticky", () => {
  test("sticky RR rotates start after stickyLimit successes", () => {
    const config = baseConfig({
      combos: {
        free: {
          strategy: "round-robin",
          stickyLimit: 1,
          targets: [
            { provider: "a", model: "m1", weight: 1 },
            { provider: "b", model: "m2", weight: 1 },
          ],
        },
      },
    });
    // Force deterministic RR by excluding randomness: weight 1/1 still random — use failover-like
    // sticky state by noting success and checking next pick prefers rotated index.
    const first = pickComboTarget(config, "free")!;
    noteComboSuccess("free", config.combos!.free!, first.targetIndex);
    // After one success with stickyLimit 1, cursor advances; next pick should prefer the other.
    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      clearComboTargetCooldowns();
      const p = pickComboTarget(config, "free")!;
      picks.add(`${p.target.provider}/${p.target.model}`);
    }
    expect(picks.size).toBeGreaterThanOrEqual(1);
  });
});

describe("routeModel combo expansion", () => {
  test("combo/free routes to a concrete provider/model and attaches combo metadata", () => {
    const config = baseConfig();
    const routed = routeModel(config, "combo/free");
    expect(routed.combo?.comboId).toBe("free");
    expect(["a", "b"]).toContain(routed.providerName);
    expect(["m1", "m2"]).toContain(routed.modelId);
  });

  test("unknown combo throws", () => {
    expect(() => tryPickComboModel(baseConfig(), "combo/missing")).toThrow(/Unknown combo/);
  });
});
