/**
 * Antigravity direct lane eligibility: the rule the Chat ingress and the protocol planner share.
 */
import { describe, expect, test } from "bun:test";
import { planProtocol, type ProtocolPlanInput } from "../../src/protocols/plan";
import { antigravityDirectDeclineReason, antigravityMessagesDeclineReason, isAntigravityRoute } from "../../src/server/antigravity-direct-eligibility";
import { cacheDiagnosticsObserving } from "../../src/server/request-log";
import "../../src/usage/cache-diagnostic";
import type { RouteResult } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const MODEL = "gemini-3.8-flash";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

function config(extra: Partial<OcxConfig> = {}, rollout = true): OcxConfig {
  return {
    port: 0,
    providers: {},
    protocols: { rollout: { antigravityDirect: rollout } },
    ...extra,
  } as OcxConfig;
}

function route(provider: Partial<OcxProviderConfig> = {}, extra: Partial<RouteResult> = {}, providerName = "google-antigravity"): RouteResult {
  return {
    providerName,
    modelId: MODEL,
    provider: { adapter: "google", googleMode: "cloud-code-assist", baseUrl: "https://daily-cloudcode-pa.googleapis.com", ...provider },
    ...extra,
  } as RouteResult;
}

const chat = (extra: Record<string, unknown> = {}) => ({
  model: `google-antigravity/${MODEL}`,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("antigravityDirectDeclineReason", () => {
  test("an eligible concrete Antigravity route takes the lane", () => {
    expect(antigravityDirectDeclineReason(route(), chat(), config())).toBeUndefined();
  });

  test("the switch is on by default and an explicit false turns it off", () => {
    expect(antigravityDirectDeclineReason(route(), chat(), { port: 0, providers: {} } as OcxConfig)).toBeUndefined();
    expect(antigravityMessagesDeclineReason(route(), { messages: [] }, MODEL, { port: 0, providers: {} } as OcxConfig)).toBeUndefined();
    expect(antigravityDirectDeclineReason(route(), chat(), config({}, false))).toBe("rollout-disabled");
    expect(antigravityDirectDeclineReason(route(), chat(), config({ protocols: { rollout: { antigravityDirect: "true" } } } as never)))
      .toBe("rollout-disabled");
  });

  test("only Google in Cloud Code Assist mode is Antigravity", () => {
    expect(antigravityDirectDeclineReason(route({ googleMode: "vertex" }), chat(), config())).toBe("not-migrated");
    expect(antigravityDirectDeclineReason(route({ googleMode: "ai-studio" }), chat(), config())).toBe("not-migrated");
    expect(antigravityDirectDeclineReason(route({ adapter: "openai-chat", googleMode: undefined }), chat(), config())).toBe("not-migrated");
  });

  test("the registry supplies the mode a saved Antigravity provider omits", () => {
    expect(isAntigravityRoute(route({ googleMode: undefined }))).toBe(true);
    expect(isAntigravityRoute(route({ googleMode: undefined }, {}, "google-vertex"))).toBe(false);
  });

  test("combo and policy routes keep the bridge", () => {
    expect(antigravityDirectDeclineReason(route({}, { combo: { id: "c" } } as never), chat(), config())).toBe("combo-or-policy-route");
    expect(antigravityDirectDeclineReason(route({}, { routeKind: "policy" } as never), chat(), config())).toBe("combo-or-policy-route");
  });

  test("a hosted web-search tool keeps the bridge for the sidecar", () => {
    expect(antigravityDirectDeclineReason(route(), chat({ tools: [{ type: "web_search" }] }), config())).toBe("hosted-tool");
    expect(antigravityDirectDeclineReason(route(), chat({ tools: [{ type: "web_search_preview" }] }), config())).toBe("hosted-tool");
    expect(antigravityDirectDeclineReason(route(), chat({ tools: [{ type: "function", function: { name: "f" } }] }), config()))
      .toBeUndefined();
  });

  test("an image for a model declared text-only keeps the bridge for vision preprocessing", () => {
    const image = chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: PNG } }] }] });
    const textOnly = route({ modelCapabilities: { [MODEL]: { inputModalities: ["text"] } } } as never);
    expect(antigravityDirectDeclineReason(textOnly, image, config())).toBe("vision-preprocessing");
    expect(antigravityDirectDeclineReason(textOnly, chat(), config())).toBeUndefined();
    const vision = route({ modelCapabilities: { [MODEL]: { inputModalities: ["text", "image"] } } } as never);
    expect(antigravityDirectDeclineReason(vision, image, config())).toBeUndefined();
  });

  test("a shadow-call intercept that could move the request keeps the bridge", () => {
    const intercept = { shadowCallIntercept: { enabled: true, model: "combo/helpers", sourceModels: ["gemini-"] } } as Partial<OcxConfig>;
    expect(antigravityDirectDeclineReason(route(), chat({ model: MODEL }), config(intercept))).toBe("bridge-only-policy");
    expect(antigravityDirectDeclineReason(route(), chat(), config(intercept))).toBeUndefined();
  });

  test("text the core rewrites on the bridge body keeps the bridge", () => {
    const skills = chat({ messages: [
      { role: "system", content: "intro <skills_instructions>\n## Skills\n</skills_instructions>" },
      { role: "user", content: "hi" },
    ] });
    expect(antigravityDirectDeclineReason(route(), skills, config())).toBe("bridge-only-policy");
    const generatedImage = chat({ messages: [
      { role: "user", content: "draw" },
      { role: "assistant", content: [{ type: "text", text: "![Generated image](</tmp/artifacts/img.png>)" }] },
      { role: "user", content: "again" },
    ] });
    expect(antigravityDirectDeclineReason(route(), generatedImage, config())).toBe("bridge-only-policy");
    const userMention = chat({ messages: [{ role: "user", content: "what is <skills_instructions>?" }] });
    expect(antigravityDirectDeclineReason(route(), userMention, config())).toBeUndefined();
  });

  test("an observing cache diagnostic recorder keeps the bridge", () => {
    expect(antigravityDirectDeclineReason(route(), chat(), config(), { cacheDiagnostics: true })).toBe("bridge-only-policy");
    expect(antigravityDirectDeclineReason(route(), chat(), config(), { cacheDiagnostics: false })).toBeUndefined();
  });

  test("the recorder observes only when cache debugging is on, not merely because it is loaded", () => {
    const previous = process.env.OPENCODEX_CACHE_DEBUG;
    try {
      delete process.env.OPENCODEX_CACHE_DEBUG;
      expect(cacheDiagnosticsObserving()).toBe(false);
      process.env.OPENCODEX_CACHE_DEBUG = "1";
      expect(cacheDiagnosticsObserving()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_CACHE_DEBUG;
      else process.env.OPENCODEX_CACHE_DEBUG = previous;
    }
  });
});

const messages = (extra: Record<string, unknown> = {}) => ({
  model: `google-antigravity/${MODEL}`,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});
const RESOLVED = `google-antigravity/${MODEL}`;

describe("antigravityMessagesDeclineReason", () => {
  test("an eligible concrete Antigravity route takes the lane; the route rules are the Chat ones", () => {
    expect(antigravityMessagesDeclineReason(route(), messages(), RESOLVED, config())).toBeUndefined();
    expect(antigravityMessagesDeclineReason(route(), messages(), RESOLVED, config({}, false))).toBe("rollout-disabled");
    expect(antigravityMessagesDeclineReason(route({ googleMode: "vertex" }), messages(), RESOLVED, config())).toBe("not-migrated");
    expect(antigravityMessagesDeclineReason(route({}, { routeKind: "policy" } as never), messages(), RESOLVED, config()))
      .toBe("combo-or-policy-route");
  });

  test("a hosted web-search tool or a forced WebSearch choice keeps the bridge for the sidecar", () => {
    expect(antigravityMessagesDeclineReason(route(), messages({ tools: [{ type: "web_search_20250305", name: "web_search" }] }), RESOLVED, config()))
      .toBe("hosted-tool");
    expect(antigravityMessagesDeclineReason(route(), messages({ tool_choice: { type: "tool", name: "WebSearch" } }), RESOLVED, config()))
      .toBe("hosted-tool");
    expect(antigravityMessagesDeclineReason(route(), messages({ tools: [{ name: "f", input_schema: { type: "object" } }] }), RESOLVED, config()))
      .toBeUndefined();
  });

  test("an image for a text-only model keeps the bridge, in a user turn or a tool result", () => {
    const textOnly = route({ modelCapabilities: { [MODEL]: { inputModalities: ["text"] } } } as never);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    expect(antigravityMessagesDeclineReason(textOnly, messages({ messages: [{ role: "user", content: [image] }] }), RESOLVED, config()))
      .toBe("vision-preprocessing");
    const inResult = messages({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [image] }] }] });
    expect(antigravityMessagesDeclineReason(textOnly, inResult, RESOLVED, config())).toBe("vision-preprocessing");
    expect(antigravityMessagesDeclineReason(textOnly, messages(), RESOLVED, config())).toBeUndefined();
  });

  test("the shadow-call intercept is matched on the resolved model", () => {
    const intercept = { shadowCallIntercept: { enabled: true, model: "combo/helpers", sourceModels: ["gemini-"] } } as Partial<OcxConfig>;
    expect(antigravityMessagesDeclineReason(route(), messages(), MODEL, config(intercept))).toBe("bridge-only-policy");
    expect(antigravityMessagesDeclineReason(route(), messages(), RESOLVED, config(intercept))).toBeUndefined();
  });

  test("text the core rewrites on the bridge body, or an observing recorder, keeps the bridge", () => {
    const catalog = "intro <skills_instructions>\n## Skills\n</skills_instructions>";
    expect(antigravityMessagesDeclineReason(route(), messages({ system: [{ type: "text", text: catalog }] }), RESOLVED, config()))
      .toBe("bridge-only-policy");
    expect(antigravityMessagesDeclineReason(route(), messages({ messages: [{ role: "system", content: catalog }, { role: "user", content: "hi" }] }), RESOLVED, config()))
      .toBe("bridge-only-policy");
    const generatedImage = messages({ messages: [
      { role: "user", content: "draw" },
      { role: "assistant", content: [{ type: "text", text: "![Generated image](</tmp/artifacts/img.png>)" }] },
      { role: "user", content: "again" },
    ] });
    expect(antigravityMessagesDeclineReason(route(), generatedImage, RESOLVED, config())).toBe("bridge-only-policy");
    expect(antigravityMessagesDeclineReason(route(), messages(), RESOLVED, config(), { cacheDiagnostics: true })).toBe("bridge-only-policy");
  });

  test("the policies the decoder reproduces decline nothing", () => {
    const cc = { claudeCode: { stabilizePromptCache: true } } as Partial<OcxConfig>;
    const skill = messages({ messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "s", name: "Skill", input: { skill: "claude-api" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "s", content: "Launching skill: claude-api" }] },
    ] });
    expect(antigravityMessagesDeclineReason(route(), skill, RESOLVED, config(cc))).toBeUndefined();
  });
});

describe("planner", () => {
  function input(directEligible: boolean): ProtocolPlanInput {
    return {
      inbound: "chat",
      requestedModel: `google-antigravity/${MODEL}`,
      routeKind: "direct",
      candidates: [{
        provider: "google-antigravity",
        model: MODEL,
        adapter: "google",
        nativeEligible: false,
        ...(directEligible ? { directEligible } : {}),
        declineReasons: ["cross-wire-ir"],
      }],
      features: [],
      surfaces: { responses: { enabled: true }, chat: { enabled: true }, messages: { enabled: true } },
      settings: { unrepresentable: "legacy" },
      policyRevision: "p1-00000000",
      basis: "preview",
    };
  }

  test("a direct-eligible Antigravity candidate is planned without the internal Responses hop", () => {
    const [candidate] = planProtocol(input(true)).candidates;
    expect(candidate).toMatchObject({
      mode: "translated",
      requestPath: ["chat", "ir", "other"],
      responsePath: ["other", "ir", "chat"],
    });
    expect(candidate!.reasonCodes).toEqual(["cross-wire-ir", "upstream-other"]);
  });

  test("without the flag the plan is the bridge, as before", () => {
    const [candidate] = planProtocol(input(false)).candidates;
    expect(candidate).toMatchObject({
      mode: "legacy-bridge",
      requestPath: ["chat", "responses-internal", "ir", "other"],
    });
  });
});
