/**
 * `nativeChatDeclineReason` (src/server/chat-native-eligibility.ts) names the rule that keeps a
 * Chat request off the native lane. `isNativeChatRouteEligible` is defined as "no reason", so the
 * two can never disagree; these cases pin which reason wins when several apply.
 */
import { describe, expect, test } from "bun:test";
import { isNativeChatRouteEligible, nativeChatDeclineReason } from "../../src/server/chat-native";
import type { RouteResult } from "../../src/router";

function route(overrides: Partial<RouteResult> & { adapter?: string; authMode?: string } = {}): RouteResult {
  const { adapter = "openai-chat", authMode, ...rest } = overrides;
  return {
    providerName: "p",
    modelId: "m",
    routeKind: "direct",
    routeReason: "test",
    provider: { adapter, baseUrl: "https://example.invalid/v1", ...(authMode ? { authMode } : {}) },
    ...rest,
  } as unknown as RouteResult;
}

describe("native Chat decline reasons", () => {
  test("an eligible route has no reason", () => {
    expect(nativeChatDeclineReason(route(), { messages: [] })).toBeUndefined();
    expect(isNativeChatRouteEligible(route(), { messages: [] })).toBe(true);
  });

  test("a non-Chat adapter is a cross-wire route", () => {
    expect(nativeChatDeclineReason(route({ adapter: "anthropic" }), {})).toBe("cross-wire-ir");
  });

  test("OAuth credentials are not native-eligible", () => {
    expect(nativeChatDeclineReason(route({ authMode: "oauth" }), {})).toBe("auth-mode-not-native");
  });

  test("combo and policy routes stay on the Responses pipeline", () => {
    expect(nativeChatDeclineReason(route({ routeKind: "policy" } as Partial<RouteResult>), {})).toBe("combo-or-policy-route");
  });

  test("Responses-only features and hosted tools are named", () => {
    expect(nativeChatDeclineReason(route(), { store: true })).toBe("responses-only-feature");
    expect(nativeChatDeclineReason(route(), { previous_response_id: "resp_1" })).toBe("responses-only-feature");
    expect(nativeChatDeclineReason(route(), { tools: [{ type: "web_search" }] })).toBe("hosted-tool");
  });

  test("the first failing rule wins", () => {
    expect(nativeChatDeclineReason(route({ authMode: "oauth", routeKind: "policy" } as Partial<RouteResult>), { store: true }))
      .toBe("auth-mode-not-native");
    expect(isNativeChatRouteEligible(route(), { store: true })).toBe(false);
  });
});
