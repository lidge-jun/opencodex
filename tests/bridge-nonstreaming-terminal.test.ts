import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { isTruncatedStopReason, truncationReasonFor } from "../src/responses/truncated-stop-reason";
import type { AdapterEvent } from "../src/types";

async function sseText(events: AdapterEvent[]): Promise<string> {
  async function* source(): AsyncGenerator<AdapterEvent> {
    for (const e of events) yield e;
  }
  return await new Response(bridgeToResponsesSSE(source(), "routed/model")).text();
}

function terminalEventNames(text: string): string[] {
  return text.split("\n\n")
    .map(f => f.trim())
    .map(f => f.split("\n").find(l => l.startsWith("event: "))?.slice(7) ?? "")
    .filter(n => n === "response.completed" || n === "response.incomplete" || n === "response.failed");
}

describe("buffered turns without an adapter terminal", () => {
  test("text with no done/error is not reported as completed", () => {
    const json = buildResponseJSON([{ type: "text", text: "partial answer" }], "routed/model");

    // The adapter stopped emitting mid-turn. Calling that a success is the shape that let a
    // truncated Cursor turn look finished.
    expect(json.status).toBe("incomplete");
    expect((json as { incomplete_details?: { reason?: string } }).incomplete_details?.reason).toBe("adapter_eof");
  });

  test("a tool call left open is never returned as a completed function call", () => {
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "js" },
      { type: "tool_call_delta", arguments: '{"code":"tru' },
    ], "routed/model");

    // The worst shape: a caller trusting `status` would try to execute half-written JSON.
    expect(json.status).toBe("incomplete");
    const call = json.output.find(o => (o as { type: string }).type === "function_call") as
      { status?: string; arguments?: string } | undefined;
    expect(call).toBeDefined();
    expect(call?.status).toBe("incomplete");
    expect(call?.arguments).toBe('{"code":"tru');
  });

  test("streaming and buffered agree on the terminal for the same events", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "js" },
      { type: "tool_call_delta", arguments: '{"code":"tru' },
    ];

    // Parity is the property that keeps these two paths from drifting apart again.
    expect(terminalEventNames(await sseText(events))).toEqual(["response.incomplete"]);
    expect(buildResponseJSON(events, "routed/model").status).toBe("incomplete");
  });

  test("an explicit done still completes", () => {
    const json = buildResponseJSON([
      { type: "text", text: "answer" },
      { type: "done" },
    ], "routed/model");

    expect(json.status).toBe("completed");
    expect((json as { incomplete_details?: unknown }).incomplete_details).toBeUndefined();
  });

  test("explicit error and explicit incomplete keep their own outcomes", () => {
    const failed = buildResponseJSON([
      { type: "text", text: "partial" },
      { type: "error", message: "upstream failed" },
    ], "routed/model");
    expect(failed.status).toBe("failed");

    const incomplete = buildResponseJSON([
      { type: "text", text: "partial" },
      { type: "incomplete", reason: "max_output_tokens" },
    ], "routed/model");
    expect(incomplete.status).toBe("incomplete");
    // The adapter's own reason must survive, not be overwritten by adapter_eof.
    expect((incomplete as { incomplete_details?: { reason?: string } }).incomplete_details?.reason)
      .toBe("max_output_tokens");
  });

  test("a completed tool call with a done event is unaffected", () => {
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "js" },
      { type: "tool_call_delta", arguments: '{"code":"ok"}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "routed/model");

    expect(json.status).toBe("completed");
    const call = json.output.find(o => (o as { type: string }).type === "function_call") as
      { status?: string } | undefined;
    expect(call?.status).toBe("completed");
  });
});

describe("compaction is never installed from a truncated turn", () => {
  // #422: a compaction item becomes REPLACEMENT HISTORY. The original guard could only see
  // explicit error/incomplete events, so a stream that stopped without any terminal slipped
  // past it — installing a truncated summary as the conversation's new past.
  test("no compaction item when the adapter emitted no terminal", () => {
    const json = buildResponseJSON(
      [{ type: "text", text: "half a summary" }],
      "routed/model",
      { compaction: true },
    );

    expect(json.status).toBe("incomplete");
    expect(json.output.some(o => (o as { type: string }).type === "compaction")).toBe(false);
  });

  test("compaction still emitted for a genuinely completed turn", () => {
    const json = buildResponseJSON(
      [{ type: "text", text: "a whole summary" }, { type: "done" }],
      "routed/model",
      { compaction: true },
    );

    expect(json.status).toBe("completed");
    expect(json.output.some(o => (o as { type: string }).type === "compaction")).toBe(true);
  });

  test("compaction stays suppressed for explicit failure terminals", () => {
    for (const terminal of [
      { type: "error", message: "upstream failed" } as const,
      { type: "incomplete", reason: "max_output_tokens" } as const,
    ]) {
      const json = buildResponseJSON(
        [{ type: "text", text: "partial" }, terminal],
        "routed/model",
        { compaction: true },
      );
      expect(json.output.some(o => (o as { type: string }).type === "compaction")).toBe(false);
    }
  });
});

describe("streaming compaction respects the same #422 guard", () => {
  async function streamCompaction(events: AdapterEvent[]): Promise<{ hasCompaction: boolean; terminals: string[] }> {
    async function* source(): AsyncGenerator<AdapterEvent> {
      for (const e of events) yield e;
    }
    const text = await new Response(bridgeToResponsesSSE(
      source(), "routed/model", undefined, undefined, undefined, undefined, 2_000, { compaction: true },
    )).text();
    return { hasCompaction: text.includes('"type":"compaction"'), terminals: terminalEventNames(text) };
  }

  const delta = (t: string) => ({ type: "text_delta", text: t }) as AdapterEvent;

  test("a max_tokens turn ships no compaction item", async () => {
    // Streaming emitted the item BEFORE reading stopReason, so a truncated summary was installed
    // as replacement history and the turn then declared itself incomplete.
    const { hasCompaction, terminals } = await streamCompaction([
      delta("half a summary"),
      { type: "done", stopReason: "max_tokens" },
    ]);

    expect(hasCompaction).toBe(false);
    expect(terminals).toEqual(["response.incomplete"]);
  });

  test("a content_filter turn ships no compaction item", async () => {
    const { hasCompaction, terminals } = await streamCompaction([
      delta("half a summary"),
      { type: "done", stopReason: "content_filter" },
    ]);

    expect(hasCompaction).toBe(false);
    expect(terminals).toEqual(["response.incomplete"]);
  });

  test("a clean compaction turn still ships exactly one compaction item", async () => {
    // codex-rs takes the first compaction item and fatals on zero, so suppression must not widen.
    const { hasCompaction, terminals } = await streamCompaction([
      delta("a whole summary"),
      { type: "done" },
    ]);

    expect(hasCompaction).toBe(true);
    expect(terminals).toEqual(["response.completed"]);
  });
});

describe("truncation is recognized regardless of adapter vocabulary", () => {
  // stopReason is an open-ended string and adapters disagree: openai-chat normalizes to
  // max_tokens/content_filter, Command Code forwards the raw "length", Anthropic forwards
  // stop_reason verbatim. Matching only the canonical pair let those turns install a
  // half-written summary as replacement history (#422).
  const delta = (t: string) => ({ type: "text_delta", text: t }) as AdapterEvent;

  async function streamTerminal(events: AdapterEvent[]): Promise<string> {
    async function* source(): AsyncGenerator<AdapterEvent> {
      for (const e of events) yield e;
    }
    const text = await new Response(bridgeToResponsesSSE(
      source(), "routed/model", undefined, undefined, undefined, undefined, 2_000, { compaction: true },
    )).text();
    return terminalEventNames(text)[0] ?? "";
  }

  async function streamCompactionItems(events: AdapterEvent[]): Promise<number> {
    async function* source(): AsyncGenerator<AdapterEvent> {
      for (const e of events) yield e;
    }
    const text = await new Response(bridgeToResponsesSSE(
      source(), "routed/model", undefined, undefined, undefined, undefined, 2_000, { compaction: true },
    )).text();
    // Count emitted ITEMS, not mentions: the compaction item also appears inside the terminal
    // response snapshot. A duplicate emission would slip past a boolean presence check.
    return text.split("\n\n")
      .filter(f => f.includes("event: response.output_item.done") && f.includes('"type":"compaction"'))
      .length;
  }

  function bufferedCompactionItems(events: AdapterEvent[]): number {
    const json = buildResponseJSON(events, "routed/model", { compaction: true });
    return (json.output as { type: string }[]).filter(o => o.type === "compaction").length;
  }

  const truncatedReasons = [
    "length",             // Command Code / raw OpenAI
    "max_tokens",         // canonical
    "content_filter",     // canonical
    "refusal",            // raw Anthropic
    "MAX_TOKENS",         // raw Gemini
    "MALFORMED_FUNCTION_CALL",
    "SAFETY",
  ];

  for (const reason of truncatedReasons) {
    test(`stopReason "${reason}" installs no compaction history (streaming and buffered)`, async () => {
      const events: AdapterEvent[] = [delta("half a summary"), { type: "done", stopReason: reason }];

      expect(await streamCompactionItems(events)).toBe(0);
      expect(bufferedCompactionItems(events)).toBe(0);
      // Suppression and terminal status must agree. Withholding the item while still reporting
      // success hands codex-rs a completed response with ZERO compaction items, which is fatal.
      expect(await streamTerminal(events)).toBe("response.incomplete");
      expect(buildResponseJSON(events, "routed/model", { compaction: true }).status).toBe("incomplete");
    });
  }

  test("a clean turn still ships EXACTLY ONE compaction item on both paths", async () => {
    // codex-rs takes the first compaction item and fatals on zero, so suppression must not
    // widen — and a duplicate would be just as wrong.
    const events: AdapterEvent[] = [delta("a whole summary"), { type: "done" }];

    expect(await streamCompactionItems(events)).toBe(1);
    expect(bufferedCompactionItems(events)).toBe(1);
  });

  test("an unrecognized stop reason is treated as a normal stop", async () => {
    // Unknown values must not fail healthy turns: an unrecognized reason is far more likely a
    // provider's ordinary stop than a silent truncation.
    const events: AdapterEvent[] = [delta("a whole summary"), { type: "done", stopReason: "end_turn" }];

    expect(await streamCompactionItems(events)).toBe(1);
    expect(bufferedCompactionItems(events)).toBe(1);
  });
});

describe("truncated-stop-reason classifier", () => {
  test("matches every adapter vocabulary case-insensitively", () => {
    for (const reason of [
      "max_tokens", "content_filter",              // canonical
      "length", "content-filter",                   // Command Code / AI SDK
      "pause_turn",                                 // Anthropic: turn needs continuation
      "refusal", "model_context_window_exceeded",   // Anthropic
      "MAX_TOKENS", "SAFETY", "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "LANGUAGE", // Gemini
      "Safety", "safety",                           // mixed case must not slip through
    ]) {
      expect(isTruncatedStopReason(reason)).toBe(true);
    }
  });

  test("normal stops are never treated as truncation", () => {
    // A false positive costs a compaction item, and codex-rs fatals on zero.
    for (const reason of ["end_turn", "stop", "stop_sequence", "tool_use", "STOP", "tool-calls", undefined]) {
      expect(isTruncatedStopReason(reason)).toBe(false);
    }
  });

  test("truncation maps to the right incomplete_details reason", () => {
    expect(truncationReasonFor("length")).toBe("max_output_tokens");
    expect(truncationReasonFor("model_context_window_exceeded")).toBe("max_output_tokens");
    expect(truncationReasonFor("refusal")).toBe("content_filter");
    expect(truncationReasonFor("SAFETY")).toBe("content_filter");
    expect(truncationReasonFor("end_turn")).toBeUndefined();
  });
});

describe("Command Code finishReason error is a failure, not a stop", () => {
  test("an error finish reason produces an adapter error terminal", () => {
    // The AI SDK's "error" means generation FAILED upstream. As a done+stopReason it either read
    // as a clean completion or, once classified, mislabelled an upstream error as a content
    // filter — rejecting it from the replay cache for the wrong reason.
    expect(isTruncatedStopReason("error")).toBe(false);
  });

  test("a turn that failed upstream reports failed, not incomplete", () => {
    const json = buildResponseJSON([
      { type: "text", text: "partial" },
      { type: "error", message: 'Command Code upstream ended the turn with finishReason "error"', status: 502, errorType: "upstream_error" },
    ], "routed/model", { compaction: true });

    expect(json.status).toBe("failed");
    // A failed turn must not install replacement history either.
    expect((json.output as { type: string }[]).some(o => o.type === "compaction")).toBe(false);
  });
});
