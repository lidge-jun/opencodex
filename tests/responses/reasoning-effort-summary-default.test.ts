import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { concreteComboRequestBody } from "../../src/combos/request";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import type { OcxComboTarget, OcxConfig } from "../../src/types";

describe("reasoning effort preserves visible thinking when summary is omitted", () => {
  test.each(["unknown", "off", ""])("invalid effort %j does not enable visibility", effort => {
    const parsed = parseRequest({ model: "test", input: [], reasoning: { effort } });
    expect(parsed.options.reasoning).toBeUndefined();
    expect(parsed.options.hideThinkingSummary).toBe(true);
  });
  test.each([{}, [], 1, null].map(effort => ({ effort })))("non-string effort %j is rejected by the wire schema", ({ effort }) => {
    expect(() => parseRequest({ model: "test", input: [], reasoning: { effort } })).toThrow("responses parse error");
  });
  test.each(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])("validated effort %s enables raw visibility", effort => {
    const parsed = parseRequest({ model: "test", input: [], reasoning: { effort } });
    expect(parsed.options.reasoning).toBe(effort === "ultra" ? "max" : effort);
    expect(parsed.options.hideThinkingSummary).toBeUndefined();
  });
  test.each([undefined, "none", "off", "invalid"])("explicit auto is independent of effort %s", effort => {
    expect(parseRequest({ model: "test", input: [], reasoning: { effort, summary: "auto" } })
      .options.hideThinkingSummary).toBeUndefined();
  });
  test("combo preserves caller summaries, none/minimal, fallback, and adaptive boundaries", () => {
    const target = { provider: "test", model: "model" };
    for (const summary of ["none", "auto"]) {
      expect(concreteComboRequestBody({ reasoning: { summary } }, target, "high", ["high"]).reasoning)
        .toEqual({ effort: "high", summary });
    }
    for (const effort of ["none", "minimal", "medium"]) {
      expect(concreteComboRequestBody({ reasoning: { effort } }, target, "high", ["high"]).reasoning)
        .toEqual({ effort });
    }
    expect(concreteComboRequestBody({ reasoning: { effort: "medium", summary: "none" } }, target, "high", ["high"], "strict", "force").reasoning)
      .toEqual({ effort: "high", summary: "none" });
    expect(concreteComboRequestBody({ reasoning: { effort: "high", summary: "none" } }, target, "high", undefined, "adaptive").reasoning)
      .toEqual({ summary: "none" });
  });
  test("reasoning with active effort does not default to hideThinkingSummary", () => {
    const parsed = parseRequest({
      model: "test-model",
      reasoning: { effort: "high" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(parsed.options.reasoning).toBe("high");
    expect(parsed.options.hideThinkingSummary).toBeUndefined();
  });

  test("explicit summary of none still hides thinking summary", () => {
    const parsed = parseRequest({
      model: "test-model",
      reasoning: { effort: "high", summary: "none" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(parsed.options.reasoning).toBe("high");
    expect(parsed.options.hideThinkingSummary).toBe(true);
  });

  test("omitted reasoning and omitted effort still default to hideThinkingSummary", () => {
    const parsed = parseRequest({
      model: "test-model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(parsed.options.hideThinkingSummary).toBe(true);
  });

  test("reasoning effort of none defaults to hideThinkingSummary", () => {
    const parsed = parseRequest({
      model: "test-model",
      reasoning: { effort: "none" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(parsed.options.hideThinkingSummary).toBe(true);
  });

  test.each(["openai-chat", "kiro"] as const)("%s final route honors caller reasoning visibility", async adapter => {
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "summary-route",
      providers: { "summary-route": { adapter, baseUrl: "https://example.test/v1" } },
    };
    for (const [reasoning, hidden] of [
      [{ effort: "high" }, false],
      [{ effort: "high", summary: "none" }, true],
      [undefined, true],
    ] as const) {
      const parsed = parseRequest({ model: "summary-route/test-model", input: [], reasoning });
      const route = routeModel(config, parsed.modelId);
      expect(route.provider.showThinkingSummary).toBeUndefined();
      await applyFinalRouteRequestNormalization({
        parsed,
        route,
        config,
        req: new Request("http://localhost/v1/responses"),
        logCtx: { model: parsed.modelId, provider: route.providerName },
        inboundWire: "responses",
      });
      expect(parsed.options.hideThinkingSummary).toBe(hidden);
    }
  });

  test("combo injected effort defaults summary to auto", () => {
    const target: Pick<OcxComboTarget, "provider" | "model"> = {
      provider: "test-provider",
      model: "test-model",
    };
    const body = { model: "combo/test", input: [] };
    const child = concreteComboRequestBody(body, target, "high", ["high"]);
    expect(child.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("Chat final-route normalization strips both shapes without losing summary or later-route effort", async () => {
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "a",
      providers: {
        a: { adapter: "anthropic", baseUrl: "https://a.example.test/v1", reasoningEfforts: [] },
        b: { adapter: "anthropic", baseUrl: "https://b.example.test/v1", reasoningEfforts: ["low", "high"] },
      },
    };
    for (const [provider, expectedEffort] of [["a", undefined], ["b", "high"]] as const) {
      // Policy fallback parses each attempt from its preserved wire snapshot. Keep these
      // cases independent so the empty-ladder mutation cannot manufacture the capable result.
      const parsed = parseRequest({
        model: `${provider}/test-model`, input: [], reasoning: { effort: "high", summary: "auto" },
      });
      const route = routeModel(config, `${provider}/test-model`);
      await applyFinalRouteRequestNormalization({
        parsed, route, config,
        req: new Request("http://localhost/v1/responses"),
        logCtx: { model: parsed.modelId, provider },
        inboundWire: "chat",
      });
      expect(parsed.options.reasoning).toBe(expectedEffort);
      expect((parsed._rawBody as { reasoning: { effort?: string; summary: string } }).reasoning)
        .toEqual(expectedEffort ? { effort: expectedEffort, summary: "auto" } : { summary: "auto" });
      expect(parsed.options.hideThinkingSummary).toBeUndefined();
    }
  });
});
