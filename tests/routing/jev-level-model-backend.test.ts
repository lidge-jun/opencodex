import { describe, expect, test } from "bun:test";
import type { JevCandidate } from "../../src/combos/jev";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import { JEV_LEVEL_DEFAULT_DESCRIPTIONS } from "../../src/combos/jev-decision-contract";
import { JEV_MODEL_LEVEL_INSTRUCTIONS, jevModelLevelInstructions, resolveJevLevelDecision } from "../../src/combos/jev-level";
import type { NormalizedJevLevels } from "../../src/combos/jev-level-config";
import { buildJevModelPrompt, JEV_MODEL_INSTRUCTIONS, JevModelInvokeError, resolveJevModelDecision, type JevModelInvoke, type JevModelInvokeRequest } from "../../src/combos/jev-model-backend";
import { JEV_MAX_REQUEST_BYTES } from "../../src/combos/jev";
import type { OcxConfig } from "../../src/types";

const config = { port: 0, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
const candidates: JevCandidate[] = [
  { key: "a/fast", provider: "a", model: "fast", reasoningEfforts: ["low", "medium"] },
  { key: "b/deep", provider: "b", model: "deep", reasoningEfforts: ["low", "xhigh"] },
];
const levels: NormalizedJevLevels = {
  trivial: { candidates: [{ provider: "a", model: "fast", effort: "low" }] },
  hard: { description: "Hard work.", candidates: [{ provider: "b", model: "deep", effort: "xhigh" }] },
};
const fallback = { targetKey: "a/fast", effort: "medium" as const };
const body = { input: "Fix the data race in the scheduler." };

function invoking(text: string, calls: JevModelInvokeRequest[] = []): JevModelInvoke {
  return async request => {
    calls.push(request);
    return { text, usage: { input_tokens: 120, output_tokens: 4 } };
  };
}

describe("level mode through a decision model", () => {
  test("asks the model for a configured level and selects that level's candidate", async () => {
    const calls: JevModelInvokeRequest[] = [];
    const decision = await resolveJevLevelDecision({
      body, candidates, fallback, config, levels,
      decisionModel: " router/small ",
      invokeModel: invoking('{"choice":"hard"}', calls),
    });
    expect(decision).toMatchObject({
      backend: "model", gate: "apply", level: "hard", levelPath: "chosen",
      targetKey: "b/deep", effort: "xhigh", usage: { input_tokens: 120, output_tokens: 4 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("router/small");
    expect(calls[0]!.instructions).toBe(JEV_MODEL_LEVEL_INSTRUCTIONS);
    const input = JSON.parse(calls[0]!.input) as { state: { task: string }; options: Record<string, string> };
    expect(input.options).toEqual({ trivial: JEV_LEVEL_DEFAULT_DESCRIPTIONS.trivial, hard: "Hard work." });
    expect(input.state.task).toContain("data race");
    // Level questions never carry target identities.
    expect(calls[0]!.input).not.toContain("b/deep");
  });

  test("fails open on a missing invoker, an unknown level, or an invoke error", async () => {
    const base = { body, candidates, fallback, config, levels, decisionModel: "router/small" };
    expect(await resolveJevLevelDecision(base))
      .toMatchObject({ backend: "model", gate: "missing_key", levelPath: "fail_open", ...fallback });
    expect(await resolveJevLevelDecision({ ...base, invokeModel: invoking('{"choice":"expert"}') }))
      .toMatchObject({ gate: "invalid", levelPath: "fail_open", ...fallback });
    expect(await resolveJevLevelDecision({ ...base, invokeModel: async () => { throw new JevModelInvokeError("http"); } }))
      .toMatchObject({ gate: "http", levelPath: "fail_open", ...fallback });
    expect(await resolveJevLevelDecision({ ...base, body: { input: "  " }, invokeModel: invoking('{"choice":"hard"}') }))
      .toMatchObject({ gate: "no_state", levelPath: "fail_open" });
  });

  test("the combo dispatcher enters level mode for either backend", async () => {
    const decision = await resolveJevComboDecision({
      body, candidates, fallback, config, levels,
      decisionModel: "router/small", invokeModel: invoking('{"choice":"trivial"}'),
    });
    expect(decision).toMatchObject({ backend: "model", level: "trivial", levelPath: "chosen", targetKey: "a/fast", effort: "low" });
    // Without levels the dispatcher keeps the route-mode model contract.
    const route = await resolveJevComboDecision({
      body, candidates, fallback, config,
      decisionModel: "router/small", invokeModel: invoking('{"choice":"b/deep:xhigh"}'),
    });
    expect(route).toMatchObject({ backend: "model", gate: "apply", targetKey: "b/deep", effort: "xhigh" });
    expect(route).not.toHaveProperty("levelPath");
  });

  test("route mode drops quota evidence instead of failing when it alone overflows the prompt cap", async () => {
    const quota = { tier: "nearly_exhausted" as const, usedPercent: 97, window: "weekly" };
    const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
    const build = (length: number, withQuota: boolean): JevCandidate[] => Array.from({ length: 10 }, (_, i) => {
      const provider = `p${i}`.padEnd(length, "p");
      const model = `m${i}`.padEnd(length, "m");
      return { key: `${provider}/${model}`.slice(0, 512), provider, model, reasoningEfforts: efforts, ...(withQuota ? { quota } : {}) };
    });
    const sent = async (list: JevCandidate[]) => {
      const calls: JevModelInvokeRequest[] = [];
      const decision = await resolveJevModelDecision({
        body, candidates: list, fallback: { targetKey: list[0]!.key, effort: null }, config,
        decisionModel: "r/m", invokeModel: invoking(`{"choice":"${list[0]!.key}:low"}`, calls),
      });
      return { decision, calls };
    };
    // Longest names where the bare prompt fits but the quota clauses push it over the cap.
    let length = 0;
    for (let candidate = 255; candidate > 20; candidate -= 1) {
      const bytes = (list: JevCandidate[]) => new TextEncoder().encode(JEV_MODEL_INSTRUCTIONS + buildJevModelPrompt({ task: body.input }, list)).byteLength;
      if (bytes(build(candidate, false)) <= JEV_MAX_REQUEST_BYTES - 512 && bytes(build(candidate, true)) > JEV_MAX_REQUEST_BYTES) { length = candidate; break; }
    }
    expect(length).toBeGreaterThan(0);
    const { decision, calls } = await sent(build(length, true));
    expect(decision).toMatchObject({ gate: "apply", effort: "low" });
    expect(decision).not.toHaveProperty("quotaSent");
    expect(calls[0]!.input).not.toContain("QUOTA NEARLY EXHAUSTED");
    // With room to spare the quota clauses are sent and reported.
    const small = await sent(build(20, true));
    expect(small.decision).toMatchObject({ gate: "apply", quotaSent: true });
    expect(small.calls[0]!.input).toContain("QUOTA NEARLY EXHAUSTED");
  });

  test("levelInstructions replaces only the classification sentence of the model prompt", async () => {
    const calls: JevModelInvokeRequest[] = [];
    await resolveJevLevelDecision({
      body, candidates, fallback, config, levels,
      decisionPrompt: { levelInstructions: "Rate the coding effort." },
      decisionModel: "router/small",
      invokeModel: invoking('{"choice":"hard"}', calls),
    });
    expect(calls[0]!.instructions).toBe(jevModelLevelInstructions({ levelInstructions: "Rate the coding effort." }));
    expect(calls[0]!.instructions).toContain("Rate the coding effort.");
    expect(calls[0]!.instructions).toContain('{"choice":"<key>"}');
    expect(jevModelLevelInstructions()).toBe(JEV_MODEL_LEVEL_INSTRUCTIONS);
  });

  test("a caller abort is rethrown by identity", async () => {
    const controller = new AbortController();
    const reason = new Error("client gone");
    const invokeModel: JevModelInvoke = async () => {
      controller.abort(reason);
      return { text: '{"choice":"hard"}' };
    };
    await expect(resolveJevLevelDecision({
      body, candidates, fallback, config, levels, decisionModel: "router/small", invokeModel, signal: controller.signal,
    })).rejects.toBe(reason);
  });
});
