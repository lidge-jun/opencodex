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
    // A native transport reports a zero-output model overflow as a generic upstream error with
    // precise context prose. That target is healthy; only the turn was too large for it.
    expect(comboFailureCooldownScope(502,
      "Your input exceeds the context window of this model. Please adjust your input and try again.",
      { code: "upstream_server_error" })).toBe("none");
    // A credential verdict keeps its provider scope even when the body quotes context prose.
    expect(comboFailureCooldownScope(401, "invalid key for the 200k context window tier")).toBe("provider");
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
  });

  test("evidence must come from the innermost message, not a stray code token", () => {
    const unrelated = JSON.stringify({ error: { ...unsupportedUser, code: "context_length_exceeded" } });
    expect(comboFailureDecision(400, unrelated)).toBe("stop");
    expect(comboFailureDecision(400, "ordinary invalid request", { code: "context_length_exceeded" })).toBe("stop");
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
