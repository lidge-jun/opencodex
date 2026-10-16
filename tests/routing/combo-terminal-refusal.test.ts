import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { comboFailureDecision } from "../../src/combos";
import type { RequestLogContext } from "../../src/server/request-log";
import { preflightComboStreamResponse } from "../../src/server/responses/combo-stream-preflight";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import type { AdapterEvent } from "../../src/types";

/**
 * #4312 inside a combo. A refusal with no output is a zero-output `response.failed`, which the
 * combo preflight converts into an HTTP error before any byte reaches the client. That must end
 * the chain rather than send the refused prompt to the next target, and once output has been
 * relayed the same terminal has to stay a streamed `response.failed`.
 */
const REFUSAL: AdapterEvent = {
  type: "incomplete",
  reason: "content_filter",
  retryable: false,
  message: 'upstream ended the turn with stop_reason "refusal"',
  usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
};

function bridged(events: AdapterEvent[]): Response {
  async function* source(): AsyncGenerator<AdapterEvent> {
    for (const event of events) yield event;
  }
  return new Response(
    bridgeToResponsesSSE(source(), "routed/model", undefined, undefined, undefined, undefined, 2_000, {
      terminalRefusalAsFailed: true,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("combo: terminal upstream refusal", () => {
  test("a zero-output refusal becomes an HTTP 400 that stops the chain", async () => {
    const logCtx = {} as RequestLogContext;
    const preflight = await preflightComboStreamResponse(bridged([REFUSAL]), logCtx);

    if (preflight.kind !== "failed") throw new Error(`expected a failed preflight, got ${preflight.kind}`);
    expect(preflight.response.status).toBe(400);
    expect(preflight.response.headers.get("content-type")).toContain("application/json");
    const body = await preflight.response.clone().json() as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("invalid_prompt");
    expect(body.error.message).toContain("refused");
    // The steps `src/server/responses/core-combo.ts` takes with a failed preflight: consume the
    // failure body, carry the preflight's model-refusal evidence over, then decide. The loop's
    // other stop conditions (non-replayable marker, spent replacement) are not in play here.
    const failure = await consumeComboFailure(preflight.response);
    expect(failure.response.status).toBe(400);
    expect(failure.upstreamCode).toBe("invalid_prompt");
    expect(comboFailureDecision(failure.response.status, failure.classificationText, {
      code: failure.upstreamCode,
      codexModelRefusal: preflight.codexModelRefusal ?? failure.codexModelRefusal,
    })).toBe("stop");
  });

  test("a refusal after output is relayed as the streamed response.failed", async () => {
    const preflight = await preflightComboStreamResponse(
      bridged([{ type: "text_delta", text: "I can" }, REFUSAL]),
      {} as RequestLogContext,
    );

    expect(preflight.kind).toBe("accepted");
    const text = await preflight.response.text();
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"code":"invalid_prompt"');
    expect(text).not.toContain("event: response.incomplete");
  });
});
