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

  test("Anthropic reasoning state cannot cross the native provider boundary", () => {
    const assistant = { role: "assistant", content: null, reasoning_details: [
      { type: "reasoning.text", text: "thinking", signature: "opaque", format: "anthropic-claude-v1" },
      { type: "reasoning.encrypted", data: "ciphertext", format: "anthropic-claude-v1" },
    ] };
    expect(nativeChatDeclineReason(route(), { messages: [{ role: "user", content: "hi" }, assistant] }))
      .toBe("opaque-state-stripped");
    expect(isNativeChatRouteEligible(route(), { messages: [assistant] })).toBe(false);
  });

  test("an unmarked signed thinking entry carries the same provider state", () => {
    // The inbound replay accepts a format-less reasoning.text whose signature has Anthropic's
    // spelling, so it is the same opaque state the marker check catches and must decline too.
    const assistant = { role: "assistant", reasoning_details: [
      { type: "reasoning.text", text: "thinking", signature: "SyntheticStepOneSignature0000==", index: 0 },
    ] };
    expect(nativeChatDeclineReason(route(), { messages: [{ role: "user", content: "hi" }, assistant] }))
      .toBe("opaque-state-stripped");
    expect(isNativeChatRouteEligible(route(), { messages: [assistant] })).toBe(false);
  });

  test("the same state on a user, system, developer or tool message declines the same way", () => {
    // Native passthrough preserves every caller message object, not only assistant turns, so
    // the scan is role-agnostic: a signature or redacted payload is the same disclosure in
    // whichever slot it sits.
    const details = [
      { type: "reasoning.encrypted", data: "ciphertext", format: "anthropic-claude-v1" },
      { type: "reasoning.text", text: "thinking", signature: "SyntheticStepOneSignature0000==", format: "anthropic-claude-v1" },
    ];
    for (const role of ["user", "system", "developer"]) {
      expect(nativeChatDeclineReason(route(), { messages: [{ role, content: "hi", reasoning_details: details }] }))
        .toBe("opaque-state-stripped");
    }
    expect(nativeChatDeclineReason(route(), { messages: [{ role: "tool", tool_call_id: "call_1", content: "r", reasoning_details: details }] }))
      .toBe("opaque-state-stripped");
  });

  test("unsigned or foreign-format reasoning details remain native-eligible", () => {
    const assistant = { role: "assistant", reasoning_details: [
      { type: "reasoning.text", text: "thinking", format: "minimax-response-v1" },
    ] };
    expect(nativeChatDeclineReason(route(), { messages: [assistant] })).toBeUndefined();
    const foreignSigned = { role: "assistant", reasoning_details: [
      { type: "reasoning.text", text: "thinking", signature: "SyntheticStepOneSignature0000==", format: "minimax-response-v1" },
    ] };
    expect(nativeChatDeclineReason(route(), { messages: [foreignSigned] })).toBeUndefined();
    const unsigned = { role: "assistant", reasoning_details: [
      { type: "reasoning.text", text: "thinking", index: 0 },
    ] };
    expect(nativeChatDeclineReason(route(), { messages: [unsigned] })).toBeUndefined();
  });

  test("the first failing rule wins", () => {
    expect(nativeChatDeclineReason(route({ authMode: "oauth", routeKind: "policy" } as Partial<RouteResult>), { store: true }))
      .toBe("auth-mode-not-native");
    expect(isNativeChatRouteEligible(route(), { store: true })).toBe(false);
  });
});
