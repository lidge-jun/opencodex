import { describe, expect, test } from "bun:test";
import { comboFailureCooldownScope, comboFailureDecision, isProviderModerationRefusal } from "../../src/combos/failover";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { preflightComboStreamResponse } from "../../src/server/responses/combo-stream-preflight";
import { preflightNativeMessagesResponse } from "../../src/server/messages-native-preflight";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { RequestLogContext } from "../../src/server/request-log";

/**
 * A combo failure arrives over two transports: an HTTP error body and a single SSE error frame.
 * The verdict is a property of the envelope, not of the carrier, so the same document must resolve
 * the same way on both. These cases are the ones the two paths previously disagreed on: the former
 * HTTP rule treated every root code except `"400"` as its own verdict, so recognized hop codes and
 * an empty code stopped there while the stream advanced; and HTTP selected the nested record first,
 * so a root hard stop was invisible when the record was retryable.
 */
const OPAQUE = { message: "Provider returned error", code: 400, metadata: { raw: "ERROR", provider_name: "Stealth" } };
const logCtx = (): RequestLogContext => ({ model: "m1", provider: "a" });

type Row = {
  name: string;
  status: number;
  /** The HTTP body text the child returned. */
  body: Record<string, unknown>;
  /** The same envelope as a single SSE frame, minus the `type: "error"` discriminator. */
  frame?: Record<string, unknown>;
  decision: "hop" | "stop";
  scope?: "none" | "target" | "provider";
};

async function overHttp(row: Row): Promise<{ decision: string; scope: string }> {
  const failure = await consumeComboFailure(new Response(JSON.stringify(row.body), {
    status: row.status,
    headers: { "content-type": "application/json" },
  }));
  const options = {
    code: failure.upstreamCode,
    rootCode: failure.upstreamRootCode,
    malformedResponseFormat: failure.malformedResponseFormat,
    openRouterOpaque400: failure.openRouterOpaque400,
  };
  return {
    decision: comboFailureDecision(row.status, failure.classificationText, options),
    scope: comboFailureCooldownScope(row.status, failure.classificationText, options),
  };
}

async function overSse(row: Row): Promise<"hop" | "stop"> {
  const payload = { type: "error", status: row.status, ...(row.frame ?? row.body) };
  const result = await preflightComboStreamResponse(new Response(
    `data: ${JSON.stringify(payload)}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  ), logCtx());
  return result.kind === "failed" ? "hop" : "stop";
}

describe("combo failure verdict parity across HTTP and SSE", () => {
  const rows: Row[] = [
    // The genuine wrapper: OpenRouter's untyped numeric-400 record, nested under `error`.
    { name: "genuine opaque wrapper", status: 400, body: { error: OPAQUE }, decision: "hop", scope: "none" },
    // A diagnostic type names its own verdict on either carrier. HTTP states it at the root; SSE
    // has only the record's `type` slot, because the frame's `type` is the event discriminator.
    {
      name: "typed error record", status: 400,
      body: { type: "invalid_request_error", error: OPAQUE },
      frame: { error: { ...OPAQUE, type: "invalid_request_error" } },
      decision: "stop",
    },
    // Recognized hop codes on the root must not make the wrapper terminal.
    ...[
      "model_not_found",
      "insufficient_quota",
      "usage_limit_exceeded",
      "free_rate_limited",
      "input_admission_refused",
      "unsupported_input_modality",
    ].map(code => ({
      name: `root hop code ${code}`, status: 400,
      body: { code, error: OPAQUE }, decision: "hop" as const, scope: "none" as const,
    })),
    // Root hard stops stay terminal even when the record looks opaque.
    ...[
      "origin_rejected",
      "cyber_policy",
      "content_policy_violation",
      "context_length_exceeded",
      "invalid_request_error",
    ].map(code => ({
      name: `root hard stop ${code}`, status: 400,
      body: { code, error: OPAQUE }, decision: "stop" as const,
    })),
    // A root hard stop outranks a retryable record code, which is where HTTP used to hop.
    {
      name: "root content policy with retryable record", status: 400,
      body: { code: "content_policy_violation", error: { code: "model_not_found" } },
      decision: "stop",
    },
    {
      name: "root origin_rejected with 429 record", status: 400,
      body: { code: "origin_rejected", error: { message: "rate limited", code: "rate_limit_exceeded" } },
      decision: "stop",
    },
    // The rule is symmetric: a hop-signal root cannot carry a terminal record across either.
    {
      name: "root hop code with terminal record", status: 400,
      body: { code: "model_not_found", error: { message: "refused", code: "content_policy_violation" } },
      decision: "stop",
    },
    // A bare numeric `code` is the envelope's own HTTP status evidence: without a separate
    // status field it must not collapse to 502 on the stream carrier.
    {
      name: "numeric 429 code without status", status: 429,
      body: { error: { message: "slow down", code: 429 } },
      frame: { status: undefined, error: { message: "slow down", code: 429 } },
      decision: "hop", scope: "target",
    },
    // An absent root code is no verdict, so the wrapper keeps speaking.
    { name: "empty root code", status: 400, body: { code: "", error: OPAQUE }, decision: "hop", scope: "none" },
    { name: "blank root code", status: 400, body: { code: "   ", error: OPAQUE }, decision: "hop", scope: "none" },
    // A bare `response.error` is not an error event, so neither transport reads it.
    { name: "response.error wrapper", status: 400, body: { response: { error: OPAQUE } }, decision: "stop" },
    // Conflicting retryable pairs keep dev's hop.
    {
      name: "429 rate_limit_exceeded pair", status: 429,
      body: { code: "rate_limit_exceeded", error: { message: "rate limited", code: "rate_limit_exceeded" } },
      decision: "hop", scope: "target",
    },
    {
      name: "server_error/server_is_overloaded pair", status: 503,
      body: { code: "server_error", error: { message: "overloaded", code: "server_is_overloaded" } },
      decision: "hop", scope: "target",
    },
    // A malformed response_format is a request defect, including when the root carries the detail.
    {
      name: "malformed response_format detail", status: 400,
      body: { error: { ...OPAQUE, detail: "response_format.json_schema.schema must be a valid JSON schema." } },
      decision: "stop", scope: "target",
    },
    {
      name: "malformed response_format at the root", status: 400,
      body: { detail: "Invalid schema for response_format: 'type' must be 'object'", error: OPAQUE },
      decision: "stop", scope: "target",
    },
  ];

  for (const row of rows) {
    test(`${row.name} resolves identically on both transports`, async () => {
      const http = await overHttp(row);
      const sse = await overSse(row);
      expect({ http: http.decision, sse }).toEqual({ http: row.decision, sse: row.decision });
      if (row.scope !== undefined) expect(http.scope).toBe(row.scope);
    });
  }
});

describe("a moderation verdict survives the rebuilt preflight envelope", () => {
  const loop = async (response: Response) => {
    const failure = await consumeComboFailure(response);
    const options = {
      code: failure.upstreamCode, rootCode: failure.upstreamRootCode,
      malformedResponseFormat: failure.malformedResponseFormat, openRouterOpaque400: failure.openRouterOpaque400,
      providerModerationRefusal: failure.providerModerationRefusal,
    };
    return {
      decision: comboFailureDecision(failure.response.status, failure.classificationText, options),
      scope: comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal }),
    };
  };

  test("a root-coded responses stream refusal hops without cooling, as over HTTP", async () => {
    for (const code of ["content_filter", "moderation_refusal"]) {
      const event = { type: "error", status: 400, code, error: { type: "invalid_request_error", message: "The input was refused by moderation." } };
      const result = await preflightComboStreamResponse(new Response(
        "data: " + JSON.stringify(event) + "\n\n", { headers: { "content-type": "text/event-stream" } },
      ), logCtx());
      expect(result.kind).toBe("failed");
      expect({ code, ...(await loop(result.response)) }).toEqual({ code, decision: "hop", scope: "none" });
    }
  });

  test("an Azure-style native Messages refusal keeps its moderation evidence", async () => {
    const event = { type: "error", error: { code: "content_filter", message: "The response was filtered.",
      innererror: { code: "ResponsibleAIPolicyViolation", content_filter_result: { hate: { filtered: true, severity: "high" } } } } };
    const prelude = 'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{"input_tokens":5,"output_tokens":0}}}\n\n';
    const result = await preflightNativeMessagesResponse(new Response(
      prelude + "event: error\ndata: " + JSON.stringify(event) + "\n\n", { headers: { "content-type": "text/event-stream" } },
    ), { model: "fixture", provider: "anth" }, createTestTranslatorBudget());
    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(400);
    expect(await loop(result.response)).toEqual({ decision: "hop", scope: "none" });
  });
});

test("a native refusal frame that states its own non-400 status keeps the record mapping and its cooldown", async () => {
  const prelude = 'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{"input_tokens":5,"output_tokens":0}}}\n\n';
  for (const status of [429, 503]) {
    const event = { type: "error", status, error: { code: "content_filter", message: "The input was refused by moderation." } };
    const result = await preflightNativeMessagesResponse(new Response(
      prelude + "event: error\ndata: " + JSON.stringify(event) + "\n\n", { headers: { "content-type": "text/event-stream" } },
    ), { model: "fixture", provider: "anth" }, createTestTranslatorBudget());
    expect(result.kind).toBe("failed");
    expect(result.response.status).not.toBe(400);
    const failure = await consumeComboFailure(result.response);
    expect(comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).not.toBe("none");
  }
});

describe("vetoed moderation bodies agree across transports", () => {
  const loopOf = async (response: Response) => {
    const failure = await consumeComboFailure(response);
    const options = {
      code: failure.upstreamCode, rootCode: failure.upstreamRootCode,
      malformedResponseFormat: failure.malformedResponseFormat, openRouterOpaque400: failure.openRouterOpaque400,
      providerModerationRefusal: failure.providerModerationRefusal,
    };
    return {
      decision: comboFailureDecision(failure.response.status, failure.classificationText, options),
      scope: comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal }),
    };
  };

  test("a response.failed frame whose whole body vetoes moderation does not hop after the rebuilt envelope", async () => {
    let checked = 0;
    const error = { code: "content_filter", message: "The input was refused by moderation." };
    for (const frame of [
      { type: "response.failed", response: { status: "failed", error: { ...error, innererror: { code: "cyber_policy" } } } },
      { type: "response.failed", code: "context_length_exceeded", response: { status: "failed", error } },
      { type: "response.failed", response: { status: "failed", error: { ...error, metadata: { code: "cyber_policy" } } } },
    ]) {
      const ctx: RequestLogContext = { ...logCtx(), terminalHttpStatus: 400 };
      const result = await preflightComboStreamResponse(new Response(
        "data: " + JSON.stringify(frame) + "\n\n", { headers: { "content-type": "text/event-stream" } },
      ), ctx);
      if (result.kind !== "failed") continue;
      checked += 1;
      expect({ frame: JSON.stringify(frame).slice(0, 60), ...(await loopOf(result.response)) })
        .toEqual({ frame: JSON.stringify(frame).slice(0, 60), decision: "stop", scope: "target" });
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("a native frame that states 429 in any spelling is never a moderation hop", async () => {
    const prelude = 'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{"input_tokens":5,"output_tokens":0}}}\n\n';
    const record = { type: "invalid_request_error", code: "content_filter", message: "Filtered" };
    for (const framed of [{ status: 429 }, { status: "429" }, { status_code: 429 }, { http_status: 429 }]) {
      const event = { type: "error", ...framed, error: record };
      const result = await preflightNativeMessagesResponse(new Response(
        prelude + "event: error\ndata: " + JSON.stringify(event) + "\n\n", { headers: { "content-type": "text/event-stream" } },
      ), { model: "fixture", provider: "anth" }, createTestTranslatorBudget());
      if (result.kind !== "failed") continue;
      const outcome = await loopOf(result.response);
      expect({ framed, scope: outcome.scope }).not.toEqual({ framed, scope: "none" });
    }
  });
});

test("a genuine coded refusal in a response.failed frame hops without cooling, like the bare error frame and HTTP", async () => {
  const error = { type: "invalid_request_error", code: "content_filter", message: "The input was refused by moderation.",
    innererror: { code: "ResponsibleAIPolicyViolation", content_filter_result: { hate: { filtered: true, severity: "high" } } } };
  const frame = { type: "response.failed", status: "failed", response: { status: "failed", error } };
  const ctx: RequestLogContext = { ...logCtx(), terminalHttpStatus: 400 };
  const result = await preflightComboStreamResponse(new Response(
    "data: " + JSON.stringify(frame) + "\n\n", { headers: { "content-type": "text/event-stream" } },
  ), ctx);
  expect(result.kind).toBe("failed");
  const failure = await consumeComboFailure(result.response);
  const options = {
    code: failure.upstreamCode, rootCode: failure.upstreamRootCode,
    malformedResponseFormat: failure.malformedResponseFormat, openRouterOpaque400: failure.openRouterOpaque400,
    providerModerationRefusal: failure.providerModerationRefusal,
  };
  expect(comboFailureDecision(failure.response.status, failure.classificationText, options)).toBe("hop");
  expect(comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).toBe("none");
});

describe("stated statuses and structured flags beside a coded moderation verdict", () => {
  const loopOf = async (response: Response) => {
    const failure = await consumeComboFailure(response);
    const options = {
      code: failure.upstreamCode, rootCode: failure.upstreamRootCode,
      malformedResponseFormat: failure.malformedResponseFormat, openRouterOpaque400: failure.openRouterOpaque400,
      providerModerationRefusal: failure.providerModerationRefusal,
    };
    return {
      decision: comboFailureDecision(failure.response.status, failure.classificationText, options),
      scope: comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal }),
    };
  };
  const coded = { type: "invalid_request_error", message: "The input was refused by moderation.", code: "content_filter" };

  test("a body that states a non-400 status of its own is not a moderation refusal over HTTP", async () => {
    for (const stated of [{ status: 429 }, { status: 503 }, { status_code: "429" }, { http_status: "429" }]) {
      const body = JSON.stringify({ error: { ...coded, ...stated } });
      const outcome = await loopOf(new Response(body, { status: 400 }));
      expect({ stated, outcome }).toEqual({ stated, outcome: { decision: "stop", scope: "target" } });
    }
  });

  test("structured safety or reason fields veto the hop", async () => {
    for (const extra of [{ safety_violation: true }, { blocked: true, reason: "policy" }, { reason: "rate_limit_exceeded" }]) {
      const body = JSON.stringify({ error: { ...coded, ...extra } });
      expect({ extra, verdict: isProviderModerationRefusal(400, body, undefined, true) }).toEqual({ extra, verdict: false });
      expect((await loopOf(new Response(body, { status: 400 }))).scope).not.toBe("none");
    }
  });

  test("Azure per-category filter results stay compatible", async () => {
    const body = JSON.stringify({ error: { code: "content_filter", message: "The response was filtered.", status: 400,
      innererror: { code: "ResponsibleAIPolicyViolation", content_filter_result: { hate: { filtered: true, severity: "high" }, jailbreak: { filtered: false, detected: false } } } } });
    expect(await loopOf(new Response(body, { status: 400 }))).toEqual({ decision: "hop", scope: "none" });
  });

  test("a status-less coded stream frame keeps the no-cool verdict", async () => {
    const event = { type: "error", code: "moderation_refusal" };
    const result = await preflightComboStreamResponse(new Response(
      "data: " + JSON.stringify(event) + "\n\n", { headers: { "content-type": "text/event-stream" } },
    ), logCtx());
    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(400);
    expect(await loopOf(result.response)).toEqual({ decision: "hop", scope: "none" });
  });
});

describe("provider evidence and status-less response.failed frames beside a coded moderation verdict", () => {
  test("billing, quota and account-state wording beside a moderation code keeps the provider decision", async () => {
    for (const text of [
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      "quota exceeded",
      "insufficient quota for this request",
      "Payment required to continue",
      "Account suspended",
    ]) {
      const body = JSON.stringify({ error: { code: "content_filter", message: text } });
      expect({ text, verdict: isProviderModerationRefusal(400, body, undefined, true) }).toEqual({ text, verdict: false });
      const failure = await consumeComboFailure(new Response(body, { status: 400 }));
      expect(comboFailureCooldownScope(400, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).not.toBe("none");
    }
  });

  test("a status-less response.failed moderation frame is the same 400 no-cool hop as over HTTP", async () => {
    const frame = { type: "response.failed", response: { status: "failed", error: { code: "content_filter", message: "The input was refused by moderation." } } };
    const result = await preflightComboStreamResponse(new Response(
      "data: " + JSON.stringify(frame) + "\n\n", { headers: { "content-type": "text/event-stream" } },
    ), logCtx());
    expect(result.kind).toBe("failed");
    expect(result.response.status).toBe(400);
    const failure = await consumeComboFailure(result.response);
    const options = { code: failure.upstreamCode, rootCode: failure.upstreamRootCode, providerModerationRefusal: failure.providerModerationRefusal };
    expect(comboFailureDecision(400, failure.classificationText, options)).toBe("hop");
    expect(comboFailureCooldownScope(400, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).toBe("none");
  });
});

describe("every prose field beside a coded verdict must describe the moderation refusal", () => {
  const coded = (message: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ error: { type: "invalid_request_error", code: "content_filter", message, ...extra } });
  const azureResults = {
    hate: { filtered: true, severity: "high" }, self_harm: { filtered: false, severity: "safe" },
    jailbreak: { filtered: false, detected: false },
    custom_blocklists: { filtered: false, details: [{ filtered: false, id: "list1" }] },
  };
  const azureWith = (extra: Record<string, unknown>) => JSON.stringify({ error: {
    code: "content_filter",
    message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy. Please modify your prompt and retry.",
    innererror: { code: "ResponsibleAIPolicyViolation", content_filter_result: { ...azureResults, ...extra } },
  } });

  test("parameter, model and account prose beside a moderation code keeps dev's decision", async () => {
    for (const body of [
      coded("Invalid 'temperature': maximum value is 2."),
      coded("The model gpt-9 does not exist"),
      coded("This account has been deactivated."),
      coded("Your account is disabled."),
      coded("This organization has been disabled."),
      coded("Your API key is disabled."),
      coded("The request was rejected because the account is not active."),
      coded("The input was refused by moderation.", { accountSuspended: true }),
      coded("The input was refused by moderation.", { metadata: { account_status: "suspended" } }),
      coded("The input was refused by moderation.", { httpStatus: 429 }),
      coded("The input was refused by moderation.", { hint: "The model gpt-9 does not exist" }),
      coded("The input was refused by moderation.", { note: "Invalid 'temperature': maximum value is 2." }),
      coded("The input was refused by moderation.", { metadata: { raw: "Your account is past due" } }),
      coded("The input was refused by moderation.", { param: "temperature" }),
      coded("The input was refused by moderation.", { param: "max_tokens" }),
      coded("The input was refused by moderation.", { details: ["The model gpt-9 does not exist"] }),
      coded("The input was refused by moderation.", { details: ["Your account is past due"] }),
      coded("The input was refused by moderation.", { note: "Refused by moderation. Your account is past due." }),
      coded("The input was refused by moderation.", { note: "Refused by moderation; your organization is over its spend limit." }),
      coded("The input was refused by moderation.", { note: "The model gpt-9 does not exist BUT the input was refused by moderation." }),
    ]) {
      expect({ body, verdict: isProviderModerationRefusal(400, body, undefined, true) }).toEqual({ body, verdict: false });
      const failure = await consumeComboFailure(new Response(body, { status: 400 }));
      expect(comboFailureCooldownScope(400, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).not.toBe("none");
    }
  });

  test("genuine coded refusals still hop", () => {
    for (const body of [
      coded("The input was refused by moderation. Categories: harassment."),
      JSON.stringify({ error: { code: "content_filter", message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy. Please modify your prompt and retry.", innererror: { code: "ResponsibleAIPolicyViolation" } } }),
      JSON.stringify({ error: { code: "moderation_refusal", message: "Your request was flagged by moderation." } }),
      coded("The input was refused by moderation.", { request_id: "req_abc123" }),
      coded("The input was refused by moderation.", { param: "input" }),
      coded("The input was refused by moderation. Categories: sexual, hate. Please modify your prompt and retry."),
      coded("The input was refused by moderation. Categories: hate, harassment, self-harm."),
      coded("The input was refused by moderation. Categories: sexual and hate."),
      coded("filtered"),
      coded("Content filtered by moderation."),
      azureWith({}),
      JSON.stringify({ error: { code: "content_filter", message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy. Please modify your prompt and retry. To learn more about our content filtering policies please read our documentation: https://go.microsoft.com/fwlink/?linkid=2198766" } }),
    ]) {
      expect({ body, verdict: isProviderModerationRefusal(400, body, undefined, true) }).toEqual({ body, verdict: true });
    }
  });

  test("only known refusal copy and known fields pass beside a coded verdict", async () => {
    for (const body of [
      // Evidence joined by separators other than a sentence break.
      coded("Refused by moderation \u2014 your account is past due."),
      coded("Refused by moderation: your account is past due."),
      coded("Filtered by moderation (your account is past due)."),
      coded("Filtered by moderation / your account is past due."),
      coded("Filtered by moderation\tyour account is past due."),
      coded("Filtered by moderation;your account is past due."),
      coded("Filtered by moderation so your account is past due."),
      // Follow-up clauses that carry evidence of their own.
      coded("Content filtered by moderation. Learn more: the model gpt-9 does not exist."),
      coded("Content filtered by moderation. For more information about your suspended account."),
      coded("Content filtered by moderation. Retry with model gpt-9 which does not exist."),
      coded("Content filtered by moderation. Please modify your input for the suspended account."),
      coded("The input was refused by moderation. Categories: model gpt-9 does not exist."),
      // Bare tokens under fields a refusal does not carry.
      coded("The input was refused by moderation.", { metadata: { account: "suspended" } }),
      coded("The input was refused by moderation.", { state: "past_due" }),
      coded("The input was refused by moderation.", { account_status: "disabled" }),
      // Azure's filter results carry only their own shape.
      azureWith({ note: "Your account is past due" }),
      azureWith({ hate: { filtered: true, severity: "high", note: "account past due" } }),
      azureWith({ account: "suspended" }),
      azureWith({ hate: { filtered: true, severity: "past_due" } }),
      azureWith({ error: { code: "content_filter_error", message: "The contents are not filtered" } }),
      azureWith({ hate: { filtered: true, severity: "high", status: 429 } }),
      // Only a code states the verdict; a type of content_filter alone is not one.
      JSON.stringify({ error: { type: "content_filter", message: "The input was refused by moderation." } }),
    ]) {
      expect({ body, verdict: isProviderModerationRefusal(400, body, undefined, true) }).toEqual({ body, verdict: false });
      const failure = await consumeComboFailure(new Response(body, { status: 400 }));
      expect(comboFailureCooldownScope(400, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).not.toBe("none");
    }
  });

  test("a response.failed carrier's echoed instructions and tools do not veto its coded refusal", async () => {
    const frame = {
      type: "response.failed",
      response: {
        status: "failed",
        model: "gpt-test",
        instructions: "You are a helpful assistant. Answer briefly.",
        tools: [{ type: "function", name: "lookup", description: "Look up an order by its number." }],
        error: { code: "content_filter", message: "The input was refused by moderation." },
      },
    };
    const result = await preflightComboStreamResponse(new Response(
      "data: " + JSON.stringify(frame) + "\n\n", { headers: { "content-type": "text/event-stream" } },
    ), logCtx());
    expect(result.kind).toBe("failed");
    const failure = await consumeComboFailure(result.response);
    const options = { code: failure.upstreamCode, rootCode: failure.upstreamRootCode, providerModerationRefusal: failure.providerModerationRefusal };
    expect(comboFailureDecision(failure.response.status, failure.classificationText, options)).toBe("hop");
    expect(comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal })).toBe("none");
  });

  test("evidence on a response.failed carrier outside its error record still vetoes the no-cool hop", async () => {
    const error = { code: "content_filter", message: "The input was refused by moderation." };
    for (const extra of [
      { status_code: 429 },
      { safety_violation: true },
      { note: "The model gpt-9 does not exist" },
      { incomplete_details: { reason: "Your account is past due" } },
      { metadata: { raw: "Your account is past due" } },
      { metadata: { httpStatus: 503 } },
      { metadata: { safety_violation: true } },
      { metadata: { client: "my app v2" } },
      // A model's own output filter (incomplete reason only, no code) stays terminal.
      { incomplete_details: { reason: "content_filter" }, error: null },
    ]) {
      const frame = { type: "response.failed", response: { status: "failed", error, ...extra } };
      const result = await preflightComboStreamResponse(new Response(
        "data: " + JSON.stringify(frame) + "\n\n", { headers: { "content-type": "text/event-stream" } },
      ), logCtx());
      expect(result.kind).toBe("failed");
      const failure = await consumeComboFailure(result.response);
      const scope = comboFailureCooldownScope(failure.response.status, failure.classificationText, { code: failure.upstreamCode, providerModerationRefusal: failure.providerModerationRefusal });
      expect({ extra, scope }).not.toEqual({ extra, scope: "none" });
    }
  });

  test("a long whitespace run in upstream prose is judged in linear time", () => {
    // The clause splitter once backtracked across whitespace runs: about 2 s for this body.
    const body = JSON.stringify({ error: { code: "content_filter", message: "moderation" + " ".repeat(60_000) + "x" } });
    const started = performance.now();
    expect(isProviderModerationRefusal(400, body, undefined, true)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
