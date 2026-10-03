import { describe, expect, test } from "bun:test";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import type { JevCandidate } from "../../src/combos/jev";
import { JEV_MODEL_LEVEL_INSTRUCTIONS } from "../../src/combos/jev-level";
import type { NormalizedJevLevels } from "../../src/combos/jev-level-config";
import { JEV_MODEL_INSTRUCTIONS, JevModelInvokeError, type JevModelInvoke, type JevModelInvokeRequest } from "../../src/combos/jev-model-backend";
import type { OcxConfig } from "../../src/types";

const candidates: JevCandidate[] = [
  { key: "a/first", provider: "a", model: "first", reasoningEfforts: ["low", "medium", "high"] },
  { key: "b/second", provider: "b", model: "second", reasoningEfforts: ["low", "high", "xhigh"], quota: { tier: "limited", usedPercent: 80, window: "weekly" } },
];
const levels: NormalizedJevLevels = {
  routine: { candidates: [{ provider: "a", model: "first" }] },
  hard: { candidates: [{ provider: "a", model: "first", effort: "low" }, { provider: "b", model: "second", effort: "high" }, { provider: "b", model: "second", effort: "xhigh" }] },
};
const base = { body: { input: "Repair the race." }, candidates, levels, config: { providers: {} } as unknown as OcxConfig, fallback: { targetKey: "global", effort: null }, levelSelect: "route" as const, decisionModel: "router/small", post: async () => { throw new Error("HTTP decision service must not be used"); } };
function invoking(second: string | Error, calls: JevModelInvokeRequest[] = []): JevModelInvoke {
  return async request => {
    calls.push(request);
    if (calls.length === 1) return { text: '{"choice":"hard"}', usage: { input_tokens: 10, outputTokens: 2 } };
    if (second instanceof Error) throw second;
    return { text: second, usage: { inputTokens: 20, input_tokens: 200, output_tokens: 3 } };
  };
}

describe("hierarchical model routing", () => {
  test("invokes the same model twice with level then fixed narrowed route instructions", async () => {
    const calls: JevModelInvokeRequest[] = [];
    const result = await resolveJevComboDecision({ ...base, invokeModel: invoking('{"choice":"b/second:xhigh"}', calls) });
    expect(result).toMatchObject({ backend: "model", targetKey: "b/second", effort: "xhigh", gate: "apply", levelSelectPath: "route", levelSelectQuotaSent: true, usage: { inputTokens: 30, outputTokens: 5 } });
    expect(calls.map(c => [c.model, c.instructions])).toEqual([["router/small", JEV_MODEL_LEVEL_INSTRUCTIONS], ["router/small", JEV_MODEL_INSTRUCTIONS]]);
    expect(calls[0]!.input).not.toContain("b/second");
    expect(Object.keys(JSON.parse(calls[1]!.input).options)).toEqual(["a/first:low", "b/second:high", "b/second:xhigh"]);
    expect(calls[1]!.input).toContain("Quota limited");
  });

  for (const [gate, response] of [
    ["invalid", '{"choice":"a/first:high"}'],
    ["malformed", "not JSON"],
    ["network", new Error("unexpected operational error")],
    ["http", new JevModelInvokeError("http")],
    ["missing_key", new JevModelInvokeError("missing_key")],
    ["timeout", new DOMException("deadline", "TimeoutError")],
  ] as const) test(`${gate} retains the level backup, not the global fallback`, async () => {
    expect(await resolveJevComboDecision({ ...base, invokeModel: invoking(response) })).toMatchObject({ targetKey: "a/first", effort: "low", gate: "apply", levelSelectPath: "order_fallback", levelSelectGate: gate });
  });

  test("fallback level is the sole stage-two allowlist", async () => {
    const ls: NormalizedJevLevels = { hard: { candidates: [{ provider: "absent", model: "gone" }] }, routine: levels.hard };
    const result = await resolveJevComboDecision({ ...base, levels: ls, invokeModel: invoking('{"choice":"b/second:high"}') });
    expect(result).toMatchObject({ level: "hard", levelPath: "fallback_level", levelSelectPath: "route", targetKey: "b/second", effort: "high" });
  });

  test("singleton, missing invoker, and failed classifier skip the second invocation", async () => {
    const calls: JevModelInvokeRequest[] = [];
    const singleton = { ...levels, hard: levels.routine };
    expect(await resolveJevComboDecision({ ...base, levels: singleton, invokeModel: invoking("invalid", calls) })).toMatchObject({ levelSelectGate: "no_choices", targetKey: "a/first", effort: "medium" });
    expect(calls).toHaveLength(1);
    expect(await resolveJevComboDecision(base)).toMatchObject({ levelPath: "fail_open", gate: "missing_key" });
    let count = 0;
    const failed = await resolveJevComboDecision({ ...base, invokeModel: async () => { count++; return { text: "invalid" }; } });
    expect(failed).toMatchObject({ levelPath: "fail_open", gate: "malformed" });
    expect(failed).not.toHaveProperty("levelSelectPath");
    expect(count).toBe(1);
  });

  test("private deadline aborts the second model within the remaining sub-second budget", async () => {
    const started = Date.now();
    let count = 0;
    const invokeModel: JevModelInvoke = async request => {
      if (++count === 1) {
        await new Promise(resolve => setTimeout(resolve, 700));
        return { text: '{"choice":"hard"}' };
      }
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    };
    const result = await resolveJevComboDecision({ ...base, timeoutMs: 1000, invokeModel });
    expect(result).toMatchObject({ gate: "apply", levelSelectGate: "timeout", targetKey: "a/first", effort: "low" });
    expect(Date.now() - started).toBeLessThan(1600);
    expect(count).toBe(2);
  });

  for (const stage of [1, 2]) test(`caller abort during model stage ${stage} propagates its reason`, async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller timeout", "TimeoutError");
    let count = 0;
    await expect(resolveJevComboDecision({ ...base, signal: controller.signal, invokeModel: async () => {
      if (++count === stage) controller.abort(reason);
      return { text: count === 1 ? '{"choice":"hard"}' : '{"choice":"b/second:high"}' };
    } })).rejects.toBe(reason);
  });
});
