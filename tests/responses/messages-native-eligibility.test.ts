/**
 * Which Messages routes take the managed native lane (PF-08), and that the planner reports the
 * same rule: `nativeMessagesDeclineReason` (src/server/messages-native-eligibility.ts) and the
 * Messages candidates of `buildProtocolPlanSnapshot` (src/protocols/plan-snapshot.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProtocolPlanSnapshot, previewProtocolPlan } from "../../src/protocols/plan-snapshot";
import type { RouteResult } from "../../src/router";
import {
  isNativeMessagesRouteEligible,
  nativeMessagesDeclineReason,
} from "../../src/server/messages-native-eligibility";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-native-eligibility-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

const ON = { protocols: { rollout: { managedMessagesNative: true } } } as Partial<OcxConfig>;

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "anth",
    providers: {
      anth: { adapter: "anthropic", baseUrl: "https://anth.example/v1", authMode: "key", apiKey: "ka", models: ["claude-x"] },
      anthoauth: { adapter: "anthropic", baseUrl: "https://anth.example/v1", authMode: "oauth", apiKey: "ko", models: ["claude-o"] },
      chat: { adapter: "openai-chat", baseUrl: "https://chat.example/v1", apiKey: "kc", models: ["m1"] },
    },
    combos: {
      pair: { strategy: "failover", targets: [{ provider: "anth", model: "claude-x" }, { provider: "chat", model: "m1" }] },
    },
    ...overrides,
  } as OcxConfig;
}

type RouteOverrides = Omit<Partial<RouteResult>, "provider"> & { adapter?: string; authMode?: string; provider?: Record<string, unknown> };

function route(overrides: RouteOverrides = {}): RouteResult {
  const { adapter = "anthropic", authMode, provider, ...rest } = overrides;
  return {
    providerName: "anth",
    modelId: "claude-x",
    routeKind: "direct",
    routeReason: "test",
    provider: { adapter, baseUrl: "https://anth.example/v1", apiKey: "ka", ...(authMode ? { authMode } : {}), ...provider },
    ...rest,
  } as unknown as RouteResult;
}

const TEXT_BODY = { messages: [{ role: "user", content: "fixture" }] };
const IMAGE_BODY = {
  messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }],
};

describe("native Messages decline reasons", () => {
  test("the switch is checked first and defaults off", () => {
    expect(nativeMessagesDeclineReason(route(), TEXT_BODY, config())).toBe("rollout-disabled");
    expect(isNativeMessagesRouteEligible(route(), TEXT_BODY, config())).toBe(false);
  });

  test("an eligible managed-key Anthropic route has no reason", () => {
    expect(nativeMessagesDeclineReason(route(), TEXT_BODY, config(ON))).toBeUndefined();
    expect(nativeMessagesDeclineReason(route({ authMode: "key" }), TEXT_BODY, config(ON))).toBeUndefined();
    expect(isNativeMessagesRouteEligible(route(), TEXT_BODY, config(ON))).toBe(true);
  });

  test("each rule names its reason", () => {
    const on = config(ON);
    expect(nativeMessagesDeclineReason(route({ adapter: "openai-chat" }), TEXT_BODY, on)).toBe("cross-wire-ir");
    expect(nativeMessagesDeclineReason(route({ authMode: "oauth" }), TEXT_BODY, on)).toBe("auth-mode-not-native");
    expect(nativeMessagesDeclineReason(route({ authMode: "forward" }), TEXT_BODY, on)).toBe("auth-mode-not-native");
    expect(nativeMessagesDeclineReason(route({ routeKind: "policy" } as RouteOverrides), TEXT_BODY, on)).toBe("combo-or-policy-route");
    expect(nativeMessagesDeclineReason(route({ routeKind: "combo" } as RouteOverrides), TEXT_BODY, on)).toBe("combo-or-policy-route");
    expect(nativeMessagesDeclineReason(route(), TEXT_BODY, on, { effortRow: true })).toBe("effort-row");
    expect(nativeMessagesDeclineReason(route(), TEXT_BODY, on, { fastRow: true })).toBe("fast-row");
  });

  test("an image for a model declared text-only needs vision preprocessing", () => {
    const blind = route({ provider: { modelCapabilities: { "claude-x": { inputModalities: ["text"] } } } });
    expect(nativeMessagesDeclineReason(blind, IMAGE_BODY, config(ON))).toBe("vision-preprocessing");
    expect(nativeMessagesDeclineReason(blind, TEXT_BODY, config(ON))).toBeUndefined();
    expect(nativeMessagesDeclineReason(route(), IMAGE_BODY, config(ON))).toBeUndefined();
  });
});

describe("planner mirrors the native Messages rule", () => {
  test("switch off: the preview is unchanged (bridge, no decline reason)", () => {
    const snapshot = buildProtocolPlanSnapshot(config(), { model: "anth/claude-x", inbound: "messages", features: [] });
    expect(snapshot.candidates).toEqual([
      { provider: "anth", model: "claude-x", adapter: "anthropic", nativeEligible: false, declineReasons: [] },
    ]);
    expect(previewProtocolPlan(config(), { model: "anth/claude-x", inbound: "messages", features: [] }).mode).toBe("legacy-bridge");
  });

  test("switch on: a managed-key Anthropic candidate is native", () => {
    const snapshot = buildProtocolPlanSnapshot(config(ON), { model: "anth/claude-x", inbound: "messages", features: ["request.top_k"] });
    expect(snapshot.candidates).toEqual([
      { provider: "anth", model: "claude-x", adapter: "anthropic", nativeEligible: true, declineReasons: [] },
    ]);
    const plan = previewProtocolPlan(config(ON), { model: "anth/claude-x", inbound: "messages", features: ["request.top_k"] });
    expect(plan.mode).toBe("native");
    expect(plan.candidates[0]).toMatchObject({ requestPath: ["messages", "messages"], eligible: true });
    expect(plan.guaranteedFeatures).toEqual(["request.top_k"]);
  });

  test("switch on: OAuth and combo candidates report the rule that declined them", () => {
    const oauth = buildProtocolPlanSnapshot(config(ON), { model: "anthoauth/claude-o", inbound: "messages", features: [] });
    expect(oauth.candidates[0]).toMatchObject({ nativeEligible: false, declineReasons: ["auth-mode-not-native"] });
    const combo = buildProtocolPlanSnapshot(config(ON), { model: "combo/pair", inbound: "messages", features: [] });
    expect(combo.candidates[0]).toMatchObject({ provider: "anth", nativeEligible: false, declineReasons: ["combo-or-policy-route"] });
  });
});
