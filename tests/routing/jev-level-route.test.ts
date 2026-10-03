import { describe, expect, test } from "bun:test";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import { projectJevLevelCandidates, selectJevLevelCandidate } from "../../src/combos/jev-level";
import type { JevCandidate, ResolveJevDecisionOptions } from "../../src/combos/jev";
import type { NormalizedJevLevels } from "../../src/combos/jev-level-config";
import { aggregateJevLevelUsage } from "../../src/combos/jev-level-usage";
import type { OcxConfig } from "../../src/types";

const config = { providers: { jev: { apiKey: "test-only", baseUrl: "https://api.typesafe.ai/v1/systemone", adapter: "jev-decision" } } } as unknown as OcxConfig;
const candidates: JevCandidate[] = [
  { key: "a/fast", provider: "a", model: "fast", reasoningEfforts: ["low", "medium", "high"] },
  { key: "b/deep", provider: "b", model: "deep", reasoningEfforts: ["low", "high", "xhigh"] },
  { key: "c/outside", provider: "c", model: "outside", reasoningEfforts: ["high"] },
];
const levels: NormalizedJevLevels = {
  routine: { candidates: [{ provider: "c", model: "outside" }] },
  hard: { candidates: [{ provider: "a", model: "fast" }, { provider: "b", model: "deep", effort: "high" }, { provider: "b", model: "deep", effort: "xhigh" }] },
};
const base = { config, candidates, levels, fallback: { targetKey: "c/outside", effort: "high" as const }, body: { input: "Fix a race." }, levelSelect: "route" as const };
const levelResponse = (choice = "hard", usage?: Record<string, number>) => Response.json({ answers: { level: { choice, confidence: 0.8 } }, ...(usage ? { usage } : {}) });
const routeResponse = (choice = "b/deep:xhigh", usage?: Record<string, number>) => Response.json({ answers: { route: { choice, confidence: 0.2 } }, ...(usage ? { usage } : {}) });
function posting(responses: Array<Response | Error>, calls: string[] = []): NonNullable<ResolveJevDecisionOptions["post"]> {
  return (async (_name, _provider, _url, init) => {
    calls.push(String(init.body));
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("unexpected decision call");
    return response;
  }) as NonNullable<ResolveJevDecisionOptions["post"]>;
}

describe("hierarchical service routing", () => {
  test("routes a non-first target and effort, preserving classifier evidence and the narrowed wire map", async () => {
    const calls: string[] = [];
    const result = await resolveJevComboDecision({ ...base, post: posting([levelResponse(), routeResponse()], calls) });
    expect(result).toMatchObject({ gate: "apply", level: "hard", levelPath: "chosen", targetKey: "b/deep", effort: "xhigh", confidence: 0.8, levelSelectPath: "route", levelSelectGate: "apply" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("a/fast");
    const criteria = JSON.parse(calls[1]!).questions.route.criteria;
    expect(Object.keys(criteria)).toEqual(["a/fast:medium", "b/deep:high", "b/deep:xhigh"]);
  });

  test("routes the fallback level only and skips global fail-open", async () => {
    const fallbackLevels: NormalizedJevLevels = { routine: levels.hard, hard: { candidates: [{ provider: "missing", model: "gone" }] } };
    const calls: string[] = [];
    const result = await resolveJevComboDecision({ ...base, levels: fallbackLevels, post: posting([levelResponse(), routeResponse()], calls) });
    expect(result).toMatchObject({ level: "hard", levelPath: "fallback_level", levelSelectPath: "route", targetKey: "b/deep" });
    const globalCalls: string[] = [];
    const global = await resolveJevComboDecision({ ...base, candidates: [], post: posting([], globalCalls) });
    expect(global).toMatchObject({ gate: "no_choices", levelPath: "fail_open", ...base.fallback });
    expect(globalCalls).toHaveLength(0);
    expect(global).not.toHaveProperty("levelSelectPath");
  });

  test("classification failures do not start a route call", async () => {
    const calls: string[] = [];
    const result = await resolveJevComboDecision({ ...base, post: posting([Response.json({})], calls) });
    expect(result).toMatchObject({ gate: "invalid", levelPath: "fail_open", ...base.fallback });
    expect(result).not.toHaveProperty("levelSelectPath");
    expect(calls).toHaveLength(1);
  });

  test("projects first target/effort order, deduplicates effective defaults, and never mutates inputs", () => {
    const list = { candidates: [
      { provider: "b", model: "deep", effort: "xhigh" as const },
      { provider: "a", model: "fast" },
      { provider: "b", model: "deep", effort: "high" as const },
      { provider: "a", model: "fast", effort: "medium" as const },
      { provider: "a", model: "fast", effort: "ultra" as const },
      { provider: "absent", model: "gone" },
    ] };
    const original = JSON.stringify({ candidates, list });
    const projected = projectJevLevelCandidates(list, candidates);
    expect(projected.map(c => [c.key, c.reasoningEfforts])).toEqual([["b/deep", ["xhigh", "high"]], ["a/fast", ["medium"]]]);
    expect(JSON.stringify({ candidates, list })).toBe(original);
    expect(projected[0]).not.toBe(candidates[1]);
    for (const [ladder, expected] of [[[], []], [["high"], ["high"]], [["low", "xhigh"], ["low"]]] as const) {
      expect(projectJevLevelCandidates({ candidates: [{ provider: "a", model: "fast" }] }, [{ ...candidates[0]!, reasoningEfforts: ladder }])[0]!.reasoningEfforts).toEqual(expected);
    }
  });

  test("single effective option skips routing; multiple efforts on one target route", async () => {
    const single = { ...levels, hard: { candidates: [{ provider: "a", model: "fast" }, { provider: "a", model: "fast", effort: "medium" as const }] } };
    const calls: string[] = [];
    expect(await resolveJevComboDecision({ ...base, levels: single, post: posting([levelResponse()], calls) })).toMatchObject({ targetKey: "a/fast", effort: "medium", levelSelectPath: "order_fallback", levelSelectGate: "no_choices" });
    expect(calls).toHaveLength(1);
    const multiple = { ...single, hard: { candidates: [...single.hard.candidates, { provider: "a", model: "fast", effort: "high" as const }] } };
    expect(await resolveJevComboDecision({ ...base, levels: multiple, post: posting([levelResponse(), routeResponse("a/fast:high")]) })).toMatchObject({ effort: "high", levelSelectPath: "route" });
  });

  for (const [gate, response] of [
    ["http", () => new Response("", { status: 503 })],
    ["malformed", () => new Response("not JSON")],
    ["invalid", () => routeResponse("c/outside:high")],
    ["network", () => new Error("transport failed")],
    ["timeout", () => new DOMException("deadline", "TimeoutError")],
    ["redirect", () => new Response("", { status: 302, headers: { location: "https://elsewhere.invalid" } })],
  ] as const) {
    test(`${gate} retains the exact quota-aware deterministic backup`, async () => {
      const quotaCandidates = candidates.map(c => ({ ...c, quota: { tier: c.provider === "a" ? "nearly_exhausted" as const : "healthy" as const } }));
      const backup = selectJevLevelCandidate(levels.hard, quotaCandidates, true)!;
      const result = await resolveJevComboDecision({ ...base, candidates: quotaCandidates, quotaAware: true, post: posting([levelResponse(), response()]) });
      expect(result).toMatchObject({ gate: "apply", levelSelectPath: "order_fallback", levelSelectGate: gate, targetKey: backup.targetKey, effort: backup.effort, levelSelectQuotaSent: true });
    });
  }

  test("one shared deadline refuses late routing and accounts complete latency and usage", async () => {
    let clock = 0;
    const post = posting([levelResponse("hard", { inputTokens: 4, input_tokens: 400, output_tokens: 2 }), routeResponse("b/deep:xhigh", { input_tokens: 6, outputTokens: 3 })]);
    let calls = 0;
    const result = await resolveJevComboDecision({ ...base, timeoutMs: 1000, now: () => clock, post: (async (...args) => {
      calls++;
      clock += calls === 1 ? 750 : 200;
      return post(...args);
    }) as typeof post });
    expect(result).toMatchObject({ latencyMs: 950, usage: { inputTokens: 10, outputTokens: 5 }, levelSelectPath: "route" });
    const lateCalls: string[] = [];
    clock = 0;
    const late = await resolveJevComboDecision({ ...base, timeoutMs: 1000, now: () => clock, post: (async (...args) => {
      clock = 1001;
      return posting([levelResponse()], lateCalls)(...args);
    }) as typeof post });
    expect(late).toMatchObject({ gate: "apply", targetKey: "a/fast", levelSelectGate: "timeout" });
    expect(lateCalls).toHaveLength(1);
    expect(aggregateJevLevelUsage({ inputTokens: Number.MAX_SAFE_INTEGER }, { input_tokens: 10, outputTokens: 0 })).toEqual({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
    expect(aggregateJevLevelUsage({ input_tokens: -1 })).toBeUndefined();
  });

  test("an exhausted budget keeps apply when the classified level has no usable candidate", async () => {
    const empty: NormalizedJevLevels = { routine: { candidates: [{ provider: "missing", model: "gone" }] }, hard: { candidates: [{ provider: "absent", model: "gone" }] } };
    const decide = async (levelSelect: "route" | undefined) => {
      let clock = 0;
      const post = posting([levelResponse()]);
      return resolveJevComboDecision({ ...base, levels: empty, levelSelect, timeoutMs: 1000, now: () => clock, post: (async (...args) => {
        clock = 1001;
        return post(...args);
      }) as typeof post });
    };
    const routed = await decide("route");
    expect(routed).toMatchObject({ gate: "apply", level: "hard", levelPath: "fail_open", ...base.fallback });
    expect(routed).not.toHaveProperty("levelSelectPath");
    expect(routed).toEqual(await decide(undefined));
  });

  for (const stage of [0, 1, 2]) test(`caller cancellation at stage ${stage} preserves TimeoutError identity`, async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller deadline", "TimeoutError");
    let calls = 0;
    if (stage === 0) controller.abort(reason);
    const post = (async () => {
      if (++calls === stage) controller.abort(reason);
      return calls === 1 ? levelResponse() : routeResponse();
    }) as NonNullable<ResolveJevDecisionOptions["post"]>;
    await expect(resolveJevComboDecision({ ...base, signal: controller.signal, post })).rejects.toBe(reason);
  });

  test("omitted selection stays one call with unchanged level payload and no stage metadata", async () => {
    const legacyCalls: string[] = [], routeCalls: string[] = [];
    const legacy = await resolveJevComboDecision({ ...base, levelSelect: undefined, post: posting([levelResponse()], legacyCalls), now: () => 0 });
    await resolveJevComboDecision({ ...base, post: posting([levelResponse(), routeResponse()], routeCalls) });
    expect(legacyCalls).toEqual([routeCalls[0]!]);
    expect(legacy).not.toHaveProperty("levelSelectPath");
    expect(legacy).toMatchObject({ targetKey: "a/fast", effort: "medium" });
  });

  for (const count of [26, 27]) test(`self-hosted ${count}-option bound never truncates`, async () => {
    const cs = Array.from({ length: count }, (_, i) => ({ key: `p/m${i}`, provider: "p", model: `m${i}`, reasoningEfforts: [] }));
    const ls: NormalizedJevLevels = { routine: levels.routine, hard: { candidates: cs.map(c => ({ provider: c.provider, model: c.model })) } };
    const cfg = { providers: { tev: { adapter: "jev-decision", baseUrl: "http://localhost:11434/api/systemone", defaultModel: "tev1", allowPrivateNetwork: true } } } as unknown as OcxConfig;
    const calls: string[] = [];
    const result = await resolveJevComboDecision({ ...base, config: cfg, candidates: cs, levels: ls, decisionProvider: "tev", post: posting([levelResponse(), routeResponse("p/m25:none")], calls) });
    expect(result.levelSelectGate).toBe(count === 26 ? "apply" : "invalid");
    expect(calls).toHaveLength(count === 26 ? 2 : 1);
  });
});
