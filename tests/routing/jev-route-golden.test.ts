import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JEV_API_URL, resolveJevDecision, type JevCandidate, type ResolveJevDecisionOptions } from "../../src/combos/jev";
import { resolveJevLevelDecision } from "../../src/combos/jev-level";
import type { NormalizedJevLevels } from "../../src/combos/jev-level-config";
import type { OcxConfig } from "../../src/types";
import { fixturePath } from "../helpers/repo-root";

/**
 * Route-mode decision bodies recorded from the code before level mode existed (91cc62a4d).
 * Level mode shares the transport with route mode; this pins route mode's wire bytes instead of
 * resting byte-identity on reading the refactor.
 */
const golden = JSON.parse(readFileSync(fixturePath("jev-route-request-golden.json"), "utf8")) as {
  candidates: JevCandidate[];
  body: unknown;
  requests: Record<string, string>;
};

const config = {
  port: 0,
  defaultProvider: "openai",
  providers: {
    openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, authMode: "key", apiKey: "typesafe-key", liveModels: false },
    "tev1-local": {
      adapter: "jev-decision",
      baseUrl: "http://127.0.0.1:11434/v1/systemone",
      allowPrivateNetwork: true,
      defaultModel: "tev1:4b",
      liveModels: false,
    },
  },
} as OcxConfig;

test("route-mode decision requests are byte-identical to the pre-level-mode recording", async () => {
  expect(Object.keys(golden.requests)).toEqual(["jev", "jev+quota", "tev1-local", "tev1-local+quota"]);
  for (const [name, expected] of Object.entries(golden.requests)) {
    const [decisionProvider, withQuota] = name.split("+");
    const bodies: string[] = [];
    const post = (async (_name, _provider, _url, init) => {
      bodies.push(String(init.body));
      return Response.json({});
    }) as NonNullable<ResolveJevDecisionOptions["post"]>;
    // Unset, empty, and empty-section prompts all leave the request on the built-in wording.
    for (const decisionPrompt of [undefined, {}, { route: { effortProfiles: {} } }]) await resolveJevDecision({
      decisionPrompt,
      body: golden.body,
      config,
      decisionProvider,
      candidates: withQuota ? golden.candidates : golden.candidates.map(({ quota: _quota, ...rest }) => rest),
      fallback: { targetKey: golden.candidates[0]!.key, effort: null },
      post,
    });
    expect(bodies).toEqual([expected, expected, expected]);
  }
});

/**
 * Level-mode decision bodies recorded from 47581f7a0 (the level-mode reference); bodies regenerated
 * by that revision were checked byte-for-byte against this fixture.
 */
const levelGolden = JSON.parse(readFileSync(fixturePath("jev-level-request-golden.json"), "utf8")) as {
  levels: NormalizedJevLevels;
  requests: Record<string, string>;
};
test("level-mode request bytes match the level-mode recording", async () => {
  for (const [decisionProvider, expected] of Object.entries(levelGolden.requests)) {
    const bodies: string[] = [];
    for (const decisionPrompt of [undefined, {}, { route: {} }]) await resolveJevLevelDecision({
      body: golden.body, config, decisionProvider, decisionPrompt,
      levels: levelGolden.levels, candidates: golden.candidates,
      fallback: { targetKey: golden.candidates[0]!.key, effort: null },
      post: (async (_name, _provider, _url, init) => { bodies.push(String(init.body)); return Response.json({}); }) as NonNullable<ResolveJevDecisionOptions["post"]>,
    });
    expect(bodies).toEqual([expected, expected, expected]);
  }
});
