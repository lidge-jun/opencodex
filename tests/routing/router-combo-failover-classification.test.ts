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
import {
  codexAccountModelRefusalHardStopCode,
  comboFailureCooldownScope,
  comboFailureDecision,
  isMalformedResponseFormatRequest,
  isOpenRouterOpaque400Envelope,
  isProviderModerationRefusal,
} from "../../src/combos/failover";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { normalizeUpstreamErrorText } from "../../src/server/responses/core-errors";
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
      "unsupported_input_modality",
    ]) {
      expect(comboFailureCooldownScope(400, "refused locally", { code })).toBe("none");
    }
    // Hyphenated spellings normalize to the same codes.
    expect(comboFailureCooldownScope(400, "refused", { code: "input-admission-refused" })).toBe("none");
    // A native transport reports a zero-output model overflow as a generic upstream error with
    // precise context prose. That target is healthy; only the turn was too large for it.
    expect(comboFailureCooldownScope(502,
      "Your input exceeds the context window of this model. Please adjust your input and try again.",
      { code: "upstream_server_error" })).toBe("none");
    // A request whose token cap was exhausted before output was produced is request-specific.
    expect(comboFailureCooldownScope(502,
      "Provider reached its output token limit before producing output",
      { code: "zero_output_token_limit" })).toBe("none");
    expect(comboFailureDecision(502,
      "Provider reached its output token limit before producing output",
      { code: "zero_output_token_limit" })).toBe("hop");
    // A credential verdict keeps its provider scope even when the body quotes context prose.
    expect(comboFailureCooldownScope(401, "invalid key for the 200k context window tier")).toBe("provider");
    // A provider's own per-target hard cap (vendor code 5059) is equally request-shaped.
    expect(comboFailureCooldownScope(
      400,
      "prompt 900000 > 200000 maximum context length",
      { code: "5059" },
    )).toBe("none");
  });

  test("an opaque OpenRouter numeric-400 hops without cooling the failed target", () => {
    // OpenRouter's Stealth wrapper drops the type and reports the HTTP status as a numeric code;
    // this is still an opaque upstream failure, not a caller validation verdict.
    const openRouterOpaque400 = JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
      },
      user_id: "user_test",
    });
    expect(comboFailureDecision(400, openRouterOpaque400)).toBe("hop");
    expect(comboFailureCooldownScope(400, openRouterOpaque400)).toBe("none");

    // An opaque envelope must not turn known malformed response_format requests into
    // retries of the same invalid payload.
    for (const malformed of [
      "Invalid schema for response_format 'reply': 'type' is a required property.",
      "response_format.type must be one of 'text', 'json_object', 'json_schema'.",
      "response_format must be a valid JSON schema.",
      "response_format.json_schema.schema must be a valid JSON schema.",
    ]) {
      expect(comboFailureDecision(400, malformed, { openRouterOpaque400: true })).toBe("stop");
    }

    const envelopeWithDetail = JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
        detail: "response_format.json_schema.schema must be a valid JSON schema.",
      },
    });
    expect(comboFailureDecision(400, envelopeWithDetail)).toBe("stop");
  });

  test("a wrapped invalid_request_error 400 still stops and cools the target", () => {
    const wrapped = 'Provider error 400: {"type":"error","error":{"type":"invalid_request_error","message":"tools.0.custom.name: String should match pattern ..."}}';
    expect(comboFailureDecision(400, wrapped)).toBe("stop");
    expect(comboFailureCooldownScope(400, wrapped)).toBe("target");

    const plain = "Invalid 'input[3].content': expected a string, got null.";
    expect(comboFailureDecision(400, plain)).toBe("stop");
    expect(comboFailureCooldownScope(400, plain)).toBe("target");
  });

  test("leaves numeric codes undefined in normalizeUpstreamErrorText and accepts them directly in classification inputs", async () => {
    // Numeric exhaustion code 1308 is not coerced to string by normalizeUpstreamErrorText
    const exhaustionBody = JSON.stringify({
      error: { message: "Usage limit reached", code: 1308 },
    });
    const normalized1308 = normalizeUpstreamErrorText(exhaustionBody, "fallback");
    expect(normalized1308.code).toBeUndefined();

    const failure1308 = await consumeComboFailure(new Response(exhaustionBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(failure1308.upstreamCode).toBeUndefined();
    expect(comboFailureDecision(400, failure1308.classificationText, { code: 1308 })).toBe("hop");
    expect(comboFailureCooldownScope(400, failure1308.classificationText, { code: 1308 })).toBe("target");

    // Non-400 numeric code (e.g. 404) in an HTTP 400 response must not take the uncoded hop or skip cooldown
    const non400CodeBody = JSON.stringify({
      error: { message: "Resource not found", code: 404, type: "upstream_error" },
    });
    const normalized404 = normalizeUpstreamErrorText(non400CodeBody, "fallback");
    expect(normalized404.code).toBeUndefined();

    const failure404 = await consumeComboFailure(new Response(non400CodeBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(failure404.upstreamCode).toBeUndefined();
    expect(comboFailureDecision(400, failure404.classificationText, {
      code: 404,
    })).toBe("stop");
    expect(comboFailureCooldownScope(400, failure404.classificationText, {
      code: 404,
    })).toBe("target");

    // Numeric 400 code in OpenRouter opaque envelope retains numeric 400 code and takes the hop
    const openRouterOpaque400 = JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
      },
    });
    const normalizedOR = normalizeUpstreamErrorText(openRouterOpaque400, "fallback");
    expect(normalizedOR.code).toBeUndefined();
    const failureOR = await consumeComboFailure(new Response(openRouterOpaque400, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(failureOR.upstreamCode).toBeUndefined();
    expect(failureOR.openRouterOpaque400).toBe(true);
    expect(comboFailureDecision(400, failureOR.classificationText, {
      code: failureOR.upstreamCode,
      openRouterOpaque400: failureOR.openRouterOpaque400,
    })).toBe("hop");
    expect(comboFailureCooldownScope(400, failureOR.classificationText, {
      code: failureOR.upstreamCode,
      openRouterOpaque400: failureOR.openRouterOpaque400,
    })).toBe("none");

    // Accepts numeric code directly in classification options
    expect(comboFailureDecision(400, failureOR.classificationText, {
      code: 400,
      openRouterOpaque400: failureOR.openRouterOpaque400,
    })).toBe("hop");
    expect(comboFailureCooldownScope(400, failureOR.classificationText, {
      code: 400,
      openRouterOpaque400: failureOR.openRouterOpaque400,
    })).toBe("none");
  });

  test("a typed 400 with a numeric vendor code stays terminal", async () => {
    // Only the untyped OpenRouter shape is target-local; a typed envelope names its own verdict.
    for (const body of [
      JSON.stringify({ error: { type: "upstream_error", message: "bad thing", code: 1001 } }),
      JSON.stringify({ error: { type: "invalid_request_error", message: "Provider returned error", code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth" } } }),
    ]) {
      expect(isOpenRouterOpaque400Envelope(body)).toBe(false);
      const failure = await consumeComboFailure(new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      }));
      expect(failure.openRouterOpaque400).toBe(false);
      expect(comboFailureDecision(400, failure.classificationText, {
        code: failure.upstreamCode,
        openRouterOpaque400: failure.openRouterOpaque400,
        malformedResponseFormat: failure.malformedResponseFormat,
      })).toBe("stop");
    }
  });

  test("a typed root keeps an opaque-looking nested 400 terminal over HTTP, as it does over SSE", async () => {
    const opaque = { message: "Provider returned error", code: 400, metadata: { raw: "ERROR", provider_name: "Stealth" } };
    for (const root of [
      { type: "invalid_request_error" },
      { code: "invalid_request_error" },
      { type: "error", code: "invalid_request_error" },
      { type: "error", code: "content_policy_violation" },
      { type: "error", code: "context_length_exceeded" },
    ]) {
      const body = JSON.stringify({ ...root, error: opaque });
      expect(isOpenRouterOpaque400Envelope(body)).toBe(false);
      const failure = await consumeComboFailure(new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      }));
      expect(failure.openRouterOpaque400).toBe(false);
      expect(comboFailureDecision(400, failure.classificationText, {
        code: failure.upstreamCode,
        openRouterOpaque400: failure.openRouterOpaque400,
        malformedResponseFormat: failure.malformedResponseFormat,
      })).toBe("stop");
    }
    // A root that repeats the numeric 400 adds no verdict of its own.
    expect(isOpenRouterOpaque400Envelope(JSON.stringify({ code: 400, error: opaque }))).toBe(true);
  });

  test("an envelope root is authoritative only when its code is itself a terminal verdict", async () => {
    const opaque = { message: "Provider returned error", code: 400, metadata: { raw: "ERROR" } };
    // The root code used to be read by inequality against "400", which made every other code
    // -- including the ones that are ordinary hop signals, and a blank one -- suppress the
    // opaque verdict. Each of these must leave the wrapper target-local.
    for (const code of [
      "model_not_found",
      "insufficient_quota",
      "usage_limit_exceeded",
      "free_rate_limited",
      "input_admission_refused",
      "unsupported_input_modality",
      "",
      "   ",
    ]) {
      const body = JSON.stringify({ code, error: opaque });
      expect(isOpenRouterOpaque400Envelope(body)).toBe(true);
      const failure = await consumeComboFailure(new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      }));
      expect(comboFailureDecision(400, failure.classificationText, {
        code: failure.upstreamCode,
        rootCode: failure.upstreamRootCode,
        openRouterOpaque400: failure.openRouterOpaque400,
        malformedResponseFormat: failure.malformedResponseFormat,
      })).toBe("hop");
      expect(comboFailureCooldownScope(400, failure.classificationText, {
        code: failure.upstreamCode,
        openRouterOpaque400: failure.openRouterOpaque400,
        malformedResponseFormat: failure.malformedResponseFormat,
      })).toBe("none");
    }
  });

  test("a root hard stop keeps a retryable nested record terminal over HTTP", async () => {
    // normalizeUpstreamErrorText selects the nested record first, so the root code needs its own
    // carrier. The rule is the one SSE already applies: each code alone must authorize the hop.
    for (const [rootCode, nestedCode] of [
      ["content_policy_violation", "model_not_found"],
      ["origin_rejected", "rate_limit_exceeded"],
      ["context_length_exceeded", "insufficient_quota"],
    ]) {
      const body = JSON.stringify({ code: rootCode, error: { message: "retryable", code: nestedCode } });
      const failure = await consumeComboFailure(new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      }));
      expect(failure.upstreamRootCode).toBe(rootCode);
      expect(comboFailureDecision(400, failure.classificationText, {
        code: failure.upstreamCode,
        rootCode: failure.upstreamRootCode,
      })).toBe("stop");
    }
    // The mirror case: a retryable root and record still hop, which is dev's behavior.
    const retryable = await consumeComboFailure(new Response(JSON.stringify({
      code: "server_error", error: { message: "overloaded", code: "server_is_overloaded" },
    }), { status: 503, headers: { "content-type": "application/json" } }));
    expect(comboFailureDecision(503, retryable.classificationText, {
      code: retryable.upstreamCode,
      rootCode: retryable.upstreamRootCode,
    })).toBe("hop");
  });

  test("preserves complete evidence across display truncation for longer envelopes and late details", async () => {
    const longPadding = "x".repeat(600);
    const longOpenRouterBody = JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false, note: longPadding },
      },
      user_id: "user_test",
    });
    expect(longOpenRouterBody.length).toBeGreaterThan(500);
    expect(longOpenRouterBody.length).toBeLessThan(16_384);
    expect(isOpenRouterOpaque400Envelope(longOpenRouterBody)).toBe(true);

    const openRouterFailure = await consumeComboFailure(new Response(longOpenRouterBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(openRouterFailure.openRouterOpaque400).toBe(true);
    expect(openRouterFailure.classificationText.length).toBeLessThanOrEqual(500);
    expect(comboFailureDecision(400, openRouterFailure.classificationText, {
      code: openRouterFailure.upstreamCode,
      openRouterOpaque400: openRouterFailure.openRouterOpaque400,
      malformedResponseFormat: openRouterFailure.malformedResponseFormat,
    })).toBe("hop");
    expect(comboFailureCooldownScope(400, openRouterFailure.classificationText, {
      code: openRouterFailure.upstreamCode,
      openRouterOpaque400: openRouterFailure.openRouterOpaque400,
      malformedResponseFormat: openRouterFailure.malformedResponseFormat,
    })).toBe("none");

    const longMalformedBody = JSON.stringify({
      error: {
        message: "Upstream request failed",
        type: "upstream_error",
        padding: longPadding,
        detail: "response_format.json_schema.schema must be a valid JSON schema.",
      },
    });
    expect(longMalformedBody.length).toBeGreaterThan(500);
    expect(longMalformedBody.length).toBeLessThan(16_384);
    expect(isMalformedResponseFormatRequest(400, longMalformedBody)).toBe(true);

    const malformedFailure = await consumeComboFailure(new Response(longMalformedBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(malformedFailure.malformedResponseFormat).toBe(true);
    expect(comboFailureDecision(400, malformedFailure.classificationText, {
      code: malformedFailure.upstreamCode,
      openRouterOpaque400: malformedFailure.openRouterOpaque400,
      malformedResponseFormat: malformedFailure.malformedResponseFormat,
    })).toBe("stop");

    const rootDetailOpaqueBody = JSON.stringify({
      detail: "Invalid schema for response_format: 'type' must be 'object'",
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
      },
    });
    expect(isMalformedResponseFormatRequest(400, rootDetailOpaqueBody)).toBe(true);
    const rootDetailFailure = await consumeComboFailure(new Response(rootDetailOpaqueBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(rootDetailFailure.malformedResponseFormat).toBe(true);
    expect(rootDetailFailure.openRouterOpaque400).toBe(true);
    expect(comboFailureDecision(400, rootDetailFailure.classificationText, {
      code: rootDetailFailure.upstreamCode,
      openRouterOpaque400: rootDetailFailure.openRouterOpaque400,
      malformedResponseFormat: rootDetailFailure.malformedResponseFormat,
    })).toBe("stop");
    expect(comboFailureCooldownScope(400, rootDetailFailure.classificationText, {
      code: rootDetailFailure.upstreamCode,
      openRouterOpaque400: rootDetailFailure.openRouterOpaque400,
      malformedResponseFormat: rootDetailFailure.malformedResponseFormat,
    })).toBe("target");

    const flatOpaqueBody = JSON.stringify({
      message: "Provider returned error",
      code: 400,
      metadata: { raw: "ERROR", provider_name: "Stealth", is_byok: false },
    });
    expect(isOpenRouterOpaque400Envelope(flatOpaqueBody)).toBe(true);
    const flatFailure = await consumeComboFailure(new Response(flatOpaqueBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(flatFailure.openRouterOpaque400).toBe(true);
    expect(comboFailureDecision(400, flatFailure.classificationText, {
      code: flatFailure.upstreamCode,
      openRouterOpaque400: flatFailure.openRouterOpaque400,
      malformedResponseFormat: flatFailure.malformedResponseFormat,
    })).toBe("hop");
    expect(comboFailureCooldownScope(400, flatFailure.classificationText, {
      code: flatFailure.upstreamCode,
      openRouterOpaque400: flatFailure.openRouterOpaque400,
      malformedResponseFormat: flatFailure.malformedResponseFormat,
    })).toBe("none");
  });

  test.each([400, 422])("HTTP %s per-request free-tier cap still hops without cooldown scope", status => {
    const message = "This prompt is longer than the free tier allows for a single request.";
    const options = { code: "free_rate_limited" };
    expect(comboFailureDecision(status, message, options)).toBe("hop");
    expect(comboFailureCooldownScope(status, message, options)).toBe("none");
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

  test("one account's spent window cools only that target, so sibling accounts stay eligible", () => {
    // An account-window exhaustion names one account, not the provider: a provider row can carry
    // several pooled accounts, and a provider-wide hold would hide the healthy ones (#7426, #7625).
    for (const message of [
      "quota exhausted",
      "weekly usage quota exceeded",
      "weekly usage quota is exhausted",
      "Your weekly usage quota has been exhausted.",
      "Devin cloud error failed_precondition: Cognition chat failed (failed_precondition: quota exhausted) (cloud trace ID: 0123abcd)",
    ]) expect(comboFailureCooldownScope(429, message)).toBe("target");
    expect(comboFailureCooldownScope(429, "quota exhausted for this minute")).toBe("target");
    expect(comboFailureCooldownScope(429, "usage limit reached", { code: "usage_limit_reached" })).toBe("target");
  });

  test("an ordinary target failure still cools only that target", () => {
    expect(comboFailureCooldownScope(500, "internal server error")).toBe("target");
    expect(comboFailureCooldownScope(429, "rate limit reached for requests")).toBe("target");
  });

  test("transient per-minute rate limits and quotas cool only that target and preserve short fallback duration", () => {
    // A per-minute quota or rate limit is transient and must not be promoted to provider-wide
    // exhaustion (which uses the 10-minute MAX_COOLDOWN_MS and provider scope).
    expect(comboFailureCooldownScope(429, "per-minute quota exceeded")).toBe("target");
    expect(comboFailureCooldownScope(429, "Rate limit reached: per-minute quota exceeded")).toBe("target");
    expect(comboFailureCooldownScope(429, "requests per minute quota exceeded")).toBe("target");

    const now = 1_000_000;
    const target = { provider: "a", model: "m1" };

    // Per-minute quota gets standard 60s cooldown, not the 10-minute (600s) account exhaustion cap.
    coolComboTarget("free", target, {
      now,
      status: 429,
      message: "per-minute quota exceeded",
    });
    expect(isComboTargetInCooldown("free", target, now + 59_000)).toBe(true);
    expect(isComboTargetInCooldown("free", target, now + 61_000)).toBe(false);

    // In contrast, weekly usage quota exhaustion gets the 10-minute cap.
    coolComboTarget("free", target, {
      now,
      status: 429,
      message: "Your weekly usage quota has been exhausted.",
    });
    expect(isComboTargetInCooldown("free", target, now + 599_000)).toBe(true);
    expect(isComboTargetInCooldown("free", target, now + 601_000)).toBe(false);
  });

  test("a 400 validation error quoting quota text does not trigger account failover or provider cooldown", () => {
    const errorQuotingQuota = "Invalid parameter 'prompt': text cannot contain 'quota exhausted'";
    expect(comboFailureDecision(400, errorQuotingQuota, { code: "invalid_request_error" })).toBe("stop");
    expect(comboFailureCooldownScope(400, errorQuotingQuota, { code: "invalid_request_error" })).not.toBe("provider");

    const errorQuotingExhaustion = "Validation error: argument quotes 'Your weekly usage quota has been exhausted'";
    expect(comboFailureDecision(400, errorQuotingExhaustion)).toBe("stop");
    expect(comboFailureCooldownScope(400, errorQuotingExhaustion)).not.toBe("provider");

    // The same reflected wording on a 422, with or without the upstream's own invalid_request_error code.
    const reflected422 = "Invalid parameter: value quotes 'weekly usage quota exceeded'";
    expect(comboFailureDecision(422, reflected422, { code: "invalid_request_error" })).toBe("stop");
    expect(comboFailureDecision(422, reflected422)).toBe("stop");
  });

  test("a structured exhaustion code hops even inside a 400 envelope", () => {
    for (const code of ["usage_limit_exceeded", "usage_limit_reached", "1308", "insufficient_quota"]) {
      expect(comboFailureDecision(400, "Bad request", { code })).toBe("hop");
    }
  });
});

describe("combo failure hop/stop verdicts", () => {
  test("model-scoped rejections hop to the next target", () => {
    for (const code of ["model_not_found", "model_unavailable", "unsupported_model", "unsupported_input_modality"]) {
      expect(comboFailureDecision(400, "upstream rejected the model", { code })).toBe("hop");
    }
  });

  test("devin quota exhaustion arrives as a 429 and hops, while request-specific precondition stops", () => {
    const exhausted = "Devin cloud error failed_precondition: Cognition chat failed (failed_precondition: quota exhausted) (cloud trace ID: 0123abcd)";
    expect(comboFailureDecision(429, exhausted, { code: "failed_precondition", failedAdapter: "devin" })).toBe("hop");
    expect(comboFailureCooldownScope(429, exhausted, { code: "failed_precondition" })).toBe("target");

    // Request-specific precondition without quota evidence stays terminal and does not cool provider
    expect(comboFailureDecision(400, "Devin cloud error failed_precondition: Unable to process request due to an MCP configuration issue", {
      code: "failed_precondition",
      failedAdapter: "devin",
    })).toBe("stop");
    expect(comboFailureCooldownScope(400, "Devin cloud error failed_precondition: Unable to process request due to an MCP configuration issue", {
      code: "failed_precondition",
    })).not.toBe("provider");
  });

  test("a Codex model the ChatGPT plan cannot use hops instead of ending the chain", () => {
    const body = JSON.stringify({ detail: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account." });
    expect(comboFailureDecision(400, body)).toBe("hop");
    expect(comboFailureDecision(400, JSON.stringify({ detail: "The 'gpt-6-astra' model is invalid." }))).toBe("stop");
    const refusal = "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.";
    expect(comboFailureDecision(400, refusal)).toBe("hop");
    expect(comboFailureDecision(400, JSON.stringify({ error: { message: refusal } }))).toBe("hop");
    // Quoted in an unrelated field, or embedded in other prose, it is not the refusal.
    expect(comboFailureDecision(400, JSON.stringify({ detail: "bad input", echo: refusal }))).toBe("stop");
    expect(comboFailureDecision(400, `Your prompt said: ${refusal}`)).toBe("stop");
  });

  test("ambiguous plan refusal stops before a conflicting model-code hop", () => {
    const refusal = "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.";
    for (const error of [null, { message: "bad input" }, { code: "unsupported_model", message: "bad input" }]) {
      const body = JSON.stringify({ detail: refusal, error });
      expect(comboFailureDecision(400, body, { code: "unsupported_model" })).toBe("stop");
      expect(comboFailureDecision(400, `Provider error 400: ${body}`, { code: "unsupported_model" })).toBe("stop");
    }
    expect(comboFailureDecision(400, refusal, { code: "origin_rejected" })).toBe("stop");
    expect(comboFailureDecision(400, refusal, { code: "upstream_no_response" })).toBe("stop");
    expect(comboFailureDecision(499, refusal)).toBe("stop");
    expect(comboFailureDecision(503, refusal)).toBe("hop");
    expect(comboFailureDecision(400, refusal, { codexModelRefusal: "other" })).toBe("stop");
    expect(comboFailureDecision(400, JSON.stringify({ error: [{ message: refusal }] }))).toBe("stop");
    expect(comboFailureDecision(400, JSON.stringify({ detail: refusal, extra: "x".repeat(16_384) }))).toBe("stop");
  });

  test("plan ambiguity depends on field presence across exactly two supported levels", () => {
    const refusal = "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.";
    const details = [refusal, "bad input", null, undefined];
    const errors = [{ message: refusal }, { message: "bad input" }, null, undefined];
    for (const detailLevel of ["root", "response"]) {
      for (const errorLevel of ["root", "response"]) {
        for (const detail of details) {
          for (const error of errors) {
            const root: Record<string, unknown> = {};
            const response: Record<string, unknown> = {};
            (detailLevel === "root" ? root : response).detail = detail;
            (errorLevel === "root" ? root : response).error = error;
            root.response = response;
            // Undefined keys disappear on the wire; null remains a present carrier.
            const expected = detail !== undefined && error !== undefined ? "stop" : "hop";
            expect(comboFailureDecision(400, JSON.stringify(root), { code: "unsupported_model" })).toBe(expected);
          }
        }
      }
    }
    for (const response of [null, [], [{ error: null }], { quoted: { detail: null, error: null } },
      { detail: refusal }, { response: { error: null } }]) {
      expect(comboFailureDecision(400, JSON.stringify({ detail: refusal, response }))).toBe("hop");
    }
    expect(comboFailureDecision(400, JSON.stringify({ error: { message: refusal },
      response: { error: null } }))).toBe("hop");
  });

  test("nested HTTP refusal selects one carrier without borrowing body metadata", () => {
    const refusal = "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.";
    for (const response of [{ detail: refusal }, { error: { message: refusal } }]) {
      const body = JSON.stringify({ response });
      expect(comboFailureDecision(400, body)).toBe("hop");
      expect(comboFailureDecision(400, `Provider error 400: ${body}`)).toBe("hop");
      expect(comboFailureDecision(400, body, { codexModelRefusal: "other" })).toBe("stop");
      expect(comboFailureDecision(400, body, { code: "origin_rejected" })).toBe("stop");
      expect(comboFailureDecision(400, body, { code: "upstream_no_response" })).toBe("stop");
      expect(comboFailureDecision(400, body, { code: "cyber_policy" })).toBe("stop");
      expect(comboFailureDecision(499, body)).toBe("stop");
      expect(comboFailureDecision(422, body)).toBe("stop");
      expect(comboFailureDecision(400, body.slice(0, -1))).toBe("stop");
      expect(comboFailureDecision(400, JSON.stringify({ response, padding: "x".repeat(16_384) }))).toBe("stop");
    }
    expect(comboFailureDecision(400, JSON.stringify({ response: { error: {
      code: "upstream_no_response", message: refusal,
    } } }), { code: "unsupported_model", codexModelRefusal: "other" })).toBe("hop");
    for (const body of [
      { detail: null, response: { detail: refusal } },
      { detail: "bad input", response: { detail: refusal } },
      { error: null, response: { error: { message: refusal } } },
      { error: { message: "bad input" }, response: { error: { message: refusal } } },
      { response: { error: { message: "bad input" } }, codexModelRefusal: "refusal" },
      { response: { error: { message: "bad input" }, codexModelRefusal: "refusal" } },
    ]) expect(comboFailureDecision(400, JSON.stringify(body))).toBe("stop");
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

const responsesToolRoutingMismatch = {
  type: "invalid_request_error", code: null, param: "reasoning_effort",
  message: "Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
};
const datedResponsesToolRoutingMismatch = {
  ...responsesToolRoutingMismatch,
  message: responsesToolRoutingMismatch.message.replace("gpt-6-astra", "gpt-6-astra-2026-09-03"),
};

describe("request-local optional control incompatibility", () => {
  test.each([unsupportedUser, unsupportedEffort, unsupportedImage, responsesToolRoutingMismatch, datedResponsesToolRoutingMismatch])("hops a structured target-local request rejection without cooling: %j", error => {
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
    { ...responsesToolRoutingMismatch, param: "tools" },
    { ...responsesToolRoutingMismatch, code: "unsupported_value" },
    { ...responsesToolRoutingMismatch, code: undefined },
    { ...responsesToolRoutingMismatch, message: responsesToolRoutingMismatch.message.replace("gpt-6-astra", "gpt-6-astra-preview") },
    { ...responsesToolRoutingMismatch, message: responsesToolRoutingMismatch.message.replace("gpt-6-astra", "gpt-6-astra-2026-9-3") },
    { ...responsesToolRoutingMismatch, message: "Function tools are not supported." },
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
    for (const code of ["origin_rejected", "context_length_exceeded", "upstream_no_response", "upstream_closed_before_response"]) {
      expect(comboFailureDecision(400, message, { code })).toBe("stop");
    }
    expect(comboFailureDecision(499, message)).toBe("stop");
    expect(comboFailureDecision(413, message)).toBe("stop");
  });
});

describe("definite upstream context overflow", () => {
  const prose = "Your input exceeds the context window of this model. Please adjust your input and try again.";
  const failedTerminal = (message: string) => JSON.stringify({
    error: { type: "server_error", code: "upstream_server_error", message },
    response: { error: { type: "server_error", code: "upstream_server_error", message } },
  });

  test("a zero-output context overflow is target-local and may hop", () => {
    // The combo stream preflight only synthesizes this envelope for a terminal that committed
    // no output, so the hop can never duplicate text the client already saw.
    expect(comboFailureDecision(502, failedTerminal(prose), { code: "upstream_server_error" })).toBe("hop");
    // The shape upstream Codex actually emits: a `response.failed` whose error carries the exact
    // `context_length_exceeded` code alongside this message. The proxy relays the nested error
    // verbatim, so both the structured and the generic-wrapper form must reach the same verdict.
    expect(comboFailureDecision(502, failedTerminal(prose), { code: "context_length_exceeded" })).toBe("hop");
    expect(comboFailureDecision(400, "context length exceeded", { code: "context_length_exceeded" })).toBe("hop");
    expect(comboFailureDecision(400, `Provider error 400: ${prose}`)).toBe("hop");
    expect(comboFailureDecision(400, "This is not a timeout: the model's context window is full")).toBe("hop");
    expect(comboFailureDecision(400, "Request was not accepted because its history is at or past the model's context limit")).toBe("hop");
  });

  test("evidence must come from the innermost message, not a stray code token", () => {
    const unrelated = JSON.stringify({ error: { ...unsupportedUser, code: "context_length_exceeded" } });
    expect(comboFailureDecision(400, unrelated)).toBe("stop");
    expect(comboFailureDecision(400, "ordinary invalid request", { code: "context_length_exceeded" })).toBe("stop");
    expect(comboFailureDecision(400, "Requested tokens should not exceed maximum context length (8192)")).toBe("stop");
    // Reflected prose inside an unrelated body is not the provider's own verdict.
    expect(comboFailureDecision(400, JSON.stringify({ error: { ...unsupportedUser, param: "tools", note: prose } })))
      .toBe("stop");
  });

  test("truncated envelopes and hard refusals do not acquire hop permission", () => {
    // classificationText is capped at 500 characters upstream, so a long envelope reaches the
    // classifier as a JSON prefix. Reading that prefix as prose would let any field authorize
    // a replay, so a JSON-shaped body that does not parse fails closed.
    expect(comboFailureDecision(400, failedTerminal(prose).slice(0, -1))).toBe("stop");
    expect(comboFailureDecision(502, prose, { code: "origin_rejected" })).toBe("stop");
    expect(comboFailureDecision(502, prose, { code: "upstream_no_response" })).toBe("stop");
    expect(comboFailureDecision(499, prose)).toBe("stop");
    // A status that speaks about the CREDENTIAL keeps its own verdict and its provider-wide
    // cooldown, even when the body quotes context prose. Without that gate this envelope would
    // be reclassified as request-shaped and a rejected key would stop cooling its provider.
    expect(comboFailureDecision(403, prose)).toBe("stop");
    expect(comboFailureCooldownScope(403, prose)).toBe("provider");
  });

  test("the envelope budget is bounded and oversized bodies stay terminal", () => {
    const wrap = (inner: string) => JSON.stringify({ error: { type: "server_error", message: inner } });
    expect(comboFailureDecision(400, wrap(wrap(wrap(prose))))).toBe("hop");
    expect(comboFailureDecision(400, wrap(wrap(wrap(wrap(wrap(prose))))))).toBe("stop");
    expect(comboFailureDecision(400, `${prose} ${"x".repeat(16_384)}`)).toBe("stop");
  });
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
  test("exact reasoning effort refusal hops when wrapped in single-line data: prefix", () => {
    const payload = JSON.stringify({ code: "invalid-argument", error: "Invalid reasoning effort." });
    for (const msg of [
      payload,
      `data: ${payload}`,
      `Provider error 400: data: ${payload}`,
    ]) {
      expect(comboFailureDecision(400, msg)).toBe("hop");
      expect(comboFailureCooldownScope(400, msg)).toBe("none");
    }
  });
  test("rejects malformed error codes before granting a combo hop for reasoning effort", () => {
    for (const malformedCode of [42, true, {}, []]) {
      const payloadWithCode = JSON.stringify({
        error: { type: "invalid_request_error", code: malformedCode, message: "Invalid reasoning effort." },
      });
      expect(comboFailureDecision(400, payloadWithCode)).toBe("stop");
      expect(comboFailureCooldownScope(400, payloadWithCode)).toBe("target");

      const rootWithCode = JSON.stringify({
        code: malformedCode,
        error: "Invalid reasoning effort.",
      });
      expect(comboFailureDecision(400, rootWithCode)).toBe("stop");
      expect(comboFailureCooldownScope(400, rootWithCode)).toBe("target");
    }
  });
  test("rejects conflicting root and nested codes before granting a combo hop for reasoning effort", () => {
    for (const conflictingCode of ["context_length_exceeded", "origin_rejected", "unknown_terminal_code"]) {
      const payloadWithCode = JSON.stringify({
        error: { type: "invalid_request_error", code: conflictingCode, message: "Invalid reasoning effort." },
      });
      expect(comboFailureDecision(400, payloadWithCode)).toBe("stop");
      expect(comboFailureCooldownScope(400, payloadWithCode)).toBe("target");

      const rootWithCode = JSON.stringify({
        code: conflictingCode,
        error: { type: "invalid_request_error", message: "Invalid reasoning effort." },
      });
      expect(comboFailureDecision(400, rootWithCode)).toBe("stop");
      expect(comboFailureCooldownScope(400, rootWithCode)).toBe("target");
    }
  });
  test("pins root code behavior against reasoning effort matcher (dev regression)", () => {
    for (const code of ["insufficient_quota", "model_not_found", "rate_limit_exceeded"]) {
      const body = JSON.stringify({ code, error: { type: "invalid_request_error", message: "Invalid reasoning effort." } });
      expect(comboFailureDecision(400, body)).toBe("stop");
      expect(comboFailureCooldownScope(400, body)).toBe("target");
    }
    const permBody = JSON.stringify({ code: "permission_denied", error: { type: "invalid_request_error", message: "Invalid reasoning effort." } });
    expect(comboFailureDecision(400, permBody)).toBe("hop");
    expect(comboFailureCooldownScope(400, permBody)).toBe("target");
  });

  test("rejects competing error carriers before granting a target-local combo hop for reasoning effort", () => {
    const payload = JSON.stringify({
      code: "invalid-argument",
      error: "Invalid reasoning effort.",
      response: { code: "permission_denied" },
    });
    expect(comboFailureCooldownScope(400, payload)).toBe("target");
  });

  test("rejects competing diagnostic arrays before granting a target-local combo hop for reasoning effort", () => {
    const payload = JSON.stringify({
      code: "invalid-argument",
      error: "Invalid reasoning effort.",
      details: [{ code: "unknown_terminal_code" }],
    });
    expect(comboFailureDecision(400, payload)).toBe("stop");
    expect(comboFailureCooldownScope(400, payload)).toBe("target");
  });

  test("fails closed when diagnostic array exceeds bounded scan budget", () => {
    const payload = JSON.stringify({
      code: "invalid-argument",
      error: "Invalid reasoning effort.",
      details: [...Array(32).fill({}), { code: "unknown_terminal_code" }],
    });
    expect(comboFailureDecision(400, payload)).toBe("stop");
    expect(comboFailureCooldownScope(400, payload)).toBe("target");
  });

  test("rejects nested error carriers in details before granting combo hop", () => {
    const payload = JSON.stringify({
      code: "invalid-argument",
      error: "Invalid reasoning effort.",
      details: { error: { code: "unknown_terminal_code" } },
    });
    expect(comboFailureDecision(400, payload)).toBe("stop");
    expect(comboFailureCooldownScope(400, payload)).toBe("target");
  });

  test("rejects serialized diagnostic entries in details before granting combo hop", () => {
    const payload = JSON.stringify({
      code: "invalid-argument",
      error: "Invalid reasoning effort.",
      details: ['{"code":"unknown_terminal_code"}'],
    });
    expect(comboFailureDecision(400, payload)).toBe("stop");
    expect(comboFailureCooldownScope(400, payload)).toBe("target");
  });

  test("fails closed on unclassifiable string entries in details array", () => {
    const payload = JSON.stringify({
      code: "invalid-argument",
      error: "Invalid reasoning effort.",
      details: ["unrecognized_plain_text_error"],
    });
    expect(comboFailureDecision(400, payload)).toBe("stop");
    expect(comboFailureCooldownScope(400, payload)).toBe("target");
  });

  test("rejects conflicting named parameters before exact-effort combo hop", () => {
    const payload = JSON.stringify({
      param: "temperature",
      error: {
        type: "invalid_request_error",
        param: "reasoning_effort",
        message: "Invalid reasoning effort.",
      },
    });
    expect(comboFailureDecision(400, payload)).toBe("stop");
    expect(comboFailureCooldownScope(400, payload)).toBe("target");
  });

  test("rejects competing root or nested diagnostic messages before granting exact-effort hop", () => {
    // Competing root message on vendor envelope elevates to target cooldown or stop, never cooldown none
    const permPayload = JSON.stringify({
      code: "invalid-argument",
      error: "Invalid reasoning effort.",
      message: "permission_denied",
    });
    expect(comboFailureDecision(400, permPayload)).toBe("hop");
    expect(comboFailureCooldownScope(400, permPayload)).toBe("target");

    for (const competing of ["unknown_terminal_code", "invalid_request_error", "unsupported parameter: user"]) {
      const payload = JSON.stringify({
        code: "invalid-argument",
        error: "Invalid reasoning effort.",
        message: competing,
      });
      expect(comboFailureDecision(400, payload)).toBe("stop");
      expect(comboFailureCooldownScope(400, payload)).toBe("target");

      const nestedPayload = JSON.stringify({
        message: competing,
        error: {
          type: "invalid_request_error",
          message: "Invalid reasoning effort.",
        },
      });
      expect(comboFailureDecision(400, nestedPayload)).toBe("stop");
      expect(comboFailureCooldownScope(400, nestedPayload)).toBe("target");

      const competingNestedError = JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "Invalid reasoning effort.",
          error: competing,
        },
      });
      expect(comboFailureDecision(400, competingNestedError)).toBe("stop");
      expect(comboFailureCooldownScope(400, competingNestedError)).toBe("target");
    }

    // Reconciled matching message grants hop without cooldown
    const matchingPayload = JSON.stringify({
      code: "invalid-argument",
      error: "Invalid reasoning effort.",
      message: "Invalid reasoning effort.",
    });
    expect(comboFailureDecision(400, matchingPayload)).toBe("hop");
    expect(comboFailureCooldownScope(400, matchingPayload)).toBe("none");
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

/**
 * #4903. A combo opens a new conversation, the shadow title call carries `response_format`, and
 * the first target's gateway refuses it. The chain stopped instead of trying the target behind
 * it, because the gateway reports `type: "invalid_request_error"` and that reaches the generic
 * terminal list before anything asks whether the next target could serve the request.
 *
 * Neither obvious alternative is taken here. Hopping on every 400 would replay a genuinely
 * malformed request against every remaining target; dropping `response_format` would change the
 * output contract the caller asked for. Only a refusal that names the field AND says it is
 * unavailable is treated as a target-local capability gap.
 */
describe("response_format capability refusal", () => {
  const unavailable = {
    code: "invalid_parameter_error",
    param: null,
    message: "This response_format type is unavailable now",
    type: "invalid_request_error",
  };
  const reported = JSON.stringify({ error: unavailable, id: "chatcmpl-946b178a" });

  test("hops without cooling, through every envelope the report shows", () => {
    // The last two are the shape actually observed: the gateway reports the refusal in a single
    // SSE frame, so the error object is never extracted and the structured code arrives
    // undefined -- which is why the user sees `Provider error 400: data: {...}`.
    for (const message of [
      reported,
      `Provider error 400: ${reported}`,
      `data: ${reported}`,
      `Provider error 400: data: ${reported}`,
    ]) {
      expect(comboFailureDecision(400, message)).toBe("hop");
      expect(comboFailureCooldownScope(400, message)).toBe("none");
    }
    // And when the gateway's own code does survive extraction.
    expect(comboFailureDecision(400, reported, { code: "invalid_parameter_error" })).toBe("hop");
    expect(comboFailureCooldownScope(400, reported, { code: "invalid_parameter_error" })).toBe("none");
  });

  test("a malformed response_format is a request defect and stays terminal", () => {
    // Names the field, claims nothing about capability. Replaying this at every later target
    // is exactly what the issue asked not to do.
    for (const message of [
      "Invalid schema for response_format 'reply': 'type' is a required property.",
      "response_format.type must be one of 'text', 'json_object', 'json_schema'.",
    ]) {
      expect(comboFailureDecision(400, JSON.stringify({
        error: { ...unavailable, message },
      }))).toBe("stop");
    }
  });

  test("an unavailability claim about some other field stays terminal", () => {
    expect(comboFailureDecision(400, JSON.stringify({
      error: { ...unavailable, message: "This parameter type is unavailable now" },
    }))).toBe("stop");
    // A param naming a different field contradicts the message, so it fails closed.
    expect(comboFailureDecision(400, JSON.stringify({
      error: { ...unavailable, param: "messages" },
    }))).toBe("stop");
  });

  test("the envelope stays bounded and fails closed", () => {
    // Reflected prose, a truncated body, a non-400 status, an unrecognized code, a wrong type,
    // and a multi-event stream body are all refused. The single-frame unwrap is one frame.
    expect(comboFailureDecision(400, `please fix ${reported}`)).toBe("stop");
    expect(comboFailureDecision(400, reported.slice(0, -1))).toBe("stop");
    expect(comboFailureDecision(422, reported)).toBe("stop");
    expect(comboFailureDecision(400, reported, { code: "unknown_terminal_code" })).toBe("stop");
    expect(comboFailureDecision(400, JSON.stringify({
      error: { ...unavailable, type: "server_error" },
    }))).toBe("stop");
    expect(comboFailureDecision(400, `data: ${reported}\ndata: [DONE]`)).toBe("stop");
    expect(comboFailureDecision(400, JSON.stringify({
      error: { ...unavailable, message: `This response_format type is unavailable now ${"x".repeat(16_384)}` },
    }))).toBe("stop");
  });

  test("a hard refusal still outranks the capability verdict", () => {
    for (const code of ["origin_rejected", "upstream_no_response", "cyber_policy"]) {
      expect(comboFailureDecision(400, reported, { code })).toBe("stop");
    }
    expect(comboFailureDecision(499, reported)).toBe("stop");
  });
});

/**
 * #5035 reports the same refusal from a second gateway. The capability claim is worded
 * identically, but this vendor spells its code `invalid_request_error` rather than
 * `invalid_parameter_error` and sends no `id` beside the error object.
 *
 * That code is the one the generic terminal list stops on, which makes the ordering inside
 * `comboFailureDecision` load-bearing here rather than incidental: the capability verdict has to
 * be read before that list, and the code has to be accepted at the outer and the inner level
 * both. The first gateway never exercised that, because its `invalid_parameter_error` is not a
 * terminal code to begin with.
 *
 * Pinned rather than fixed. The reporter ran 2.58.0, which was tagged before #4927 landed, so
 * this envelope already hops on `dev`. What a second vendor confirming the shape buys is a
 * reason to hold the code set still.
 */
describe("response_format capability refusal, second gateway", () => {
  const refusal = {
    message: "This response_format type is unavailable now",
    type: "invalid_request_error",
    param: null,
    code: "invalid_request_error",
  };
  const body = JSON.stringify({ error: refusal });

  test("hops without cooling when the vendor code is the generic terminal one", () => {
    // Undefined is the code an unparsed body yields; the explicit one is what extraction yields.
    for (const options of [undefined, { code: "invalid_request_error" }]) {
      expect(comboFailureDecision(400, body, options)).toBe("hop");
      expect(comboFailureCooldownScope(400, body, options)).toBe("none");
    }
  });

  test("survives the wrapper the proxy adds on the way back out", () => {
    const rewrapped = JSON.stringify({
      error: {
        type: "upstream_error",
        code: "invalid_request_error",
        message: `Provider error 400: ${body}`,
      },
    });
    for (const message of [`Provider error 400: ${body}`, rewrapped]) {
      expect(comboFailureDecision(400, message, { code: "invalid_request_error" })).toBe("hop");
      expect(comboFailureCooldownScope(400, message, { code: "invalid_request_error" })).toBe("none");
    }
  });

  test("the same vendor code without a capability claim stays terminal", () => {
    // These differ from the envelope above only in what the message claims. Replaying a request
    // defect against every remaining target is the outcome the hop rule exists to avoid, so the
    // claim -- not the code, and not the field name on its own -- is what authorizes the hop.
    for (const message of [
      "Invalid schema for response_format: 'json_schema' is required",
      "Unknown parameter: temperature",
    ]) {
      expect(comboFailureDecision(400, JSON.stringify({ error: { ...refusal, message } })))
        .toBe("stop");
    }
  });
});

describe("HTTP hard-code evidence excludes diagnostic types", () => {
  test("code/type matrix inspects dedicated code fields only at either level", () => {
    const codes: Array<[unknown, string | undefined]> = [
      ["cyber_policy", "cyber_policy"], ["upstream_no_response", "upstream_no_response"],
      ["origin-rejected", "origin_rejected"], ["unsupported_model", undefined], ["unknown_code", undefined],
      ["", undefined], ["  ", undefined], [undefined, undefined], [null, undefined], [17, undefined], [{}, undefined],
    ];
    for (const nested of [false, true]) {
      for (const [code, expected] of codes) {
        for (const type of ["cyber_policy", "upstream_no_response", "upstream_reset_replay_refused", "origin_rejected", "invalid_request_error", null, undefined]) {
          const record = { error: { code, type, message: "fixture failure" } };
          const body = JSON.stringify(nested ? { response: record } : record);
          expect(codexAccountModelRefusalHardStopCode(400, body)).toBe(expected);
        }
      }
    }
  });

  test("a genuine code in another record still wins over a nonhard code and diagnostic type", () => {
    const diagnostic = { error: { code: "unsupported_model", type: "cyber_policy", message: "fixture failure" } };
    const hard = { code: "upstream_no_response" };
    for (const body of [{ ...diagnostic, response: hard }, { ...hard, response: diagnostic }]) {
      expect(codexAccountModelRefusalHardStopCode(400, JSON.stringify(body))).toBe("upstream_no_response");
      expect(comboFailureDecision(400, JSON.stringify(body))).toBe("stop");
    }
  });
});

describe("provider moderation refusal", () => {
  const moderationPayload = {
    error: {
      message: "The input was refused by moderation. Categories: harassment.",
      type: "AI_APICallError",
      param: {
        error: "The input was refused by moderation. Categories: harassment.",
        statusCode: 400,
        name: "AI_APICallError",
        message: "The input was refused by moderation. Categories: harassment.",
        isRetryable: false,
        type: "AI_APICallError",
      },
    },
    providerMetadata: {
      gateway: {
        routing: {
          originalModelId: "humansand/ampersand-v0.1",
          resolvedProvider: "humansand",
          fallbacksAvailable: [],
        },
      },
    },
  };

  test("the observed gateway refusal hops only with a structured moderation code", () => {
    // Owner decision on #8428: prose alone never hops. The observed body carries no code, so it
    // keeps dev's stop; the same body with a structured moderation code hops without cooling.
    const rawBody = JSON.stringify(moderationPayload);
    expect(isProviderModerationRefusal(400, rawBody)).toBe(false);
    expect(comboFailureDecision(400, rawBody)).toBe("stop");
    const coded = JSON.stringify({ ...moderationPayload, error: { ...moderationPayload.error, code: "moderation_refusal" } });
    for (const message of [coded, `Provider error 400: ${coded}`, `data: ${coded}`]) {
      // The body readers judge the whole body; a wrapped copy is longer than the cut classification text.
      const providerModerationRefusal = isProviderModerationRefusal(400, message, undefined, true);
      expect(comboFailureDecision(400, message, { providerModerationRefusal })).toBe("hop");
      expect(comboFailureCooldownScope(400, message, { providerModerationRefusal })).toBe("none");
    }
  });

  test("moderation phrases alone stay terminal; the structured code is what hops", () => {
    const phrases = [
      "The input was refused by moderation. Categories: harassment.",
      "The input was refused by moderation.",
      "The prompt was refused by moderation.",
      "The response was refused by moderation.",
      "Prompt was blocked by moderation.",
      "Input was flagged by moderation.",
    ];
    for (const phrase of phrases) {
      const body = JSON.stringify({ error: { message: phrase } });
      expect(isProviderModerationRefusal(400, body)).toBe(false);
      expect(comboFailureDecision(400, body)).toBe("stop");
      const coded = JSON.stringify({ error: { code: "moderation_refusal", message: phrase } });
      expect(comboFailureDecision(400, coded)).toBe("hop");
      expect(comboFailureCooldownScope(400, coded)).toBe("none");
    }
  });

  test("hops when error code is moderation_refusal or content_filter", () => {
    for (const code of ["moderation_refusal", "content_filter"]) {
      const body = JSON.stringify({ error: { code, message: "filtered" } });
      expect(isProviderModerationRefusal(400, body, code)).toBe(true);
      expect(comboFailureDecision(400, body, { code })).toBe("hop");
      expect(comboFailureCooldownScope(400, body, { code })).toBe("none");
      for (const message of [body, `data: ${body}`]) {
        expect(isProviderModerationRefusal(400, message)).toBe(true);
        expect(comboFailureDecision(400, message)).toBe("hop");
        expect(comboFailureCooldownScope(400, message)).toBe("none");
      }
    }
  });

  test("recognizes explicit moderation codes with empty or absent message", () => {
    for (const code of ["content_filter", "moderation_refusal"]) {
      expect(isProviderModerationRefusal(400, "", code)).toBe(true);
      expect(comboFailureDecision(400, "", { code })).toBe("hop");
      expect(comboFailureCooldownScope(400, "", { code })).toBe("none");

      const body = JSON.stringify({ error: { code } });
      expect(isProviderModerationRefusal(400, body)).toBe(true);
      expect(comboFailureDecision(400, body)).toBe("hop");
    }
  });

  test("hard stops like cyber_policy and upstream_no_response outrank moderation wording", () => {
    for (const code of ["cyber_policy", "CYBER_POLICY", "upstream_no_response", "UPSTREAM_NO_RESPONSE", "origin_rejected"]) {
      const body = JSON.stringify({
        error: {
          code,
          message: "The input was refused by moderation.",
        },
      });
      expect(isProviderModerationRefusal(400, body, code)).toBe(false);
      expect(comboFailureDecision(400, body, { code })).toBe("stop");

      for (const message of [body, `data: ${body}`]) {
        expect(isProviderModerationRefusal(400, message)).toBe(false);
        expect(comboFailureDecision(400, message)).toBe("stop");
      }
    }
  });

  test("truncated 422 with uppercase CYBER_POLICY code stays terminal", () => {
    const raw = JSON.stringify({
      error: {
        message: "The input was refused by moderation. Categories: harassment.",
        code: "CYBER_POLICY",
      },
    });
    // Truncated at 500 characters
    const truncated = `Provider error 422: ${raw.slice(0, 80)}`;
    expect(comboFailureDecision(422, truncated, { code: "CYBER_POLICY" })).toBe("stop");
    expect(isProviderModerationRefusal(422, truncated, "CYBER_POLICY")).toBe(false);
  });

  test("reflected validation text quoting moderation phrases stays terminal", () => {
    const reflected = [
      "Invalid parameter 'prompt': text cannot contain 'blocked by moderation'",
      "Validation error: argument quotes 'refused by moderation'",
      "Invalid parameter: value quotes 'blocked by moderation'",
      "The value 'blocked by moderation' is not supported for field 'prompt'",
    ];
    for (const message of reflected) {
      expect(isProviderModerationRefusal(400, message)).toBe(false);
      expect(comboFailureDecision(400, message)).toBe("stop");

      const body = JSON.stringify({ error: { message } });
      expect(isProviderModerationRefusal(400, body)).toBe(false);
      expect(comboFailureDecision(400, body)).toBe("stop");
    }
  });

  test("quoted moderation phrases in validation values stay terminal", () => {
    const reflected = [
      "Invalid enum value 'blocked by moderation' for param 'prompt'",
      'The value "blocked by moderation" is invalid',
      "param 'mode' does not accept \"flagged by moderation\"",
      "Unknown value 'content management policy' supplied for 'reason'",
      "Unsupported value 'refused by moderation' at messages[0].content",
    ];
    for (const message of reflected) {
      expect(isProviderModerationRefusal(400, message)).toBe(false);
      expect(comboFailureDecision(400, message)).toBe("stop");

      const body = JSON.stringify({ error: { message, param: "prompt" } });
      expect(isProviderModerationRefusal(400, body)).toBe(false);
      expect(comboFailureDecision(400, body)).toBe("stop");
    }
  });

  test("truncated envelope quoting a moderation value stays terminal", () => {
    const truncated = '{"error":{"message":"Invalid enum value \\"blocked by moderation\\" for param","param":"prompt"';
    expect(isProviderModerationRefusal(400, truncated)).toBe(false);
    expect(comboFailureDecision(400, truncated)).toBe("stop");
  });

  test("truncated or malformed JSON with moderation wording in unrelated fields fails closed", () => {
    const malformed = '{"error":{"message":"Invalid input","note":"blocked by moderation"';
    expect(isProviderModerationRefusal(400, malformed)).toBe(false);
    expect(comboFailureDecision(400, malformed)).toBe("stop");

    const unrelatedField = JSON.stringify({
      error: {
        message: "Invalid JSON input syntax",
        param: "notes",
        unrelated_note: "blocked by moderation",
      },
    });
    expect(isProviderModerationRefusal(400, unrelatedField)).toBe(false);
    expect(comboFailureDecision(400, unrelatedField)).toBe("stop");
  });

  test("a moderation verdict after a validation prefix stays terminal without a code", () => {
    const directValidation = "Validation error: the prompt was blocked by moderation";
    expect(isProviderModerationRefusal(400, directValidation)).toBe(false);
    expect(comboFailureDecision(400, directValidation)).toBe("stop");

    const body = JSON.stringify({ error: { message: directValidation } });
    expect(isProviderModerationRefusal(400, body)).toBe(false);
    // A validation error is evidence of its own: even with a caller's code it is not refusal copy.
    expect(isProviderModerationRefusal(400, directValidation, "content_filter")).toBe(false);
  });

  test("accepts indexed content parameter paths in coded moderation refusals", () => {
    for (const param of ["input[0].content", "messages[0].content", "messages[1].content[0].text", "input.prompt"]) {
      const body = JSON.stringify({
        error: {
          message: "The input was refused by moderation. Categories: harassment.",
          param,
        },
        code: "moderation_refusal",
      });
      expect(isProviderModerationRefusal(400, body)).toBe(true);
      expect(comboFailureDecision(400, body)).toBe("hop");
    }
  });

  test("multi-event SSE body with unparsed diagnostic note stays terminal", () => {
    const multiEventSse = 'data: {"event":"start"}\ndata: {"note":"blocked by moderation"}\ndata: {"error":"bad_request"}';
    expect(isProviderModerationRefusal(400, multiEventSse)).toBe(false);
    expect(comboFailureDecision(400, multiEventSse)).toBe("stop");
  });

  test("mixed-code hard stops outrank competing wrappers and nested moderation evidence", () => {
    // 422 JSON and single-line SSE with a root upstream_no_response code and nested moderation evidence
    const rootUpstreamNoResponse = JSON.stringify({
      code: "upstream_no_response",
      error: {
        message: "The input was refused by moderation. Categories: harassment.",
      },
    });
    expect(isProviderModerationRefusal(422, rootUpstreamNoResponse)).toBe(false);
    expect(comboFailureDecision(422, rootUpstreamNoResponse)).toBe("stop");

    const sseRootUpstreamNoResponse = `data: ${rootUpstreamNoResponse}`;
    expect(isProviderModerationRefusal(422, sseRootUpstreamNoResponse)).toBe(false);
    expect(comboFailureDecision(422, sseRootUpstreamNoResponse)).toBe("stop");

    // Moderation-coded wrapper around an inner hard code
    const moderationWrapperHardCode = JSON.stringify({
      error: {
        code: "moderation_refusal",
        type: "upstream_error",
        message: JSON.stringify({
          error: {
            code: "cyber_policy",
            message: "Blocked by cyber policy",
          },
        }),
      },
    });
    expect(isProviderModerationRefusal(400, moderationWrapperHardCode)).toBe(false);
    expect(comboFailureDecision(400, moderationWrapperHardCode)).toBe("stop");
  });

  test("a coded refusal over 500 characters hops on the whole body, never on the cut text", async () => {
    const requestId = "req_" + "x".repeat(600);
    const raw = JSON.stringify({
      error: {
        code: "content_filter",
        message: "The input was refused by moderation. Categories: harassment.",
        request_id: requestId,
      },
    });
    // A cut envelope does not parse, so it carries no structured verdict of its own.
    const truncated = raw.slice(0, 200);
    expect(isProviderModerationRefusal(400, truncated)).toBe(false);
    expect(comboFailureDecision(400, truncated)).toBe("stop");

    // Pass through consumeComboFailure where production truncation occurs
    const response = new Response(raw, { status: 400 });
    const failure = await consumeComboFailure(response);
    expect(failure.providerModerationRefusal).toBe(true);
    expect(comboFailureDecision(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).toBe("hop");
    expect(comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).toBe("none");
  });

  test("malformed JSON restricts recovery to error envelope and rejects non-error message fields", () => {
    // moderation wording in diagnostic.message rather than error.message
    const diagnosticMessage = '{"diagnostic":{"message":"blocked by moderation"},"error":{"message":"invalid param"}}'.slice(0, 75);
    expect(isProviderModerationRefusal(400, diagnosticMessage)).toBe(false);
    expect(comboFailureDecision(400, diagnosticMessage)).toBe("stop");

    // malformed 422 with upstream_no_response code and moderation phrasing
    const malformedHardStop = '{"code":"upstream_no_response","error":{"message":"The input was refused by moderation"'.slice(0, 70);
    expect(isProviderModerationRefusal(422, malformedHardStop)).toBe(false);
    expect(comboFailureDecision(422, malformedHardStop)).toBe("stop");
  });

  test("outer non-moderation parameter check precedes message unwrapping", () => {
    const outerBadParam = JSON.stringify({
      error: {
        param: "temperature",
        message: JSON.stringify({
          error: {
            message: "The input was refused by moderation. Categories: harassment.",
          },
        }),
      },
    });
    expect(isProviderModerationRefusal(400, outerBadParam)).toBe(false);
    expect(comboFailureDecision(400, outerBadParam)).toBe("stop");
  });

  test("wrapper limit exhaustion fails closed on unexamined structured text", () => {
    const deepConcealedHardCode = JSON.stringify({
      code: "moderation_refusal",
      error: {
        message: JSON.stringify({
          error: {
            message: JSON.stringify({
              error: {
                message: JSON.stringify({
                  error: {
                    code: "upstream_no_response",
                    message: "timed out",
                  },
                }),
              },
            }),
          },
        }),
      },
    });
    expect(isProviderModerationRefusal(400, deepConcealedHardCode)).toBe(false);
    expect(comboFailureDecision(400, deepConcealedHardCode)).toBe("stop");
  });

  test("a param on a record other than the coded verdict keeps the body terminal", async () => {
    const raw = JSON.stringify({
      request_info: { param: "unrelated_header" },
      error: {
        code: "content_filter",
        message: "The input was refused by moderation. Categories: harassment.",
        padding: "y".repeat(600),
      },
    });
    const response = new Response(raw, { status: 400 });
    const failure = await consumeComboFailure(response);
    expect(failure.providerModerationRefusal).toBe(false);
    expect(comboFailureDecision(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).toBe("stop");
  });

  test("a param outside the prompt or input keeps the body terminal even on the coded record", () => {
    const body = JSON.stringify({
      error: {
        code: "content_filter",
        message: "Your input violated content safety policy.",
        param: "instructions",
      },
    });
    expect(isProviderModerationRefusal(400, body)).toBe(false);
    expect(comboFailureDecision(400, body)).toBe("stop");
    expect(comboFailureCooldownScope(400, body)).not.toBe("none");
  });

  test("root content_filter code does not exempt nested validation error with disallowed param", () => {
    const body = JSON.stringify({
      code: "content_filter",
      error: {
        message: "Invalid temperature: must be between 0 and 2",
        param: "temperature",
      },
    });
    expect(isProviderModerationRefusal(400, body)).toBe(false);
    expect(comboFailureDecision(400, body)).toBe("stop");
  });

  test("truncated body with root moderation message and nested validation error prefers error envelope", () => {
    const raw = JSON.stringify({
      message: "The input was refused by moderation. Categories: harassment.",
      extra: { info: "nested" },
      error: {
        message: "Invalid parameter: prompt is missing",
        param: "prompt",
        padding: "z".repeat(600),
      },
    });
    const truncated = raw.slice(0, 180);
    expect(isProviderModerationRefusal(400, truncated)).toBe(false);
    expect(comboFailureDecision(400, truncated)).toBe("stop");
  });

  test("generic 400 errors without moderation phrasing stay terminal", () => {
    for (const message of [
      "Invalid JSON in request body",
      "Missing required parameter 'messages'",
      "Unknown model 'some-model'",
    ]) {
      const body = JSON.stringify({ error: { message } });
      expect(isProviderModerationRefusal(400, body)).toBe(false);
      expect(comboFailureDecision(400, body)).toBe("stop");
    }
  });
});


describe("provider moderation refusal never outranks a hard refusal", () => {
  const body = (error: Record<string, unknown>, root: Record<string, unknown> = {}) =>
    JSON.stringify({ ...root, error: { type: "invalid_request_error", ...error } });
  const cases: Array<[string, string, string | undefined, string | undefined]> = [
    ["invalid_prompt with content-policy prose", body({ code: "invalid_prompt", message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy." }), "invalid_prompt", undefined],
    ["bio_policy with moderation prose", body({ code: "bio_policy", message: "The input was refused by moderation. Categories: biology." }), "bio_policy", undefined],
    ["misalignment code with moderation prose", body({ code: "misalignment_policy_violation", message: "The input was flagged by moderation." }), "misalignment_policy_violation", undefined],
    ["content_filter code with safety-system prose", body({ code: "content_filter", message: "This request was blocked by our safety systems." }), "content_filter", undefined],
    ["plain moderation text that also carries safety copy", "The input was refused by moderation. We've limited access to this content for safety reasons.", undefined, undefined],
    ["terminal root code over a nested moderation code", body({ code: "content_filter", message: "The input was refused by moderation." }, { code: "invalid_prompt" }), "content_filter", "invalid_prompt"],
    ["nested hard code beside a moderation code", body({ code: "content_filter", message: "Blocked.", innererror: { code: "bio_policy" } }), "content_filter", undefined],
    ["unstripped gateway prefix with a non-replayable root", 'Gateway error 400: {"code":"upstream_no_response","error":{"code":"content_filter"}}', "content_filter", undefined],
    ["validation error that merely names moderation categories", body({ message: "Invalid metadata value: moderation categories: harassment" }), undefined, undefined],
    ["content_policy_violation root over a nested moderation code", body({ code: "content_filter", message: "The input was refused by moderation." }, { code: "content_policy_violation" }), "content_filter", "content_policy_violation"],
    ["content_policy_violation code with moderation prose", body({ code: "content_policy_violation", message: "Your request was refused by moderation." }), "content_policy_violation", undefined],
    ["an echoed value whose quote holds an apostrophe", body({ message: "Invalid enum value 'it's refused by moderation' for field mode" }), undefined, undefined],
    ["an echoed value in backticks", body({ message: "Unknown tool name `refused by moderation` in tools[0]" }), undefined, undefined],
    ["a JSON-escaped nested hard code", '{"error":{"code":"content_filter","message":"refused by moderation","inner":{"code":"\\u0062io_policy"}}}', "content_filter", undefined],
    // The policy-fallback path passes only error.code; the parsed root still speaks.
    ...(["context_length_exceeded", "invalid_request_error", "client_closed_request", "client_cancelled"] as const).map(root =>
      [`a ${root} root read from the body when only the nested code is passed`, body({ code: "content_filter", message: "The input was refused by moderation." }, { code: root }), "content_filter", undefined] as [string, string, string | undefined, string | undefined]),
    ["an echoed value in curly double quotes", body({ message: "Invalid value: \u201cblocked by moderation\u201d for messages[0].content", param: "messages[0].content" }), undefined, undefined],
    ["an echoed value in guillemets", body({ message: "Invalid value: \u00abblocked by moderation\u00bb for messages[0].content", param: "messages[0].content" }), undefined, undefined],
    ["an echoed value in curly single quotes holding an apostrophe", body({ message: "Invalid value: \u2018it\u2019s refused by moderation\u2019 for mode" }), undefined, undefined],
  ];
  for (const [label, message, code, rootCode] of cases) {
    test(label, () => {
      expect(isProviderModerationRefusal(400, message, code)).toBe(false);
      expect(comboFailureDecision(400, message, { code, rootCode })).toBe("stop");
      expect(comboFailureCooldownScope(400, message, { code })).not.toBe("none");
    });
  }

  test("the reported moderation refusal still hops without cooling the target", () => {
    const message = body({ code: "moderation_refusal", param: "input", message: "The input was refused by moderation. Categories: harassment." });
    expect(comboFailureDecision(400, message, { code: "moderation_refusal" })).toBe("hop");
    expect(comboFailureCooldownScope(400, message, { code: "moderation_refusal" })).toBe("none");
  });
});

describe("provider moderation refusal judged on the whole body", () => {
  test("a hard refusal past the classification cut still stops the combo", async () => {
    for (const hard of ["invalid_prompt", "bio_policy", "content_policy_violation", "upstream_no_response"]) {
      const raw = JSON.stringify({ error: {
        code: "content_filter",
        message: "The input was refused by moderation.",
        meta: { pad: "p".repeat(600), underlying: { code: hard } },
      } });
      const failure = await consumeComboFailure(new Response(raw, { status: 400 }));
      expect(failure.classificationText.length).toBeLessThanOrEqual(500);
      expect(failure.providerModerationRefusal).toBe(false);
      const options = { code: failure.upstreamCode, rootCode: failure.upstreamRootCode, providerModerationRefusal: failure.providerModerationRefusal };
      expect({ hard, decision: comboFailureDecision(400, failure.classificationText, options) }).toEqual({ hard, decision: "stop" });
      expect(comboFailureCooldownScope(400, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).not.toBe("none");
      // Without the whole-body verdict, a text that may have been cut never hops either.
      expect(isProviderModerationRefusal(400, raw.slice(0, 500), "content_filter")).toBe(false);
    }
  });

  test("CJK and fullwidth quoted echoes are not verdicts", () => {
    for (const [open, close] of [["\u300c", "\u300d"], ["\u300e", "\u300f"], ["\uff02", "\uff02"], ["\u201a", "\u2018"]]) {
      const message = JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid value " + open + "refused by moderation" + close + " for field mode" } });
      expect(isProviderModerationRefusal(400, message)).toBe(false);
      expect(comboFailureDecision(400, message)).toBe("stop");
    }
  });

  test("an error type passed as the code does not veto a coded moderation refusal", () => {
    // The policy-fallback path reads error.type when error.code is null; the canonical uncoded
    // OpenAI refusal is prose only and stays terminal.
    const uncoded = JSON.stringify({ error: { message: "The input was refused by moderation. Categories: harassment.", type: "invalid_request_error", param: null, code: null } });
    expect(comboFailureDecision(400, uncoded, { code: "invalid_request_error" })).toBe("stop");
    const coded = JSON.stringify({ error: { message: "The input was refused by moderation.", type: "invalid_request_error", param: "input", code: "moderation_refusal" } });
    expect(comboFailureDecision(400, coded, { code: "invalid_request_error" })).toBe("hop");
    expect(comboFailureDecision(400, coded)).toBe("hop");
  });
});

describe("provider moderation refusal keeps provider evidence and escaped echoes", () => {
  test("quota or credential codes beside moderation prose still cool the provider", () => {
    for (const code of ["insufficient_quota", "invalid_api_key"]) {
      const message = JSON.stringify({ error: { code, message: "The input was refused by moderation." } });
      expect({ code, scope: comboFailureCooldownScope(400, message, { code }) }).not.toEqual({ code, scope: "none" });
    }
  });

  test("a backslash-escaped quoted echo is not a verdict", () => {
    const message = 'Invalid value: \\"refused by moderation\\" for field mode';
    expect(isProviderModerationRefusal(400, message)).toBe(false);
    expect(comboFailureDecision(400, message)).toBe("stop");
  });
});

describe("provider moderation refusal: type-only verdicts, nested escapes and cyber copy", () => {
  for (const verdict of ["client_closed_request", "client_cancelled", "context_length_exceeded"]) {
    for (const where of ["root", "error"] as const) {
      test(verdict + " stated as the " + where + " type stops", async () => {
        const error = { code: "content_filter", message: "The input was refused by moderation.", ...(where === "error" ? { type: verdict } : {}) };
        const raw = JSON.stringify({ ...(where === "root" ? { type: verdict } : {}), error });
        const failure = await consumeComboFailure(new Response(raw, { status: 400 }));
        const options = { code: failure.upstreamCode, rootCode: failure.upstreamRootCode, providerModerationRefusal: failure.providerModerationRefusal };
        expect(comboFailureDecision(400, failure.classificationText, options)).toBe("stop");
        expect(comboFailureCooldownScope(400, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).not.toBe("none");
        expect(isProviderModerationRefusal(400, raw, "content_filter")).toBe(false);
      });
    }
  }

  test("nested and doubled quoted echoes are not verdicts", () => {
    for (const message of [
      String.raw`Invalid 'input': "it's a \"refused by moderation\" value".`,
      'Invalid value: ""refused by moderation"" for field mode',
    ]) {
      expect({ message, hop: isProviderModerationRefusal(400, message) }).toEqual({ message, hop: false });
      expect(comboFailureDecision(400, message)).toBe("stop");
    }
  });

  test("this proxy's own cyber-policy copy beside moderation prose stops", () => {
    const message = JSON.stringify({ error: { code: "content_filter", message: "The input was refused by moderation. Request blocked by the upstream cybersecurity policy." } });
    expect(isProviderModerationRefusal(400, message, "content_filter")).toBe(false);
    expect(comboFailureDecision(400, message, { code: "content_filter" })).toBe("stop");
  });
});

describe("provider moderation refusal: any spelling of a verdict, terminal prose, closing-only quotes", () => {
  const verdict = "The input was refused by moderation. Categories: harassment.";
  const carriers: Array<[string, (code: string) => Record<string, unknown>]> = [
    ["details", code => ({ error: { message: verdict, details: { code } } })],
    ["last_error", code => ({ error: { message: verdict }, last_error: { code } })],
    ["metadata", code => ({ error: { message: verdict, metadata: { code } } })],
    ["innererror", code => ({ error: { code: "content_filter", message: verdict, innererror: { code } } })],
    ["response.error", code => ({ response: { error: { code, message: verdict } } })],
  ];
  for (const hard of ["content-policy-violation", "client-cancelled", "context length exceeded", "bio.policy", "upstream-no-response"]) {
    for (const [carrier, build] of carriers) {
      test("a " + hard + " code in " + carrier + " stops", async () => {
        const raw = JSON.stringify(build(hard));
        const failure = await consumeComboFailure(new Response(raw, { status: 400 }));
        const options = { code: failure.upstreamCode, rootCode: failure.upstreamRootCode, providerModerationRefusal: failure.providerModerationRefusal };
        expect(comboFailureDecision(400, failure.classificationText, options)).toBe("stop");
        expect(isProviderModerationRefusal(400, raw)).toBe(false);
      });
    }
  }

  test("terminal prose beside a moderation verdict stops", () => {
    for (const tail of ["The upstream refused this request.", "client closed request", "You exceeded your current quota, please check your plan."]) {
      const message = verdict + " " + tail;
      expect({ tail, hop: isProviderModerationRefusal(400, message) }).toEqual({ tail, hop: false });
      expect(comboFailureCooldownScope(400, message)).not.toBe("none");
    }
  });

  test("a closing-only delimiter still quotes an echoed value", () => {
    for (const [open, close] of [["\u201d", "\u201d"], ["\u00bb", "\u00bb"], ["\u2019", "\u2019"], ["\u300d", "\u300d"]]) {
      const message = "Invalid value: " + open + "blocked by moderation" + close + " for field mode";
      expect({ open, hop: isProviderModerationRefusal(400, message) }).toEqual({ open, hop: false });
    }
  });

  test("content-management-policy prose needs the content_filter code", () => {
    const message = JSON.stringify({ error: { message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy." } });
    expect(isProviderModerationRefusal(400, message)).toBe(false);
    expect(isProviderModerationRefusal(400, message, "content_filter")).toBe(true);
  });
});

describe("provider moderation refusal: escaped whitespace, 422, rate-limit codes, policy path", () => {
  test("a JSON-escaped whitespace spelling of a hard code stops", async () => {
    for (const sep of ["\n", "\t", "\r\n"]) {
      for (const hard of ["content_policy_violation", "upstream_no_response", "client_cancelled", "client_closed_request"]) {
        const raw = JSON.stringify({ error: { message: "The input was refused by moderation." + sep + hard } });
        const failure = await consumeComboFailure(new Response(raw, { status: 400 }));
        expect({ hard, verdict: failure.providerModerationRefusal }).toEqual({ hard, verdict: false });
        expect(isProviderModerationRefusal(400, raw)).toBe(false);
      }
    }
  });

  test("a coded 422 moderation refusal hops without cooling; prose alone does not", () => {
    const coded = JSON.stringify({ error: { code: "content_filter", message: "The input was refused by moderation." } });
    expect(comboFailureDecision(422, coded)).toBe("hop");
    expect(comboFailureCooldownScope(422, coded)).toBe("none");
    const prose = JSON.stringify({ error: { message: "The prompt was blocked by moderation. Categories: violence" } });
    expect(comboFailureDecision(422, prose)).toBe("stop");
  });

  test("a structured rate-limit or overload code beside moderation prose keeps its own decision", () => {
    for (const code of ["rate_limit_exceeded", "slow_down", "server_is_overloaded"]) {
      const message = JSON.stringify({ error: { code, message: "The input was refused by moderation." } });
      expect(isProviderModerationRefusal(400, message, code)).toBe(false);
      expect(isProviderModerationRefusal(400, message)).toBe(false);
      expect(comboFailureCooldownScope(400, message, { code })).not.toBe("none");
    }
  });
});

describe("provider moderation refusal: diagnostics dev keeps terminal and verdict types", () => {
  const verdict = "The input was refused by moderation. Categories: harassment.";
  test("a malformed response_format diagnostic beside a moderation verdict stops", async () => {
    for (const raw of [
      JSON.stringify({ error: { code: "content_filter", message: verdict, detail: "Invalid schema for response_format 'reply': 'type' is a required property." } }),
      verdict + " response_format.json_schema.schema must be a valid JSON schema.",
    ]) {
      const failure = await consumeComboFailure(new Response(raw, { status: 400 }));
      const options = { code: failure.upstreamCode, rootCode: failure.upstreamRootCode, providerModerationRefusal: failure.providerModerationRefusal, malformedResponseFormat: failure.malformedResponseFormat };
      expect(comboFailureDecision(400, failure.classificationText, options)).toBe("stop");
      expect(comboFailureCooldownScope(400, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal, malformedResponseFormat: failure.malformedResponseFormat })).not.toBe("none");
    }
  });

  test("subscription-gate wording beside a moderation verdict stops", () => {
    const message = verdict + " This model requires a subscription.";
    expect(isProviderModerationRefusal(400, message)).toBe(false);
    expect(comboFailureDecision(400, message)).toBe("stop");
  });

  test("camelCase and slashed spellings of a hard code stop", () => {
    for (const hard of ["contentPolicyViolation", "clientClosedRequest", "content/policy/violation", "upstreamNoResponse"]) {
      const message = JSON.stringify({ error: { message: verdict, details: { code: hard } } });
      expect({ hard, hop: isProviderModerationRefusal(400, message) }).toEqual({ hard, hop: false });
    }
  });

  test("a verdict stated only as an error type stops", () => {
    for (const type of ["previous_response_not_found", "tool_catalog_too_large", "input_admission_refused", "invalid_parameter"]) {
      const message = JSON.stringify({ error: { message: verdict, type } });
      expect({ type, hop: isProviderModerationRefusal(400, message) }).toEqual({ type, hop: false });
      expect(comboFailureDecision(400, message)).toBe("stop");
    }
  });
});

describe("provider moderation refusal: safety-system wording and framed native status", () => {
  test("safety-system wording beside a moderation code stops", () => {
    for (const text of [
      "Your request was rejected as a result of our safety system. If you believe this is an error, you can check the status of your account.",
      "Your request was rejected by the safety system.",
      "The request was rejected because it was considered high risk",
    ]) {
      const message = JSON.stringify({ type: "error", error: { code: "content_filter", message: text } });
      expect({ text, hop: isProviderModerationRefusal(400, message, "content_filter") }).toEqual({ text, hop: false });
      expect(comboFailureDecision(400, message, { code: "content_filter" })).toBe("stop");
      expect(comboFailureCooldownScope(400, message, { code: "content_filter" })).not.toBe("none");
    }
  });
});
