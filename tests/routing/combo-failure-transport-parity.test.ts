import { describe, expect, test } from "bun:test";
import { comboFailureCooldownScope, comboFailureDecision } from "../../src/combos/failover";
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
