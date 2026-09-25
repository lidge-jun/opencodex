/**
 * The server-side plan snapshot (src/protocols/plan-snapshot.ts): the route a preview
 * describes, built from config without picking, fetching or writing anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, getCombo, noteComboFailure, pickComboTarget } from "../../src/combos";
import { isProtocolPlanV1 } from "../../src/protocols/dto";
import { buildProtocolPlanSnapshot, previewProtocolPlan } from "../../src/protocols/plan-snapshot";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-plan-snapshot-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboSelectionState();
});

afterEach(() => {
  clearComboSelectionState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      r: { adapter: "openai-responses", baseUrl: "https://r.example/v1", apiKey: "kr", models: ["m3"] },
    },
    combos: {
      mixed: {
        strategy: "round-robin",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "r", model: "m3" },
        ],
      },
    },
    routingProfiles: {
      fast: {
        alias: "ocx/fast",
        candidates: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    ...overrides,
  } as OcxConfig;
}

describe("buildProtocolPlanSnapshot", () => {
  test("a direct Chat model on a Chat provider is a native candidate", () => {
    const snapshot = buildProtocolPlanSnapshot(baseConfig(), { model: "m1", inbound: "chat", features: [] });
    expect(snapshot.routeKind).toBe("direct");
    expect(snapshot.candidates).toEqual([
      { provider: "a", model: "m1", adapter: "openai-chat", nativeEligible: true, declineReasons: [] },
    ]);
    expect(previewProtocolPlan(baseConfig(), { model: "m1", inbound: "chat", features: [] }).mode).toBe("native");
  });

  test("a combo expands every configured target and declines the native Chat lane", () => {
    const snapshot = buildProtocolPlanSnapshot(baseConfig(), { model: "combo/mixed", inbound: "chat", features: [] });
    expect(snapshot.routeKind).toBe("combo");
    expect(snapshot.candidates.map(c => [c.provider, c.adapter, c.nativeEligible])).toEqual([
      ["a", "openai-chat", false],
      ["r", "openai-responses", false],
    ]);
    expect(snapshot.candidates[0]!.declineReasons).toEqual(["combo-or-policy-route"]);
    const plan = previewProtocolPlan(baseConfig(), { model: "combo/mixed", inbound: "chat", features: [] });
    expect(isProtocolPlanV1(plan)).toBe(true);
    expect(plan.basis).toBe("preview");
    expect(plan.candidates.map(c => c.mode)).toEqual(["legacy-bridge", "translated"]);
  });

  test("with nativeChatCombos on, a combo's Chat candidate is judged as its concrete route", () => {
    const config = baseConfig({ protocols: { rollout: { nativeChatCombos: true } } } as Partial<OcxConfig>);
    const snapshot = buildProtocolPlanSnapshot(config, { model: "combo/mixed", inbound: "chat", features: [] });
    expect(snapshot.candidates.map(c => [c.provider, c.nativeEligible, c.declineReasons])).toEqual([
      ["a", true, []],
      ["r", false, ["cross-wire-ir"]],
    ]);
    const plan = previewProtocolPlan(config, { model: "combo/mixed", inbound: "chat", features: [] });
    expect(plan.candidates.map(c => c.mode)).toEqual(["native", "translated"]);
  });

  test("a policy alias expands its configured candidates", () => {
    const snapshot = buildProtocolPlanSnapshot(baseConfig(), { model: "ocx/fast", inbound: "responses", features: [] });
    expect(snapshot.routeKind).toBe("policy");
    expect(snapshot.candidates.map(c => c.provider)).toEqual(["a", "b"]);
  });

  test("an unroutable model is unknown with no candidates", () => {
    const config = baseConfig({ defaultProvider: "missing" });
    const plan = previewProtocolPlan(config, { model: "nothing-routes-this", inbound: "responses", features: [] });
    expect(plan).toMatchObject({ routeKind: "unknown", mode: "blocked", candidates: [], reasonCodes: ["unknown-model"] });
    const policy = previewProtocolPlan(baseConfig(), { model: "policy/missing", inbound: "responses", features: [] });
    expect(policy.routeKind).toBe("unknown");
  });

  test("Messages caller-forward passthrough is reported, never assumed", () => {
    const plan = previewProtocolPlan(baseConfig(), { model: "claude-sonnet-4-5", inbound: "messages", features: [] });
    expect(plan.reasonCodes[0]).toBe("caller-credential-required");
    expect(plan.candidates.every(c => c.mode !== "native")).toBe(true);
    const off = previewProtocolPlan(
      baseConfig({ claudeCode: { nativePassthrough: false } } as Partial<OcxConfig>),
      { model: "claude-sonnet-4-5", inbound: "messages", features: [] },
    );
    expect(off.reasonCodes).not.toContain("caller-credential-required");
  });

  test("a disabled Messages surface blocks the plan", () => {
    const config = baseConfig({ apiSurfaces: { messages: { enabled: false } } } as Partial<OcxConfig>);
    const plan = previewProtocolPlan(config, { model: "m1", inbound: "messages", features: [] });
    expect(plan.mode).toBe("blocked");
    expect(plan.reasonCodes).toEqual(["surface-disabled"]);
  });

  test("the policy revision and settings come from config", () => {
    const config = baseConfig({ protocols: { unrepresentable: "reject" } } as Partial<OcxConfig>);
    const snapshot = buildProtocolPlanSnapshot(config, { model: "m1", inbound: "chat", features: [] });
    expect(snapshot.settings.unrepresentable).toBe("reject");
    expect(snapshot.policyRevision).not.toBe(buildProtocolPlanSnapshot(baseConfig(), { model: "m1", inbound: "chat", features: [] }).policyRevision);
  });
});

describe("snapshot side effects", () => {
  test("previewing a combo never advances its round-robin selection", () => {
    const config = baseConfig();
    for (let i = 0; i < 3; i++) previewProtocolPlan(config, { model: "combo/mixed", inbound: "responses", features: [] });
    // With untouched state, clearing the first target and picking again still lands on it.
    // Had any preview picked, the smooth-weighted counters would now favour the second
    // target: a pick sets t0 active and leaves weights {t0:-1, t1:+1}.
    noteComboFailure("mixed", getCombo(config, "mixed")!.targets[0]!);
    expect(pickComboTarget(config, "mixed")?.targetIndex).toBe(0);
  });

  test("the control: one real pick does shift the next selection", () => {
    const config = baseConfig();
    pickComboTarget(config, "mixed");
    noteComboFailure("mixed", getCombo(config, "mixed")!.targets[0]!);
    expect(pickComboTarget(config, "mixed")?.targetIndex).toBe(1);
  });

  test("a preview performs no network request", () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("preview must not fetch");
    }) as unknown as typeof fetch;
    try {
      previewProtocolPlan(baseConfig(), { model: "m1", inbound: "chat", features: ["request.tools"] });
      previewProtocolPlan(baseConfig(), { model: "combo/mixed", inbound: "messages", features: [] });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(0);
  });
});
