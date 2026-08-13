import { afterEach, describe, expect, test } from "bun:test";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import {
  createResponsesItemIdPayloadRewrite,
  hasResponsesItemIdRepair,
  repairResponsesJsonItemIds,
} from "../src/server/responses-item-id-repair";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const UUID_MSG = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const UUID_RS = "1b9d6bcd-bbfd-4b2d-9b9d-5c0a2fb41a1b";
const UUID_FC = "550e8400-e29b-41d4-a716-446655440000";

function deepseekProvider(): OcxProviderConfig {
  const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
  enrichProviderFromRegistry("deepseek", provider);
  return provider;
}

describe("registry-derived DeepSeek repair policy (#938)", () => {
  test("enrich fills the registry policy only when the provider has none", () => {
    const filled = deepseekProvider();
    expect(filled.responsesItemIdRepair).toEqual({ repairInvalidIds: true, repairMissingTerminalIds: true });

    const explicit = { ...filled, responsesItemIdRepair: { repairInvalidIds: false } };
    enrichProviderFromRegistry("deepseek", explicit);
    expect(explicit.responsesItemIdRepair).toEqual({ repairInvalidIds: false });
  });

  test("UUID message/reasoning ids become stable canonical ids; function_call ids are untouched", () => {
    const rewrite = createResponsesItemIdPayloadRewrite(
      deepseekProvider().responsesItemIdRepair!,
      createTestTranslatorBudget(),
    );
    const frame = (payload: unknown) => JSON.parse(rewrite(JSON.stringify(payload))) as Record<string, unknown>;

    const reasoningAdded = frame({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: UUID_RS, summary: [] },
    });
    const messageAdded = frame({
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: UUID_MSG, role: "assistant", status: "in_progress", content: [] },
    });
    const rsId = (reasoningAdded.item as { id: string }).id;
    const msgId = (messageAdded.item as { id: string }).id;
    expect(rsId).toMatch(/^rs_ocx_[a-f0-9]+_0$/);
    expect(msgId).toMatch(/^msg_ocx_[a-f0-9]+_1$/);

    // Every lifecycle occurrence of the same index gets the SAME canonical id.
    const textDelta = frame({ type: "response.output_text.delta", item_id: UUID_MSG, output_index: 1, delta: "hi" });
    expect(textDelta.item_id).toBe(msgId);
    const reasoningDone = frame({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: UUID_RS, summary: [] } });
    expect((reasoningDone.item as { id: string }).id).toBe(rsId);

    // The terminal snapshot repeats the canonical ids.
    const completed = frame({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "reasoning", id: UUID_RS, summary: [] },
          { type: "message", id: UUID_MSG, role: "assistant", status: "completed", content: [] },
        ],
      },
    });
    const output = (completed.response as { output: { id: string }[] }).output;
    expect(output[0]!.id).toBe(rsId);
    expect(output[1]!.id).toBe(msgId);

    // function_call id and call_id are never rewritten.
    const callDone = frame({
      type: "response.output_item.done",
      output_index: 2,
      item: { type: "function_call", id: UUID_FC, call_id: "call_abc", name: "search", arguments: "{}" },
    });
    expect((callDone.item as { id: string }).id).toBe(UUID_FC);
    expect((callDone.item as { call_id: string }).call_id).toBe("call_abc");
  });

  test("canonical and placeholder ids behave as before (no repair when already canonical)", () => {
    const rewrite = createResponsesItemIdPayloadRewrite(
      deepseekProvider().responsesItemIdRepair!,
      createTestTranslatorBudget(),
    );
    const payload = JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_real_123", role: "assistant", status: "in_progress", content: [] },
    });
    expect(rewrite(payload)).toBe(payload);
  });

  test("part events resolve by exact raw id, so a reused output_index cannot borrow the sibling's id", () => {
    // Audit finding (final gate): with both tables holding the same output_index, an
    // index-first lookup handed a reasoning content_part the MESSAGE canonical id.
    // The raw-id map makes the rewrite exact; the index fallback only serves events
    // without a known raw id.
    const rewrite = createResponsesItemIdPayloadRewrite(
      deepseekProvider().responsesItemIdRepair!,
      createTestTranslatorBudget(),
    );
    const frame = (payload: unknown) => JSON.parse(rewrite(JSON.stringify(payload))) as Record<string, unknown>;
    const rsAdded = frame({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: UUID_RS, summary: [] } });
    const msgAdded = frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: UUID_MSG, role: "assistant", status: "in_progress", content: [] } });
    const rsId = (rsAdded.item as { id: string }).id;
    const msgId = (msgAdded.item as { id: string }).id;
    const part = frame({ type: "response.content_part.done", item_id: UUID_RS, output_index: 0, content_index: 0, part: { type: "reasoning_text", text: "x" } });
    expect(part.item_id).toBe(rsId);
    expect(part.item_id).not.toBe(msgId);
    // A function_call's part event is never rewritten even when it shares an index.
    frame({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: UUID_FC, call_id: "call_abc", name: "search", arguments: "{}" } });
    const fcPart = frame({ type: "response.content_part.added", item_id: UUID_FC, output_index: 1, content_index: 0, part: { type: "output_text", text: "" } });
    expect(fcPart.item_id).toBe(UUID_FC);
    // …including when the function_call REUSES an index the message table holds
    // (final-audit reproduction: the index fallback borrowed the message id).
    const fcPartReused = frame({ type: "response.content_part.added", item_id: UUID_FC, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
    expect(fcPartReused.item_id).toBe(UUID_FC);
    // An already-canonical part id at a repaired index is never double-rewritten.
    const canonicalPart = frame({ type: "response.content_part.done", item_id: rsId, output_index: 0, content_index: 0, part: { type: "reasoning_text", text: "y" } });
    expect(canonicalPart.item_id).toBe(rsId);
  });

  test("one placeholder id reused across items maps each index to its own canonical id", () => {
    // Final-audit reproduction: a flat raw-id map collapsed two items sharing the
    // placeholder "shared" into the LAST item's canonical id. The (index, rawId)
    // key keeps them distinct.
    const rewrite = createResponsesItemIdPayloadRewrite(
      { message: ["shared"], reasoning: [] },
      createTestTranslatorBudget(),
    );
    const frame = (payload: unknown) => JSON.parse(rewrite(JSON.stringify(payload))) as Record<string, unknown>;
    const first = frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "shared", role: "assistant", status: "in_progress", content: [] } });
    const second = frame({ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "shared", role: "assistant", status: "in_progress", content: [] } });
    const firstId = (first.item as { id: string }).id;
    const secondId = (second.item as { id: string }).id;
    expect(firstId).not.toBe(secondId);
    const lateDelta = frame({ type: "response.output_text.delta", item_id: "shared", output_index: 0, delta: "hi" });
    expect(lateDelta.item_id).toBe(firstId);
  });

  test("repairResponsesJsonItemIds normalizes a whole bounded-JSON response", () => {
    const repaired = repairResponsesJsonItemIds(
      {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "reasoning", id: UUID_RS, summary: [] },
          { type: "message", id: UUID_MSG, role: "assistant", status: "completed", content: [] },
        ],
      },
      deepseekProvider().responsesItemIdRepair!,
      createTestTranslatorBudget(),
    );
    const output = repaired.output as { id: string }[];
    expect(output[0]!.id).toMatch(/^rs_ocx_/);
    expect(output[1]!.id).toMatch(/^msg_ocx_/);
  });
});

describe("streamed HTTP path carries canonical ids (#938)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("the relayed SSE contains no upstream UUID item ids (un-enriched saved seed)", async () => {
    // The live path must backfill the registry policy through routedProviderConfig —
    // no manual enrichProviderFromRegistry (the ordinary saved-config shape).
    const plainSeed = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
    expect(plainSeed.responsesItemIdRepair).toBeUndefined();
    // DeepSeek now streams for real (no bounded-JSON force): UUID-bearing frames,
    // terminal response.completed, and — per the official guide — NO data: [DONE].
    const upstreamFrames = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_deepseek", status: "in_progress", output: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: UUID_RS, summary: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "message", id: UUID_MSG, role: "assistant", status: "in_progress", content: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: UUID_MSG, output_index: 1, delta: "hi" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_deepseek", status: "completed", output: [
        { type: "reasoning", id: UUID_RS, summary: [] },
        { type: "message", id: UUID_MSG, role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] },
        { type: "function_call", id: UUID_FC, call_id: "call_keep", name: "search", arguments: "{}" },
      ] } })}\n\n`,
    ];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      expect(body.stream).toBe(true);
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of upstreamFrames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const config = { providers: { deepseek: plainSeed } } as unknown as OcxConfig;
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).not.toContain(UUID_MSG);
    expect(text).not.toContain(UUID_RS);
    expect(text).toContain("msg_ocx_");
    expect(text).toContain("rs_ocx_");
    // function_call identity survives byte-for-byte.
    expect(text).toContain(UUID_FC);
    expect(text).toContain("call_keep");
    expect(text).toContain("data: [DONE]");
  });

});
