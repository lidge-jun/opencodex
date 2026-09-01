import { describe, expect, test } from "bun:test";
import { logMatchesModelQuery } from "../src/pages/logs-model-filter";

/**
 * #3070: an operator running custom providers watched their OpenAI monthly window
 * shrink and had no way to find the responsible turns in the dashboard. `?model=`
 * filtering landed for the CLI and the API in b68edc077 but never reached Logs.tsx,
 * and the page's only related control — intercepted-helpers — keys on
 * `shadowCallRewrittenFrom`, which an ordinary account-gated turn does not carry.
 */
describe("logs model filter", () => {
  test("an empty or whitespace query matches everything", () => {
    const log = { model: "gpt-5.6-terra" };
    expect(logMatchesModelQuery(log, "")).toBe(true);
    expect(logMatchesModelQuery(log, "   ")).toBe(true);
    // Inert until used: a blank control must not hide rows.
    expect(logMatchesModelQuery({}, "")).toBe(true);
  });

  test("matches a substring of the requested model, case-insensitively", () => {
    const log = { model: "gpt-5.6-terra" };
    expect(logMatchesModelQuery(log, "terra")).toBe(true);
    expect(logMatchesModelQuery(log, "TERRA")).toBe(true);
    expect(logMatchesModelQuery(log, "luna")).toBe(false);
  });

  test("matches the resolved model even when the requested one differs", () => {
    // The case the filter exists for: routing redirected the turn, and the model
    // that got billed is the resolved one. Matching only `model` would hide it.
    const redirected = { model: "combo/free", resolvedModel: "gpt-5.6-terra" };
    expect(logMatchesModelQuery(redirected, "terra")).toBe(true);
    expect(logMatchesModelQuery(redirected, "combo")).toBe(true);
  });

  test("matches the provider and model of a winning failover attempt", () => {
    const failedOver = {
      provider: "primary",
      model: "combo/reliable",
      attempts: [
        { provider: "anthropic", model: "claude-sonnet-4.6" },
        { provider: "xai", model: "grok-4.6" },
      ],
    };
    expect(logMatchesModelQuery(failedOver, "XAI")).toBe(true);
    expect(logMatchesModelQuery(failedOver, "GROK-4.6")).toBe(true);
  });

  test("ignores malformed attempt containers and entries", () => {
    expect(logMatchesModelQuery({
      model: "primary",
      attempts: "not-an-array" as unknown as Array<{ provider?: string; model?: string }>,
    }, "xai")).toBe(false);
    expect(logMatchesModelQuery({
      attempts: [null as unknown as { provider?: string; model?: string }, { provider: "xai" }],
    }, "xai")).toBe(true);
  });

  test("matches the provider", () => {
    expect(logMatchesModelQuery({ provider: "xai", model: "grok-4.6" }, "xai")).toBe(true);
    expect(logMatchesModelQuery({ provider: "xai", model: "grok-4.6" }, "anthropic")).toBe(false);
  });

  test("a row missing every field matches nothing but the empty query", () => {
    expect(logMatchesModelQuery({}, "terra")).toBe(false);
  });

  test("a non-string field cannot throw or match", () => {
    // Log rows arrive from the API; the page validates shape but this helper is
    // called per row on every render and must not be the thing that crashes it.
    const malformed = { model: 42 as unknown as string, resolvedModel: "gpt-5.6-terra" };
    expect(logMatchesModelQuery(malformed, "terra")).toBe(true);
    expect(logMatchesModelQuery(malformed, "42")).toBe(false);
  });
});
