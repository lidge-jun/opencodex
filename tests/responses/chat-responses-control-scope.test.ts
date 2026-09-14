/**
 * Audit F2 (2026-09-14): a translated Chat turn lost `max_output_tokens`,
 * `temperature`, `top_p`, `stop` and `user` for EVERY provider on the
 * `openai-responses` adapter, keyed on the adapter string at the Chat ingress.
 *
 * The restriction is real for the canonical ChatGPT backend and wrong as a blanket
 * rule: seven providers share that adapter, and a generic key gateway accepts these
 * controls. Deciding at the ingress was also unsound for combo and policy routes,
 * whose concrete child is chosen later in the Responses pipeline — so an
 * ingress-time strip mutated shared intent before the real target was known.
 *
 * Sanitization now happens on the final outgoing body, gated on
 * isCanonicalOpenAiForwardProvider, which requires adapter openai-responses AND
 * authMode "forward" AND the canonical base URL.
 */
import { describe, expect, test } from "bun:test";
import { stripCanonicalForwardSamplingParams } from "../../src/adapters/openai-responses";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";

function chat(extra: Record<string, unknown>): Record<string, unknown> {
  return { model: "m", messages: [{ role: "user", content: "hi" }], ...extra };
}

describe("F2 the ingress no longer strips caller controls", () => {
  test("the translated body carries every control the caller sent", () => {
    const body = chatCompletionsToResponsesBody(chat({
      max_tokens: 123,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["END"],
      user: "u-1",
    }));

    expect(body.max_output_tokens).toBe(123);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.8);
    expect(body.stop).toEqual(["END"]);
    expect(body.user).toBe("u-1");
  });

  test("store stays pinned false for a translated turn", () => {
    expect(chatCompletionsToResponsesBody(chat({})).store).toBe(false);
  });
});

describe("F2 canonical-backend sanitization at the final target", () => {
  test("removes exactly the four controls the canonical backend rejects", () => {
    const out = stripCanonicalForwardSamplingParams({
      model: "gpt-5.6",
      temperature: 0.2,
      top_p: 0.8,
      stop: ["END"],
      user: "u-1",
      max_output_tokens: 123,
    }) as Record<string, unknown>;

    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.stop).toBeUndefined();
    expect(out.user).toBeUndefined();
    // max_output_tokens is owned by the separate forward-wide sanitizer, not this one.
    expect(out.max_output_tokens).toBe(123);
    expect(out.model).toBe("gpt-5.6");
  });

  test("never mutates its input, so _rawBody stays caller-owned", () => {
    const input = { temperature: 0.2, model: "gpt-5.6" };
    const out = stripCanonicalForwardSamplingParams(input);

    expect(out).not.toBe(input);
    expect(input.temperature).toBe(0.2);
  });

  test("returns the identical reference when no such control is present", () => {
    const input = { model: "gpt-5.6", input: [] };
    expect(stripCanonicalForwardSamplingParams(input)).toBe(input);
  });

  test("passes a non-object through untouched", () => {
    expect(stripCanonicalForwardSamplingParams(undefined)).toBeUndefined();
    expect(stripCanonicalForwardSamplingParams("x")).toBe("x");
  });
});
