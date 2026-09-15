import { afterEach, describe, expect, test } from "bun:test";
import {
  advanceComboAfterFailure,
  clearComboSelectionState,
  clearComboTargetCooldowns,
  coolComboTarget,
  isComboTargetInCooldown,
  pickComboTarget,
  targetKey,
} from "../../src/combos";
import { comboFailureCooldownScope, comboFailureDecision } from "../../src/combos/failover";
import { adapterFailureFromMessage, inferHttpStatusFromAdapterMessage } from "../../src/lib/errors";
import type { OcxConfig } from "../../src/types";

/**
 * Cooldown scope and hop/stop verdicts must match a failure's actual blast radius. Before this
 * suite, every non-quota failure cooled the target it hit — including request-shape refusals
 * that say nothing about target health — and `pickComboTarget` never consulted the cooldown
 * map at all, so a target cooled a moment earlier was picked again immediately.
 */

function comboConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
  };
}

const first = { provider: "a", model: "m1" };

afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
});

describe("combo failure cooldown scope", () => {
  test("request-shape refusals cool nothing at all", () => {
    // An oversized request is a fact about the request, not the target: cooling here would make
    // the next, shorter request skip a provider that would have served it.
    expect(comboFailureCooldownScope(413, "request entity too large")).toBe("none");
    for (const code of [
      "input_admission_refused",
      "context_length_exceeded",
      "tool_catalog_too_large",
      "cursor_root_envelope_limit",
      "target_incompatible",
    ]) {
      expect(comboFailureCooldownScope(400, "refused locally", { code })).toBe("none");
    }
    // Hyphenated spellings normalize to the same codes.
    expect(comboFailureCooldownScope(400, "refused", { code: "input-admission-refused" })).toBe("none");
    expect(comboFailureCooldownScope(502,
      "Your input exceeds the context window of this model. Please adjust your input and try again.",
      { code: "upstream_server_error" })).toBe("none");
    // A provider's own per-target hard cap (vendor code 5059) is equally request-shaped.
    expect(comboFailureCooldownScope(
      400,
      "prompt 900000 > 200000 maximum context length",
      { code: "5059" },
    )).toBe("none");
  });

  test("a per-request free-tier cap does not cool the whole provider", () => {
    // `free_rate_limited` is evaluated per request, so provider-wide cooldown punished every
    // other combo for one oversized free-tier prompt.
    expect(comboFailureCooldownScope(400, "prompt too long for the free tier", {
      code: "free_rate_limited",
    })).toBe("none");
  });

  test("credential and billing failures cool the whole provider", () => {
    expect(comboFailureCooldownScope(401, "invalid api key")).toBe("provider");
    expect(comboFailureCooldownScope(402, "payment required")).toBe("provider");
    expect(comboFailureCooldownScope(403, "forbidden")).toBe("provider");
    for (const code of [
      "invalid_api_key",
      "insufficient_quota",
      "subscription_required",
      "payment_required",
      "billing_error",
      "insufficient_balance",
    ]) {
      expect(comboFailureCooldownScope(500, "upstream said no", { code })).toBe("provider");
    }
    // The pre-existing account-window quota cap keeps its provider scope.
    expect(comboFailureCooldownScope(429, "monthly usage limit reached")).toBe("provider");
  });

  test("an ordinary target failure still cools only that target", () => {
    expect(comboFailureCooldownScope(500, "internal server error")).toBe("target");
    expect(comboFailureCooldownScope(429, "rate limit reached for requests")).toBe("target");
  });
});

describe("combo failure hop/stop verdicts", () => {
  test("model-scoped rejections hop to the next target", () => {
    for (const code of ["model_not_found", "model_unavailable", "unsupported_model"]) {
      expect(comboFailureDecision(400, "upstream rejected the model", { code })).toBe("hop");
    }
  });

  test("402 and 425 hop instead of ending the chain", () => {
    expect(comboFailureDecision(402, "payment required")).toBe("hop");
    expect(comboFailureDecision(425, "too early")).toBe("hop");
  });

  test("a per-request free-tier cap still hops", () => {
    expect(comboFailureDecision(400, "free tier prompt cap", { code: "free_rate_limited" })).toBe("hop");
  });

  test("INVARIANT: generic 410 and 413 remain terminal", () => {
    // These two are the tripwire for this change. A widened hop list must never swallow them:
    // 410 without a structured lifecycle code is a real resource-gone verdict, and a generic
    // 413 is a request the next target would reject identically.
    expect(comboFailureDecision(410, "resource is gone")).toBe("stop");
    expect(comboFailureDecision(413, "request too large")).toBe("stop");
  });

  test("INVARIANT: a structured model lifecycle 410 still hops", () => {
    expect(comboFailureDecision(410, "model retired", { code: "model_end_of_life" })).toBe("hop");
  });

  test("a post-send gateway status from the Codex WebSocket relay never hops", () => {
    // The relay sent the create frame and the origin never acknowledged it (504) or the
    // transport closed first (502). The turn may still be executing at the first target, so
    // a second target must not receive the same request; the client decides the retry.
    expect(comboFailureDecision(504, "Provider error 504", { code: "upstream_no_response" })).toBe("stop");
    expect(comboFailureDecision(502, "Provider error 502", { code: "upstream_closed_before_response" })).toBe("stop");
    // The same statuses without the structured code keep the ordinary transient hop.
    expect(comboFailureDecision(504, "Provider error 504")).toBe("hop");
  });
});

describe("cooled targets are not selectable", () => {
  test("a target inside its cooldown window is skipped by pickComboTarget", () => {
    const config = comboConfig();
    const now = 10_000;
    coolComboTarget("free", first, { now, cooldownMs: 60_000 });
    expect(isComboTargetInCooldown("free", first, now + 5_000)).toBe(true);
    const pick = pickComboTarget(config, "free", { now: now + 5_000 });
    expect(pick && targetKey(pick.target)).toBe(targetKey({ provider: "b", model: "m2" }));
  });

  test("an expired cooldown makes the target selectable again", () => {
    const config = comboConfig();
    const now = 10_000;
    coolComboTarget("free", first, { now, cooldownMs: 1_000 });
    const pick = pickComboTarget(config, "free", { now: now + 1_000 });
    expect(pick && targetKey(pick.target)).toBe(targetKey(first));
  });

  test("a \"none\" scope records no cooldown, so the target stays selectable", () => {
    const config = comboConfig();
    const now = 10_000;
    const pick = pickComboTarget(config, "free", { now })!;
    expect(targetKey(pick.target)).toBe(targetKey(first));
    advanceComboAfterFailure(config, pick, {
      now,
      cooldownScope: comboFailureCooldownScope(413, "request entity too large"),
      status: 413,
      message: "request entity too large",
    });
    expect(isComboTargetInCooldown("free", first, now)).toBe(false);
    // The failed target is excluded from THIS request via `attempted`, but a fresh request
    // (no exclusions) must still find it healthy.
    expect(targetKey(pickComboTarget(config, "free", { now })!.target)).toBe(targetKey(first));
  });

  test("a target-scoped failure does record a cooldown", () => {
    const config = comboConfig();
    const now = 10_000;
    const pick = pickComboTarget(config, "free", { now })!;
    advanceComboAfterFailure(config, pick, {
      now,
      cooldownScope: comboFailureCooldownScope(500, "internal server error"),
      status: 500,
      message: "internal server error",
    });
    expect(isComboTargetInCooldown("free", first, now)).toBe(true);
  });
});

describe("malformed upstream bytes are a provider failure", () => {
  test("\"malformed upstream\" infers 502, not a client 4xx", () => {
    // Message-only path: no structured `server_error` type, so the `structuredServerClass`
    // override in httpStatusFromTerminalError cannot absorb this case. Plain "malformed"
    // keeps its 400 verdict, which is what scopes the new branch.
    expect(inferHttpStatusFromAdapterMessage("malformed upstream SSE data frame")).toBe(502);
    expect(inferHttpStatusFromAdapterMessage("malformed request payload")).toBe(400);
    expect(adapterFailureFromMessage("malformed upstream SSE data frame")).toMatchObject({
      httpStatus: 502,
      error: { type: "server_error", code: "upstream_server_error" },
    });
  });
});

const unsupportedUser = { type: "invalid_request_error", message: "Unsupported parameter: user" };
const unsupportedEffort = {
  type: "invalid_request_error", code: "unsupported_value", param: "reasoning.effort",
  message: "Unsupported value: 'none' is not supported with the 'gpt-5.3-codex-spark' model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.",
};

const unsupportedImage = {
  type: "invalid_request_error", code: null, param: "input",
  message: "Model 'gpt-5.3-codex-spark' does not support image inputs. Try again with a vision model.",
};

describe("request-local optional control incompatibility", () => {
  test.each([unsupportedUser, unsupportedEffort, unsupportedImage])("hops a structured target-local request rejection without cooling: %j", error => {
    const body = JSON.stringify({ error });
    for (const message of [body, `Provider error 400: ${body}`]) {
      expect(comboFailureDecision(400, message, { code: "invalid_request_error" })).toBe("hop");
      expect(comboFailureCooldownScope(400, message, { code: "invalid_request_error" })).toBe("none");
    }
  });
  test.each([
    { type: "invalid_request_error", message: "Unsupported parameter: tools" },
    { type: "invalid_request_error", message: "Unsupported parameter: safety_identifier" },
    { type: "invalid_request_error", message: "Unsupported parameter: user.name" },
    { ...unsupportedUser, param: "input" },
    { ...unsupportedUser, code: "origin_rejected" },
    { ...unsupportedUser, code: "context_length_exceeded" },
    { ...unsupportedUser, code: "unknown_terminal_code" },
    { ...unsupportedEffort, param: "input" },
    { ...unsupportedEffort, code: "unknown_terminal_code" },
    { ...unsupportedEffort, code: "cyber_policy" },
  ])("does not relax an unrelated or conflicting refusal: %j", error => {
    expect(comboFailureDecision(400, JSON.stringify({ error }))).toBe("stop");
  });
  test("reflected text, truncated envelopes and oversized diagnostics stay terminal", () => {
    const body = JSON.stringify({ error: unsupportedUser });
    for (const text of [
      `invalid input contains ${body}`,
      JSON.stringify({ error: { type: "invalid_request_error", message: body } }),
      body.slice(0, -1),
      JSON.stringify({ error: unsupportedUser, padding: "x".repeat(16_384) }),
    ]) expect(comboFailureDecision(400, text)).toBe("stop");
  });
  test("hard refusal and non-replayable codes take precedence over a compatible message", () => {
    const message = JSON.stringify({ error: unsupportedUser });
    for (const code of ["origin_rejected", "upstream_no_response", "upstream_closed_before_response"]) {
      expect(comboFailureDecision(400, message, { code })).toBe("stop");
    }
    expect(comboFailureDecision(400, "context length exceeded", { code: "context_length_exceeded" })).toBe("hop");
    expect(comboFailureDecision(499, message)).toBe("stop");
    expect(comboFailureDecision(413, message)).toBe("stop");
  });
});

test("zero-output upstream context overflow is target-local and may hop", () => {
  const message = "Your input exceeds the context window of this model. Please adjust your input and try again.";
  const body = JSON.stringify({ error: { type: "server_error", code: "upstream_server_error", message } });
  expect(comboFailureDecision(502, body, { code: "upstream_server_error" })).toBe("hop");
});

describe("bounded optional-control error envelopes", () => {
  const wrapped = (message: string, code = "invalid_request_error") => JSON.stringify({
    error: { type: "invalid_request_error", code, message: `Provider error 400: ${message}` },
  });
  test("accepts the proxy wrapper but not an unrelated message containing JSON", () => {
    const raw = JSON.stringify({ error: unsupportedUser });
    expect(comboFailureDecision(400, wrapped(raw))).toBe("hop");
    expect(comboFailureDecision(400, wrapped(wrapped(raw)))).toBe("hop");
    expect(comboFailureDecision(400, wrapped(wrapped(wrapped(raw))))).toBe("stop");
    expect(comboFailureDecision(400, wrapped(raw, "cyber_policy"))).toBe("stop");
    expect(comboFailureDecision(400, wrapped(raw, "context_length_exceeded"))).toBe("stop");
  });
  test("malformed envelope fields do not throw or acquire hop permission", () => {
    for (const value of [null, [], "user", { error: null }, { error: [] },
      { error: { ...unsupportedUser, code: {} } },
      { error: { ...unsupportedUser, param: null } },
      { error: { ...unsupportedUser, type: "custom_failure" } },
    ]) expect(comboFailureDecision(400, JSON.stringify(value))).toBe("stop");
  });
  test("the precise reasoning code works without a proxy-generated generic code", () => {
    const message = JSON.stringify({ error: unsupportedEffort });
    expect(comboFailureDecision(400, message, { code: "unsupported_value" })).toBe("hop");
    expect(comboFailureCooldownScope(400, message, { code: "unsupported_value" })).toBe("none");
  });
});

describe("image rejection classifier bounds", () => {
  test.each([
    { ...unsupportedImage, param: "tools" },
    { ...unsupportedImage, code: "origin_rejected" },
    { ...unsupportedImage, code: "unknown_terminal_code" },
    { ...unsupportedImage, message: "This model does not support image inputs." },
    { ...unsupportedImage, message: "Model 'x' does not support image inputs" },
  ])("does not hop on a lookalike or conflicting image refusal: %j", error => {
    expect(comboFailureDecision(400, JSON.stringify({ error }))).toBe("stop");
  });
  test("accepts the observed null-code envelope with an outer generic code", () => {
    const message = JSON.stringify({ error: unsupportedImage });
    expect(comboFailureDecision(400, message, { code: "invalid_request_error" })).toBe("hop");
    expect(comboFailureCooldownScope(400, message, { code: "invalid_request_error" })).toBe("none");
  });
});
