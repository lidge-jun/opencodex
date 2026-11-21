import { describe, expect, test } from "bun:test";
import { comboFailureCooldownScope, comboFailureDecision } from "../../src/combos/failover";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { formatErrorResponse } from "../../src/bridge/errors";
import { M365_RESPONSE_LIMIT_MESSAGES } from "../../src/adapters/m365-copilot/response-limits";
import { OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE } from "../../src/adapters/ollama-late-attribution";

/**
 * #9017: a provider's HTTP 413 is that target's intake limit, so a combo tries the next untried
 * target without cooling it. The proxy's own 413s, post-send adapter buffer 413s and any 413 that
 * states a hard refusal stay terminal. Moved out of router-combo-failover-classification.test.ts
 * to keep that file under the file-size ratchet.
 */
describe("combo provider 413 verdicts", () => {
  test("a provider 413 hops to the next target without cooling it (#9017)", () => {
    // Targets carry different intake limits and the provider refused before processing the turn,
    // so the next untried target may accept it. This reverses the generic-413 stop recorded in
    // devlog/_fin/260904_bug_stack_train/040_deferrals.md.
    const anthropic = JSON.stringify({ type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum size" } });
    for (const [message, code] of [
      ["request too large", undefined],
      ["Provider error 413", undefined],
      [anthropic, "request_too_large"],
      [JSON.stringify({ error: { message: "Payload Too Large" } }), undefined],
    ] as const) {
      expect(comboFailureDecision(413, message, { code })).toBe("hop");
      expect(comboFailureCooldownScope(413, message, { code })).toBe("none");
    }
  });

  test("each proxy-owned 413 stays terminal", () => {
    for (const code of ["translation_buffer_limit", "inbound_body_too_large", "outbound_body_too_large"]) {
      expect(comboFailureDecision(413, "request translation buffer exceeded the safe limit", { code })).toBe("stop");
      // The same refusal read from its body when the structured code did not survive.
      expect(comboFailureDecision(413, JSON.stringify({ error: { message: "refused", type: code } }))).toBe("stop");
    }
    // Ollama's late-attribution limit is recognized only by its exact constant, as the combo's
    // client-envelope selector does.
    expect(comboFailureDecision(413, OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE, { code: "request_too_large" })).toBe("stop");
    expect(comboFailureDecision(413, JSON.stringify({ error: {
      message: OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE, type: "request_too_large", code: "request_too_large",
    } }), { code: "request_too_large" })).toBe("stop");
  });

  test("a proxy translator-budget 413 formatted as request_too_large still stops (#9017 review)", async () => {
    // adapter-dispatch formats this refusal with type and code request_too_large, so the
    // translation_buffer_limit code never reaches the decision; the proxy's wording does.
    for (const message of ["request translation buffer exceeded the safe limit", "upstream translation buffer exceeded the safe limit"]) {
      const failure = await consumeComboFailure(formatErrorResponse(413, "request_too_large", message, { code: "translation_buffer_limit" }));
      expect(failure.upstreamCode).toBe("request_too_large");
      expect(comboFailureDecision(failure.response.status, failure.classificationText, { code: failure.upstreamCode })).toBe("stop");
    }
    // The real formatter path for the other proxy-owned 413s keeps their code.
    for (const [type, code] of [["outbound_body_too_large", "outbound_body_too_large"], ["inbound_body_too_large", "inbound_body_too_large"]]) {
      const failure = await consumeComboFailure(formatErrorResponse(413, type, "refused"));
      expect(failure.upstreamCode).toBe(code);
      expect(comboFailureDecision(failure.response.status, failure.classificationText, { code: failure.upstreamCode })).toBe("stop");
    }
    // A provider's own 413 through the same consumer still hops.
    const provider = await consumeComboFailure(new Response(JSON.stringify({ error: { message: "Request Entity Too Large", type: "invalid_request_error" } }), { status: 413 }));
    expect(comboFailureDecision(provider.response.status, provider.classificationText, { code: provider.upstreamCode })).toBe("hop");
  });

  test("an adapter buffer 413 raised after the request was sent stays terminal (#9017 review)", async () => {
    // Microsoft 365 Copilot overflows its own answer, reasoning, message or frame buffer only
    // after ChatHub ran the turn, so another target must not generate it again.
    for (const message of Object.values(M365_RESPONSE_LIMIT_MESSAGES)) {
      const failure = await consumeComboFailure(formatErrorResponse(413, "upstream_error", message));
      expect(comboFailureDecision(failure.response.status, failure.classificationText, { code: failure.upstreamCode })).toBe("stop");
    }
    // Its pre-send caps are this target's intake limits, so the next target may still serve the turn.
    const preSend = await consumeComboFailure(formatErrorResponse(413, "upstream_error", "Microsoft 365 Copilot image exceeds the 5 MiB limit"));
    expect(comboFailureDecision(preSend.response.status, preSend.classificationText, { code: preSend.upstreamCode })).toBe("hop");
  });

  test("a hard refusal past the classification cut still keeps a provider 413 from hopping (#9017 review)", async () => {
    // consumeComboFailure hands the decision only the first 500 characters; the verdict it takes
    // from the whole bounded body must still see a bio_policy code placed after the cut.
    const padding = "x".repeat(800);
    const late = JSON.stringify({ error: { message: "Request Entity Too Large", type: "invalid_request_error", code: "request_too_large",
      padding, details: { code: "bio_policy" } } });
    const refused = await consumeComboFailure(new Response(late, { status: 413 }));
    expect(refused.classificationText).not.toContain("bio_policy");
    expect(refused.providerIntakeRefusal).toBe(false);
    expect(comboFailureDecision(413, refused.classificationText, { code: refused.upstreamCode, providerIntakeRefusal: refused.providerIntakeRefusal })).toBe("stop");
    // The identical envelope without the hard refusal still hops, and a context overflow code is
    // still this target's limit.
    for (const code of ["request_too_large", "context_length_exceeded"]) {
      const plain = await consumeComboFailure(new Response(JSON.stringify({ error: { message: "Request Entity Too Large", type: "invalid_request_error", code,
        padding, details: { note: "none" } } }), { status: 413 }));
      expect(plain.providerIntakeRefusal).toBe(true);
      expect(comboFailureDecision(413, plain.classificationText, { code: plain.upstreamCode, providerIntakeRefusal: plain.providerIntakeRefusal })).toBe("hop");
    }
  });

  test("hard stops still outrank a provider 413", () => {
    expect(comboFailureDecision(413, "too large", { code: "origin_rejected" })).toBe("stop");
    expect(comboFailureDecision(413, "too large", { code: "cyber_policy" })).toBe("stop");
    expect(comboFailureDecision(413, "too large", { code: "upstream_no_response" })).toBe("stop");
    expect(comboFailureDecision(413, "too large", { code: "content_policy_violation" })).toBe("stop");
    expect(comboFailureDecision(413, "too large", { code: "request_too_large", rootCode: "origin_rejected" })).toBe("stop");
    expect(comboFailureDecision(413, "the request was origin_rejected")).toBe("stop");
  });

  test("a 413 carrying a structured per-minute token cap hops without cooling the target (#9017)", () => {
    // Groq's tier refusal: HTTP 413 for a turn above this account's tokens-per-minute limit. The
    // payload is unchanged, but a later target with a larger tier can still serve it.
    const groq = JSON.stringify({ error: {
      message: "Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier "
        + "`on_demand` on tokens per minute (TPM): Limit 8000, Requested 9611, please reduce your message size and try again.",
      type: "tokens",
      code: "rate_limit_exceeded",
    } });
    expect(comboFailureDecision(413, groq, { code: "rate_limit_exceeded" })).toBe("hop");
    expect(comboFailureDecision(413, "too large", { code: "Rate-Limit-Exceeded" })).toBe("hop");
    expect(comboFailureCooldownScope(413, groq, { code: "rate_limit_exceeded" })).toBe("none");
    // The cap is a provider 413 like any other, so the body alone hops too; the code does not make
    // another status hop, and hard stops still outrank it.
    expect(comboFailureDecision(413, groq)).toBe("hop");
    expect(comboFailureDecision(400, "too large", { code: "rate_limit_exceeded" })).toBe("stop");
    expect(comboFailureDecision(499, "too large", { code: "rate_limit_exceeded" })).toBe("stop");
    expect(comboFailureDecision(413, "origin_rejected", { code: "rate_limit_exceeded" })).toBe("stop");
    expect(comboFailureDecision(413, "too large", { code: "rate_limit_exceeded", rootCode: "origin_rejected" }))
      .toBe("stop");
  });
});
