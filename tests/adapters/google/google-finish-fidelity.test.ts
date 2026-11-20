/**
 * Google response fidelity: usage composition, fail-closed finishes on every Google mode, finish
 * reasons and prompt blocks (devlog/_plan/261115_google_protocol_cpa_parity/050).
 */
import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import { googleStopReason, isGoogleTruncatedTurn } from "../../../src/adapters/google-truncation";
import { providerFailureDetailOf } from "../../../src/lib/failure-detail";
import type { AdapterEvent, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const providers: Record<string, OcxProviderConfig> = {
  "ai-studio": { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", googleMode: "ai-studio" } as OcxProviderConfig,
  vertex: { adapter: "google", baseUrl: "https://x", googleMode: "vertex" } as OcxProviderConfig,
};

function sseResponse(chunks: unknown[]): Response {
  return new Response(chunks.map(c => "data: " + JSON.stringify(c) + "\n\n").join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function stream(provider: OcxProviderConfig, chunks: unknown[]): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const ev of createGoogleAdapter(provider).parseStream(sseResponse(chunks))) events.push(ev);
  return events;
}

async function buffered(provider: OcxProviderConfig, body: unknown): Promise<AdapterEvent[]> {
  return (await createGoogleAdapter(provider).parseResponse!(Response.json(body))) ?? [];
}

const last = (events: AdapterEvent[]) => events[events.length - 1]!;

describe("Google usage composition", () => {
  test("output tokens include thinking; input includes tool-use prompt tokens", async () => {
    for (const provider of Object.values(providers)) {
      const events = await buffered(provider, {
        candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, toolUsePromptTokenCount: 4, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 3 },
      });
      expect(last(events)).toMatchObject({ type: "done", usage: { inputTokens: 14, outputTokens: 7, reasoningOutputTokens: 2, cachedInputTokens: 3 } });
    }
  });

  test("without thoughts or tool-use tokens the counts are unchanged", async () => {
    const events = await stream(providers["ai-studio"]!, [
      { candidates: [{ content: { parts: [{ text: "hi" }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
    ]);
    expect(last(events)).toMatchObject({ type: "done", usage: { inputTokens: 5, outputTokens: 2 } });
  });
});

describe("fail-closed finishes on every Google mode", () => {
  test("MALFORMED_FUNCTION_CALL fails closed on AI Studio too, stream and buffered", async () => {
    const streamed = await stream(providers["ai-studio"]!, [{ candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] }]);
    expect(last(streamed)).toMatchObject({ type: "error", replaySafeBeforeOutput: true });
    expect((last(streamed) as { message: string }).message).toContain("Gemini API");
    const whole = await buffered(providers["ai-studio"]!, { candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] });
    expect(last(whole)).toMatchObject({ type: "error" });
  });

  test("AI Studio MAX_TOKENS after a started tool call fails closed", async () => {
    const events = await stream(providers["ai-studio"]!, [{ candidates: [{ content: { parts: [{ functionCall: { name: "f", args: {} } }] }, finishReason: "MAX_TOKENS" }] }]);
    expect(last(events)).toMatchObject({ type: "error" });
  });

  test("UNEXPECTED_TOOL_CALL and MALFORMED_RESPONSE fail closed with no visible output", async () => {
    for (const provider of Object.values(providers)) for (const reason of ["UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"]) {
      const events = await stream(provider, [{ candidates: [{ content: { parts: [] }, finishReason: reason }] }]);
      expect(last(events)).toMatchObject({ type: "error", replaySafeBeforeOutput: true });
      expect(providerFailureDetailOf(last(events))?.finishReason).toBe(reason);
    }
  });

  test("with visible text, MALFORMED_RESPONSE is a content filter and UNEXPECTED_TOOL_CALL a plain stop", async () => {
    const filtered = await stream(providers.vertex!, [{ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MALFORMED_RESPONSE" }] }]);
    expect(last(filtered)).toMatchObject({ type: "done", stopReason: "content_filter" });
    const stopped = await stream(providers.vertex!, [{ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "UNEXPECTED_TOOL_CALL" }] }]);
    expect(last(stopped).type).toBe("done");
    expect(last(stopped)).not.toHaveProperty("stopReason");
  });

  test("the predicate", () => {
    expect(isGoogleTruncatedTurn("UNEXPECTED_TOOL_CALL", 0, false)).toBe(true);
    expect(isGoogleTruncatedTurn("UNEXPECTED_TOOL_CALL", 0, true)).toBe(false);
    expect(isGoogleTruncatedTurn("MALFORMED_FUNCTION_CALL", 0, true)).toBe(true);
    expect(isGoogleTruncatedTurn("MAX_TOKENS", 0, false)).toBe(false);
    expect(isGoogleTruncatedTurn("STOP", 3, false)).toBe(false);
  });
});

describe("Google finish reasons and prompt blocks", () => {
  test("IMAGE_SAFETY is a content filter, stream and buffered", async () => {
    expect(googleStopReason("IMAGE_SAFETY")).toBe("content_filter");
    expect(googleStopReason("MAX_TOKENS")).toBe("max_tokens");
    expect(googleStopReason("STOP")).toBeUndefined();
    const whole = await buffered(providers["ai-studio"]!, { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "IMAGE_SAFETY" }] });
    expect(last(whole)).toMatchObject({ type: "done", stopReason: "content_filter" });
  });

  test("a blocked prompt is a non-retryable error naming the reason, never Google's message", async () => {
    const block = { promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "secret-canary text" }, usageMetadata: { promptTokenCount: 3 } };
    for (const events of [await stream(providers["ai-studio"]!, [block]), await buffered(providers.vertex!, block)]) {
      const error = last(events) as { type: string; message: string; retryable?: boolean };
      expect(error.type).toBe("error");
      expect(error.message).toContain("PROHIBITED_CONTENT");
      expect(error.message).not.toContain("secret-canary");
      expect(error.retryable).toBe(false);
    }
    const odd = await buffered(providers.vertex!, { promptFeedback: { blockReason: "weird value!" } });
    expect((last(odd) as { message: string }).message).toContain("OTHER");
  });
});


describe("fail-closed and blocked outcomes carry explicit statuses", () => {
  test("a fail-closed finish is a 502 upstream_error on every mode", async () => {
    for (const reason of ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"]) {
      const events = await stream(providers.vertex!, [{ candidates: [{ content: { parts: [] }, finishReason: reason }] }]);
      expect(last(events)).toMatchObject({ type: "error", status: 502, errorType: "upstream_error" });
      const whole = await buffered(providers["ai-studio"]!, { candidates: [{ content: { parts: [] }, finishReason: reason }] });
      expect(last(whole)).toMatchObject({ type: "error", status: 502, errorType: "upstream_error" });
    }
  });

  test("a blocked prompt is a 400 invalid_prompt refusal, also on a wrapped Antigravity stream", async () => {
    const block = { promptFeedback: { blockReason: "SAFETY" } };
    const plain = await stream(providers["ai-studio"]!, [block]);
    expect(last(plain)).toMatchObject({ type: "error", status: 400, errorType: "invalid_request_error", code: "invalid_prompt" });
    const cca = { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist" } as OcxProviderConfig;
    const wrapped = await stream(cca, [{ response: block }]);
    expect(last(wrapped)).toMatchObject({ type: "error", code: "invalid_prompt" });
    expect((last(wrapped) as { message: string }).message).toContain("Antigravity");
  });

  test("thought text alone is not visible output", async () => {
    for (const reason of ["UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"]) {
      const events = await stream(providers.vertex!, [
        { candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }] },
        { candidates: [{ content: { parts: [] }, finishReason: reason }] },
      ]);
      expect(last(events)).toMatchObject({ type: "error", status: 502 });
      const whole = await buffered(providers.vertex!, { candidates: [{ content: { parts: [{ text: "thinking", thought: true }] }, finishReason: reason }] });
      expect(last(whole)).toMatchObject({ type: "error", status: 502 });
    }
  });

  test("buffered MALFORMED_RESPONSE with text is a content filter; AI Studio MAX_TOKENS without a call still ends normally", async () => {
    const filtered = await buffered(providers["ai-studio"]!, { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MALFORMED_RESPONSE" }] });
    expect(last(filtered)).toMatchObject({ type: "done", stopReason: "content_filter" });
    const capped = await stream(providers["ai-studio"]!, [{ candidates: [{ content: { parts: [{ text: "long" }] }, finishReason: "MAX_TOKENS" }] }]);
    expect(last(capped)).toMatchObject({ type: "done", stopReason: "max_tokens" });
  });

  test("a provider without googleMode is labelled Gemini API", async () => {
    const bare = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com" } as OcxProviderConfig;
    const events = await stream(bare, [{ candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] }]);
    expect((last(events) as { message: string }).message).toContain("Gemini API");
  });
});
