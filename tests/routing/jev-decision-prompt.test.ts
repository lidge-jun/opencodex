import { describe, expect, test } from "bun:test";
import { comboConfigIssues, normalizeComboConfig } from "../../src/combos/types";
import { buildJevRouteQuestion, resolveJevDecision, type JevCandidate, type ResolveJevDecisionOptions } from "../../src/combos/jev";
import { buildJevLevelQuestion, jevModelLevelInstructions, projectJevLevelCandidates, resolveJevLevelDecision } from "../../src/combos/jev-level";
import { JEV_MODEL_INSTRUCTIONS, resolveJevModelDecision, type JevModelInvoke, type JevModelInvokeRequest } from "../../src/combos/jev-model-backend";
import { JEV_EFFORT_DEFAULT_PROFILES, JEV_LEVEL_INSTRUCTIONS, JEV_PROMPT_MAX_FIELD_CHARS, JEV_ROUTE_DEFAULT_INSTRUCTIONS, normalizeJevPromptFields, type JevDecisionPrompt } from "../../src/combos/jev-decision-contract";
import type { OcxComboConfig, OcxConfig } from "../../src/types";

const candidates: JevCandidate[] = [
  { key: "a/one", provider: "a", model: "one", reasoningEfforts: ["low", "high"] },
  { key: "a/two", provider: "a", model: "two", reasoningEfforts: ["low", "high"] },
];
const targets = candidates.map(({ provider, model }) => ({ provider, model }));
const levels = { trivial: { candidates: [targets[0]!] }, routine: { candidates: [targets[1]!] } };
const routeLevels = { trivial: levels.trivial, hard: { candidates: [targets[0]!, { ...targets[1]!, effort: "high" as const }] } };
const providers = { a: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } as OcxConfig["providers"];
const combo = { strategy: "jev", targets } as OcxComboConfig;
const config = { port: 0, defaultProvider: "a", providers: {
  ...providers,
  local: { adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", allowPrivateNetwork: true, defaultModel: "tev1:4b" },
} } as OcxConfig;

function instructions(prompt?: JevDecisionPrompt, descriptiveCriteria = false) {
  return (buildJevRouteQuestion(candidates, { decisionPrompt: prompt, descriptiveCriteria }).route as { instructions: Record<string, unknown> }).instructions;
}

describe("JEV per-combo decision wording", () => {
  test("substitutes every route field independently without changing criteria or other instructions", () => {
    for (const descriptiveCriteria of [false, true]) {
      const baseline = buildJevRouteQuestion(candidates, { descriptiveCriteria });
      for (const key of Object.keys(JEV_ROUTE_DEFAULT_INSTRUCTIONS) as Array<keyof typeof JEV_ROUTE_DEFAULT_INSTRUCTIONS>) {
        const custom = `Custom ${key}.`;
        const prompt = { route: { [key]: custom } };
        expect(instructions(prompt, descriptiveCriteria)).toEqual({ ...instructions(undefined, descriptiveCriteria), [key]: custom });
        expect((buildJevRouteQuestion(candidates, { decisionPrompt: prompt, descriptiveCriteria }).route as { criteria: unknown }).criteria)
          .toEqual((baseline.route as { criteria: unknown }).criteria);
      }
      for (const effort of Object.keys(JEV_EFFORT_DEFAULT_PROFILES)) {
        expect(instructions({ route: { effortProfiles: { [effort]: "Custom effort." } } }, descriptiveCriteria).effort_profiles)
          .toEqual({ ...JEV_EFFORT_DEFAULT_PROFILES, [effort]: "Custom effort." });
      }
    }
  });

  test("substitutes the level instruction and descriptions without sending target text", () => {
    const question = buildJevLevelQuestion({ ...levels, trivial: { ...levels.trivial, description: "Custom trivial." } }, { levelInstructions: "Custom classification." });
    expect(question.level).toMatchObject({ instructions: "Custom classification.", criteria: { trivial: "Custom trivial." } });
    expect(JSON.stringify(question)).not.toContain("a/one");
    expect(buildJevLevelQuestion(levels).level).toMatchObject({ instructions: JEV_LEVEL_INSTRUCTIONS });
  });

  test("stores only trimmed non-default overrides and drops empty containers", () => {
    const decisionPrompt = { levelInstructions: " Custom level. \n", route: { question: " Custom question. ", speed: JEV_ROUTE_DEFAULT_INSTRUCTIONS.speed, effortProfiles: { low: " Custom low. ", high: JEV_EFFORT_DEFAULT_PROFILES.high } } };
    expect(normalizeComboConfig({ ...combo, decisionPrompt }).decisionPrompt).toEqual({ levelInstructions: "Custom level.", route: { question: "Custom question.", effortProfiles: { low: "Custom low." } } });
    for (const decisionPrompt of [undefined, null, {}, { route: {} }, { route: { effortProfiles: {} } }, { levelInstructions: JEV_LEVEL_INSTRUCTIONS }]) {
      expect(normalizeJevPromptFields({ decisionPrompt })).toEqual({});
    }
  });

  test("validates strategy, containers, known fields, bounded non-empty text and control characters", () => {
    for (const decisionPrompt of [null, {}, { route: {} }, { levelInstructions: "Line\ttext\nnext\rline" }, { route: { effortProfiles: { low: "x".repeat(JEV_PROMPT_MAX_FIELD_CHARS) } } }]) {
      expect(comboConfigIssues("auto", { ...combo, decisionPrompt }, providers)).toEqual([]);
    }
    for (const decisionPrompt of [[], "bad", { unknown: "bad" }, { route: null }, { route: { unknown: "bad" } }, { route: { effortProfiles: [] } }, { route: { effortProfiles: { extreme: "bad" } } }]) {
      expect(comboConfigIssues("auto", { ...combo, decisionPrompt }, providers).length).toBeGreaterThan(0);
    }
    for (const bad of ["", " \n ", null, 1, "x".repeat(JEV_PROMPT_MAX_FIELD_CHARS + 1), "bad\u0000", "bad\u000b", "bad\u007f", "bad\u2028", "bad\u2029"]) {
      for (const decisionPrompt of [{ levelInstructions: bad }, { route: { question: bad } }, { route: { effortProfiles: { low: bad } } }]) {
        expect(comboConfigIssues("auto", { ...combo, decisionPrompt }, providers)[0]?.path[0]).toBe("decisionPrompt");
      }
    }
    expect(comboConfigIssues("auto", { ...combo, strategy: "failover", decisionPrompt: {} }, providers)[0]?.message).toContain('strategy "jev"');
  });

  test("real decision posts carry overrides in both modes", async () => {
    const requests: Array<{ questions: Record<string, { instructions: unknown }> }> = [];
    const post = (async (_name, _provider, _url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({});
    }) as NonNullable<ResolveJevDecisionOptions["post"]>;
    const base = { body: { input: "Review this function." }, candidates, config, decisionProvider: "local", fallback: { targetKey: candidates[0]!.key, effort: null }, post };
    await resolveJevDecision({ ...base, decisionPrompt: { route: { question: "Custom request question." } } });
    await resolveJevLevelDecision({ ...base, levels, decisionPrompt: { levelInstructions: "Custom request classification." } });
    expect(requests[0]!.questions.route!.instructions).toMatchObject({ question: "Custom request question." });
    expect(requests[1]!.questions.level!.instructions).toBe("Custom request classification.");
  });

  test("hierarchical selection classifies with levelInstructions and routes with plain route-mode wording", async () => {
    const decisionPrompt = { levelInstructions: "Custom classification.", route: { question: "Custom question.", effortProfiles: { low: "Custom low." } } };
    const answers = [{ level: { choice: "hard" } }, { route: { choice: "a/two:high" } }, { route: { choice: "a/two:high" } }];
    const requests: Array<{ questions: Record<string, { instructions: unknown }> }> = [];
    const post = (async (_name, _provider, _url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ answers: answers.shift() });
    }) as NonNullable<ResolveJevDecisionOptions["post"]>;
    const base = { body: { input: "Review this function." }, candidates, config, decisionProvider: "local", fallback: { targetKey: candidates[0]!.key, effort: null }, post, decisionPrompt };
    const result = await resolveJevLevelDecision({ ...base, levels: routeLevels, levelSelect: "route" });
    const narrowed = projectJevLevelCandidates(routeLevels.hard, candidates);
    await resolveJevDecision({ ...base, candidates: narrowed });
    expect(result).toMatchObject({ level: "hard", levelSelectPath: "route", targetKey: "a/two", effort: "high" });
    expect(requests).toHaveLength(3);
    expect(requests[0]!.questions.level!.instructions).toBe("Custom classification.");
    expect(JSON.stringify(requests[0])).not.toContain("Custom question.");
    expect(requests[1]!.questions.route!.instructions).toEqual(requests[2]!.questions.route!.instructions);
    expect(requests[1]!.questions.route!.instructions).toEqual((buildJevRouteQuestion(narrowed, { decisionPrompt }).route as { instructions: unknown }).instructions);
    expect(requests[1]!.questions.route!.instructions).toMatchObject({ question: "Custom question.", effort_profiles: { ...JEV_EFFORT_DEFAULT_PROFILES, low: "Custom low." } });
    expect(JSON.stringify(requests[1])).not.toContain("Custom classification.");
  });

  test("hierarchical decisionModel selection keeps the fixed route instructions plain route mode sends", async () => {
    const decisionPrompt = { levelInstructions: "Custom classification.", route: { question: "Custom question." } };
    const calls: JevModelInvokeRequest[] = [];
    const replies = ['{"choice":"hard"}', '{"choice":"a/two:high"}', '{"choice":"a/two:high"}'];
    const invokeModel: JevModelInvoke = async request => { calls.push(request); return { text: replies.shift()! }; };
    const base = { body: { input: "Review this function." }, candidates, config, decisionModel: "router/small", invokeModel, fallback: { targetKey: candidates[0]!.key, effort: null }, decisionPrompt };
    const result = await resolveJevLevelDecision({ ...base, levels: routeLevels, levelSelect: "route" });
    await resolveJevModelDecision({ ...base, candidates: projectJevLevelCandidates(routeLevels.hard, candidates) });
    expect(result).toMatchObject({ backend: "model", levelSelectPath: "route", targetKey: "a/two", effort: "high" });
    expect(calls.map(call => call.instructions)).toEqual([jevModelLevelInstructions(decisionPrompt), JEV_MODEL_INSTRUCTIONS, JEV_MODEL_INSTRUCTIONS]);
    expect(calls[0]!.instructions).toContain("Custom classification.");
    expect(calls.map(call => call.input).join("\n")).not.toContain("Custom question.");
  });

  test("an oversized decision request fails open as invalid before posting, in both modes", async () => {
    let posts = 0;
    const post = (async () => { posts++; return Response.json({}); }) as NonNullable<ResolveJevDecisionOptions["post"]>;
    const base = { body: { input: "Review this function." }, candidates, config, decisionProvider: "local", fallback: { targetKey: candidates[0]!.key, effort: null }, post };
    expect((await resolveJevDecision({ ...base, decisionPrompt: { route: { question: "x".repeat(70_000) } } })).gate).toBe("invalid");
    expect((await resolveJevLevelDecision({ ...base, levels, decisionPrompt: { levelInstructions: "x".repeat(70_000) } })).gate).toBe("invalid");
    expect(posts).toBe(0);
  });
});
