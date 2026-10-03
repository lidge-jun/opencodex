import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import type { JevCandidate, ResolveJevDecisionOptions } from "../../src/combos/jev";
import { JEV_MODEL_INSTRUCTIONS } from "../../src/combos/jev-model-backend";
import type { NormalizedJevLevels } from "../../src/combos/jev-level-config";
import type { OcxConfig } from "../../src/types";
import { fixturePath } from "../helpers/repo-root";

const fixture = JSON.parse(readFileSync(fixturePath("jev-level-route-request-golden.json"), "utf8")) as {
  body: unknown; candidates: JevCandidate[]; levels: NormalizedJevLevels;
  expected: Record<string, { first: string; second: string }>;
  model: { instructions: string; first: string; second: string };
};
for (const backend of ["typesafe", "systemone"] as const) for (const quota of [false, true]) {
  test(`hierarchical ${backend} wire bytes with quota ${quota}`, async () => {
    const candidates = fixture.candidates.map(c => quota ? c : (({ quota: _quota, ...rest }) => rest)(c));
    const config = { providers: { jev: { adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone", apiKey: "test-only" }, tev: { adapter: "jev-decision", baseUrl: "http://localhost:11434/v1/systemone", defaultModel: "tev1", allowPrivateNetwork: true } } } as unknown as OcxConfig;
    const calls: string[] = [];
    const result = await resolveJevComboDecision({
      config, body: fixture.body, candidates, levels: fixture.levels, levelSelect: "route", quotaAware: quota,
      fallback: { targetKey: candidates[0]!.key, effort: "medium" },
      ...(backend === "systemone" ? { decisionProvider: "tev" } : {}),
      post: (async (_name, _provider, _url, init) => {
        calls.push(String(init.body));
        return Response.json({ answers: calls.length === 1 ? { level: { choice: "hard" } } : { route: { choice: "b/deep:xhigh" } } });
      }) as NonNullable<ResolveJevDecisionOptions["post"]>,
    });
    expect(result.levelSelectPath).toBe("route");
    const expected = fixture.expected[`${backend}:${quota}`]!;
    expect(calls).toEqual([expected.first, expected.second]);
    expect(calls[0]).not.toContain("quota");
    expect(result.levelSelectQuotaSent).toBe(quota ? true : undefined);
  });
}

test("hierarchical decision-model input and fixed instructions are pinned", async () => {
  const calls: Array<{ input: string; instructions: string }> = [];
  await resolveJevComboDecision({
    config: { providers: {} } as unknown as OcxConfig, body: fixture.body,
    candidates: fixture.candidates, levels: fixture.levels, levelSelect: "route",
    fallback: { targetKey: "a/fast", effort: "medium" }, decisionModel: "router/small",
    invokeModel: async request => {
      calls.push(request);
      return { text: calls.length === 1 ? '{"choice":"hard"}' : '{"choice":"b/deep:xhigh"}' };
    },
  });
  expect(calls.map(c => c.input)).toEqual([fixture.model.first, fixture.model.second]);
  expect(calls[1]!.instructions).toBe(fixture.model.instructions);
  expect(calls[1]!.instructions).toBe(JEV_MODEL_INSTRUCTIONS);
});
