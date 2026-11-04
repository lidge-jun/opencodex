import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent, OcxProviderContinuationState } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

type Options = NonNullable<Parameters<typeof bridgeToResponsesSSE>[7]>;
type Frame = { type: string; response?: Record<string, any>; delta?: string; text?: string };
const text: AdapterEvent = { type: "text_delta", text: "Partial answer\n```ts\nconst x =" };
const terminals: AdapterEvent[] = [
  { type: "done", stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 20 } },
  { type: "incomplete", reason: "max_output_tokens", usage: { inputTokens: 5, outputTokens: 20 } },
];

async function deliver(events: AdapterEvent[], options: Options, streaming: boolean) {
  if (!streaming) {
    let providerState: OcxProviderContinuationState | undefined;
    const response = buildResponseJSON(events, "test-model", {
      ...options, onProviderState: state => { providerState = state; },
    });
    return { response, frames: [] as Frame[], providerState };
  }
  const budget = createTestTranslatorBudget();
  let providerState: OcxProviderContinuationState | undefined;
  async function* source() { yield* events; }
  try {
    const body = await new Response(bridgeToResponsesSSE(
      source(), "test-model", undefined, undefined, undefined, undefined, 2_000,
      { ...options, translatorBudget: budget, onCompletedResponse: (_response, state) => { providerState = state; } },
    )).text();
    const frames: Frame[] = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const terminal = frames.filter(frame => ["response.completed", "response.incomplete", "response.failed"].includes(frame.type));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.type).toBe(`response.${terminal[0]!.response!.status}`);
    return { response: terminal[0]!.response!, frames, providerState };
  } finally { budget.dispose(); }
}

for (const streaming of [false, true]) {
  for (const terminal of terminals) {
    describe(`${streaming ? "SSE" : "JSON"} ${terminal.type} max-output completion`, () => {
      test("explicit opt-in completes text without changing deltas, done text, or usage", async () => {
        const { response, frames } = await deliver([text, terminal], { completeOnMaxOutputTokens: true }, streaming);
        expect(response.status).toBe("completed");
        expect(response.incomplete_details).toBeUndefined();
        expect(response.usage).toMatchObject({ input_tokens: 5, output_tokens: 20 });
        expect((response.output as any[])[0].content[0].text).toBe(text.text);
        if (streaming) {
          expect(frames.filter(frame => frame.type === "response.output_text.delta").map(frame => frame.delta).join("")).toBe(text.text);
          expect(frames.find(frame => frame.type === "response.output_text.done")!.text).toBe(text.text);
        }
      });

      for (const enabled of [undefined, false]) {
        test(`setting ${enabled} preserves incomplete`, async () => {
          const { response } = await deliver([text, terminal], { completeOnMaxOutputTokens: enabled }, streaming);
          expect(response.status).toBe("incomplete");
          expect(response.incomplete_details).toMatchObject({ reason: "max_output_tokens" });
        });
      }

      for (const type of ["json_schema", "json_object"] as const) {
        test(`structured ${type} stays incomplete`, async () => {
          const options = { completeOnMaxOutputTokens: true, textFormat: { type } };
          const { response } = await deliver([text, terminal], options, streaming);
          expect(response.status).toBe("incomplete");
          expect(response.incomplete_details).toMatchObject({ reason: "max_output_tokens" });
        });
      }

      const exclusions: [string, AdapterEvent[]][] = [
        ["unfinished function", [{ type: "tool_call_start", id: "call_a", name: "lookup" }, { type: "tool_call_delta", arguments: '{"q":' }]],
        ["unfinished function before later text", [{ type: "tool_call_start", id: "call_a", name: "lookup" }, { type: "tool_call_delta", arguments: "{}" }, text]],
        ["explicitly incomplete tool end", [{ type: "tool_call_start", id: "call_a", name: "lookup" }, { type: "tool_call_delta", arguments: "{}" }, { type: "tool_call_end", incomplete: true }]],
        ["completed tool output", [{ type: "tool_call_start", id: "call_a", name: "lookup" }, { type: "tool_call_delta", arguments: "{}" }, { type: "tool_call_end" }, text]],
        ["orphan tool delta", [{ type: "tool_call_delta", arguments: "{}" }, text]],
        ["unfinished hosted search", [{ type: "web_search_call_begin", id: "search_a" }, text]],
        ["completed hosted search", [{ type: "web_search_call_end", id: "search_a", queries: ["fixture query"] }, text]],
        ["reasoning output", [{ type: "thinking_delta", thinking: "pending thought" }, text]],
        ["hidden raw reasoning", [{ type: "reasoning_raw_delta", text: "pending thought" }, text]],
        ["signed progress", [{ type: "text_delta", text: "progress", anthropicThinkingSignature: "fixture-signature" }, text]],
      ];
      for (const [name, events] of exclusions) {
        test(`${name} stays incomplete`, async () => {
          const { response } = await deliver([text, ...events, terminal], { completeOnMaxOutputTokens: true }, streaming);
          expect(response.status).toBe("incomplete");
          expect(response.incomplete_details).toMatchObject({ reason: "max_output_tokens" });
        });
      }

      test("empty output stays incomplete", async () => {
        const { response } = await deliver([terminal], { completeOnMaxOutputTokens: true }, streaming);
        expect(response.status).toBe("incomplete");
      });

      test("compaction truncation emits no replacement and commits no retention", async () => {
        let commits = 0;
        const { response } = await deliver([text, terminal], {
          completeOnMaxOutputTokens: true, compaction: true,
          compactionRetention: { encode: summary => `encoded:${summary}`, commit: () => { commits++; } },
        }, streaming);
        expect(response.status).toBe("incomplete");
        expect(response.output).toEqual([]);
        expect(commits).toBe(0);
      });

      test("provider state and end_turn survive the converted terminal", async () => {
        const state = { cursor: { conversationId: "fixture-conversation", checkpointRef: "fixture-checkpoint" } };
        const { response, providerState } = await deliver([text, { ...terminal, providerState: state, endTurn: true }], { completeOnMaxOutputTokens: true }, streaming);
        expect(response.status).toBe("completed");
        expect(providerState).toEqual(state);
        expect(response.end_turn).toBe(true);
      });

      test("explicitly unfinished turn stays incomplete", async () => {
        const { response } = await deliver([text, { ...terminal, endTurn: false }], { completeOnMaxOutputTokens: true }, streaming);
        expect(response.status).toBe("incomplete");
        expect(response.end_turn).toBe(false);
      });
    });
  }

  describe(`${streaming ? "SSE" : "JSON"} other exclusions and output integrity`, () => {
    for (const reason of ["length", "max_output_tokens"]) {
      test(`raw done ${reason} qualifies`, async () => {
        const { response } = await deliver([text, { type: "done", stopReason: reason }], { completeOnMaxOutputTokens: true }, streaming);
        expect(response.status).toBe("completed");
      });
    }
    for (const stopReason of ["pause_turn", "model_context_window_exceeded", "model_context_window_exceeded_exception"]) {
      test(`raw done ${stopReason} stays incomplete`, async () => {
        const { response } = await deliver([text, { type: "done", stopReason }], { completeOnMaxOutputTokens: true }, streaming);
        expect(response.status).toBe("incomplete");
      });
    }
    for (const reason of ["content_filter", "pause_turn", "model_context_window_exceeded", "model_context_window_exceeded_exception", "adapter_eof"]) {
      test(`${reason} stays incomplete`, async () => {
        const { response } = await deliver([text, { type: "incomplete", reason }], { completeOnMaxOutputTokens: true }, streaming);
        expect(response.status).toBe("incomplete");
      });
    }
    test("adapter EOF stays incomplete", async () => {
      const { response } = await deliver([text], { completeOnMaxOutputTokens: true }, streaming);
      expect(response.status).toBe("incomplete");
    });
    test("errors stay failed", async () => {
      const { response } = await deliver([text, { type: "error", message: "fixture failure", status: 502 }], { completeOnMaxOutputTokens: true }, streaming);
      expect(response.status).toBe("failed");
    });
    test("earlier completed messages and valid empty fences remain exact", async () => {
      const first = "```\n```";
      const { response } = await deliver([
        { type: "text_delta", text: first }, { type: "assistant_boundary" }, text, terminals[0]!,
      ], { completeOnMaxOutputTokens: true }, streaming);
      expect(response.status).toBe("completed");
      expect((response.output as any[]).map(item => item.content[0].text)).toEqual([first, text.text]);
    });
    for (const enabled of [false, true]) {
      test(`clean empty compaction never substitutes history (setting ${enabled})`, async () => {
        const encoded: string[] = [];
        await deliver([{ type: "done" }], {
          completeOnMaxOutputTokens: enabled, compaction: true,
          compactionRetention: { encode: summary => { encoded.push(summary); return "fixture-ciphertext"; }, commit: () => {} },
        }, streaming);
        expect(encoded).toEqual([""]);
      });
    }
  });
}
