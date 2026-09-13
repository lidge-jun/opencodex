/**
 * Audit F7 (2026-09-14): the Chat inbound effort allowlist omitted "none", so an
 * explicit request to disable reasoning was dropped as if nothing had been asked.
 *
 * "none" is the runtime's disable sentinel, not an unknown string:
 * src/reasoning-effort.ts accepts it and maps it to "omit the reasoning parameter",
 * and the Pi client export maps Pi's "off" level onto it
 * (src/clients/config-export.ts). For Anthropic families that think by default,
 * omitting the field is NOT equivalent to disabling — only an explicit
 * thinking:{type:"disabled"} turns thinking off (src/adapters/anthropic.ts:960-966).
 * So dropping "none" silently re-enabled thinking the caller had turned off.
 */
import { describe, expect, test } from "bun:test";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { responsesRequestSchema } from "../../src/responses/schema";

function chat(extra: Record<string, unknown>): Record<string, unknown> {
  return { model: "m", messages: [{ role: "user", content: "hi" }], ...extra };
}

function reasoningOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return body.reasoning as Record<string, unknown> | undefined;
}

describe("F7 explicit reasoning disable survives the Chat boundary", () => {
  test("preserves a flat reasoning_effort of none", () => {
    const body = chatCompletionsToResponsesBody(chat({ reasoning_effort: "none" }));
    expect(reasoningOf(body)?.effort).toBe("none");
  });

  test("preserves the nested reasoning.effort spelling", () => {
    const body = chatCompletionsToResponsesBody(chat({ reasoning: { effort: "none" } }));
    expect(reasoningOf(body)?.effort).toBe("none");
  });

  test("the produced body still validates against responsesRequestSchema", () => {
    const body = chatCompletionsToResponsesBody(chat({ reasoning_effort: "none" }));
    expect(responsesRequestSchema.safeParse(body).success).toBe(true);
  });

  test("every other ladder value is unchanged", () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(reasoningOf(chatCompletionsToResponsesBody(chat({ reasoning_effort: effort })))?.effort).toBe(effort);
    }
  });

  test("an unknown effort is still ignored rather than forwarded", () => {
    const body = chatCompletionsToResponsesBody(chat({ reasoning_effort: "turbo" }));
    expect(reasoningOf(body)?.effort).toBeUndefined();
  });

  test("omitting an effort entirely still produces no effort", () => {
    const body = chatCompletionsToResponsesBody(chat({}));
    expect(reasoningOf(body)?.effort).toBeUndefined();
  });
});
