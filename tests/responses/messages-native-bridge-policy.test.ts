/**
 * Operator policy only the bridge applies keeps a Messages request off the managed native lane
 * (`bridge-only-policy`): a pinned route effort, a blocked-skill bundle the translator would
 * elide, and a web-search tool the sidecar could serve. The planner reports the config-only part
 * of the same rule.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicBodyElidesBlockedSkill } from "../../src/claude/inbound";
import { buildProtocolPlanSnapshot } from "../../src/protocols/plan-snapshot";
import type { RouteResult } from "../../src/router";
import { nativeMessagesDeclineReason } from "../../src/server/messages-native-eligibility";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-bridge-policy-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function config(overrides: Partial<OcxConfig> = {}, provider: Record<string, unknown> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "anth",
    providers: {
      anth: { adapter: "anthropic", baseUrl: "https://anth.example/v1", authMode: "key", apiKey: "ka", models: ["claude-x"], ...provider },
    },
    protocols: { rollout: { managedMessagesNative: true } },
    ...overrides,
  } as OcxConfig;
}

function route(provider: Record<string, unknown> = {}): RouteResult {
  return {
    providerName: "anth",
    modelId: "claude-x",
    routeKind: "direct",
    routeReason: "test",
    provider: { adapter: "anthropic", baseUrl: "https://anth.example/v1", apiKey: "ka", ...provider },
  } as unknown as RouteResult;
}

const TEXT_BODY = { messages: [{ role: "user", content: "fixture" }] };

const SKILL_BUNDLE = `Base directory for this skill: /fixture/skills/claude-api\n${"x".repeat(12_000)}`;

describe("pinned route effort", () => {
  test("a provider or model pin keeps the request on the bridge", () => {
    expect(nativeMessagesDeclineReason(route({ pinnedReasoningEffort: "high" }), TEXT_BODY, config()))
      .toBe("bridge-only-policy");
    expect(nativeMessagesDeclineReason(route({ modelPinnedReasoningEfforts: { "claude-x": "low" } }), TEXT_BODY, config()))
      .toBe("bridge-only-policy");
  });

  test("a global pin is read through the bridge's selector", () => {
    const pinned = config({ modelPinnedEfforts: { "anth/claude-x": "medium" } } as Partial<OcxConfig>);
    expect(nativeMessagesDeclineReason(route(), TEXT_BODY, pinned, { routeSelector: "anth/claude-x" }))
      .toBe("bridge-only-policy");
    expect(nativeMessagesDeclineReason(route(), TEXT_BODY, config(), { routeSelector: "anth/claude-x" })).toBeUndefined();
  });

  test("the planner reports the pin as the decline reason", () => {
    const snapshot = buildProtocolPlanSnapshot(config({}, { pinnedReasoningEffort: "high" }),
      { model: "anth/claude-x", inbound: "messages", features: [] });
    expect(snapshot.candidates[0]).toMatchObject({ nativeEligible: false, declineReasons: ["bridge-only-policy"] });
  });
});

describe("blocked-skill elision", () => {
  const bundleBody = { messages: [{ role: "user", content: [{ type: "text", text: SKILL_BUNDLE }] }] };
  const resultBody = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "claude-api" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: "Launching skill" }] },
    ],
  };

  test("a bundle or a blocked Skill result the translator would stub declines the native lane", () => {
    expect(anthropicBodyElidesBlockedSkill(bundleBody)).toBe(true);
    expect(anthropicBodyElidesBlockedSkill(resultBody)).toBe(true);
    expect(nativeMessagesDeclineReason(route(), bundleBody, config())).toBe("bridge-only-policy");
    expect(nativeMessagesDeclineReason(route(), resultBody, config())).toBe("bridge-only-policy");
  });

  test("nothing to elide, or no blocked skills, stays native", () => {
    expect(anthropicBodyElidesBlockedSkill(TEXT_BODY)).toBe(false);
    const short = { messages: [{ role: "user", content: [{ type: "text", text: "Base directory for this skill: /x/claude-api" }] }] };
    expect(anthropicBodyElidesBlockedSkill(short)).toBe(false);
    const unblocked = config({ claudeCode: { blockedSkills: [] } } as Partial<OcxConfig>);
    expect(nativeMessagesDeclineReason(route(), bundleBody, unblocked)).toBeUndefined();
  });
});

describe("web-search sidecar", () => {
  const searchBody = { ...TEXT_BODY, tools: [{ type: "web_search_20250305", name: "web_search" }] };

  test("a web_search server tool the sidecar could serve declines the native lane", () => {
    expect(nativeMessagesDeclineReason(route(), searchBody, config())).toBe("bridge-only-policy");
    expect(nativeMessagesDeclineReason(route(), { ...searchBody, tool_choice: { type: "tool", name: "web_search" } }, config()))
      .toBe("bridge-only-policy");
  });

  test("a disabled sidecar or a tool choice that excludes search stays native", () => {
    const off = config({ claudeCode: { webSearchSidecar: { enabled: false } } } as Partial<OcxConfig>);
    expect(nativeMessagesDeclineReason(route(), searchBody, off)).toBeUndefined();
    expect(nativeMessagesDeclineReason(route(), { ...searchBody, tool_choice: { type: "none" } }, config())).toBeUndefined();
    expect(nativeMessagesDeclineReason(route(), { ...searchBody, tool_choice: { type: "tool", name: "lookup" } }, config()))
      .toBeUndefined();
  });
});
