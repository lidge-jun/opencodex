import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tapAnthropicSseForLog } from "../../src/server/claude-messages";
import { decodeTokPerSecondResult } from "../../src/server/management/shared";
import {
  addFinalRequestLog,
  clearRequestLogsForTests,
  inspectResponseLogSsePayload,
  type RequestLogContext,
} from "../../src/server/request-log";
import { generationWindowFields, recordGenerationEvent } from "../../src/server/request-log-generation-window";
import { normalizeUsageEntryForTest, resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ctx = (): RequestLogContext => ({ model: "m", provider: "openai" });

test("the window opens at the first output item, reasoning included, and closes at the last delta", () => {
  const responses = ctx();
  recordGenerationEvent(responses, "response.created", 100);
  recordGenerationEvent(responses, "response.output_item.added", 1_000); // reasoning item
  recordGenerationEvent(responses, "response.reasoning_summary_text.delta", 2_000);
  recordGenerationEvent(responses, "response.output_item.added", 6_000); // first visible item
  recordGenerationEvent(responses, "response.output_text.delta", 9_000);
  recordGenerationEvent(responses, "response.completed", 9_500);
  expect(generationWindowFields(responses, 0)).toEqual({ genStartMs: 1_000, lastOutputMs: 9_000 });

  const anthropic = ctx();
  recordGenerationEvent(anthropic, "message_start", 50);
  recordGenerationEvent(anthropic, "content_block_start", 400); // thinking block
  recordGenerationEvent(anthropic, "content_block_delta", 700);
  recordGenerationEvent(anthropic, "content_block_delta", 3_400);
  recordGenerationEvent(anthropic, "message_delta", 3_600);
  recordGenerationEvent(anthropic, "message_stop", 3_700);
  expect(generationWindowFields(anthropic, 100)).toEqual({ genStartMs: 300, lastOutputMs: 3_300 });
});

test("no window is reported until an output delta has been seen", () => {
  const started = ctx();
  recordGenerationEvent(started, "response.output_item.added", 1_000);
  recordGenerationEvent(started, undefined, 2_000);
  expect(generationWindowFields(started, 0)).toEqual({});
});

test("the decode rate uses the generation window when the row carries one", () => {
  // A reasoning turn: 800 output tokens (reasoning included) generated from 1s to 9s, first
  // VISIBLE delta at 6s, stream closed at 10s. The post-TTFT window would be 4s and report 200.
  const row = { durationMs: 10_000, firstOutputMs: 6_000, usageStatus: "reported" as const, usage: { inputTokens: 10, outputTokens: 800 } };
  expect(decodeTokPerSecondResult(row)).toEqual({ kind: "value", value: 200, estimated: true, timingBasis: "legacy-post-visible-output" });
  expect(decodeTokPerSecondResult({ ...row, genStartMs: 1_000, lastOutputMs: 9_000 }))
    .toEqual({ kind: "value", value: 100, estimated: true, timingBasis: "generation-window" });
  // The floor still applies, and a generation window never falls back to the TTFT window.
  expect(decodeTokPerSecondResult({ ...row, genStartMs: 8_500, lastOutputMs: 9_000 }))
    .toEqual({ kind: "unavailable", reason: "decode_window_too_short" });
  expect(decodeTokPerSecondResult({ ...row, genStartMs: 9_000, lastOutputMs: 9_000 }))
    .toEqual({ kind: "unavailable", reason: "invalid_duration" });
});

test("the window persists to usage.jsonl as a pair, and an inverted pair is dropped", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-gen-window-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  try {
    const context = ctx();
    const start = Date.now() - 5_000;
    recordGenerationEvent(context, "response.output_item.added", start + 1_000);
    recordGenerationEvent(context, "response.output_text.delta", start + 4_000);
    addFinalRequestLog("gen-window", start, context, 200);
    const [row] = readFileSync(usageLogPath(home), "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    expect(row).toMatchObject({ requestId: "gen-window", genStartMs: 1_000, lastOutputMs: 4_000 });

    const base = { requestId: "r", timestamp: 1, provider: "openai", model: "m", status: 200, durationMs: 10, usageStatus: "unreported" as const };
    expect(normalizeUsageEntryForTest({ ...base, genStartMs: 5, lastOutputMs: 2 })).not.toHaveProperty("genStartMs");
    expect(normalizeUsageEntryForTest({ ...base, genStartMs: 5 })).not.toHaveProperty("genStartMs");
    expect(normalizeUsageEntryForTest({ ...base, genStartMs: 2, lastOutputMs: 5 }))
      .toMatchObject({ genStartMs: 2, lastOutputMs: 5 });
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    await removeTreeWithRetry(home);
  }
});

test("both live SSE taps feed the recorder", async () => {
  const responses = ctx();
  inspectResponseLogSsePayload(responses, JSON.stringify({ type: "response.output_item.added" }));
  inspectResponseLogSsePayload(responses, JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
  expect(responses.generationStartedAt).toBeNumber();
  expect(responses.lastOutputAt).toBeNumber();

  const anthropic = ctx();
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "message_stop" },
  ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
  const upstream = new Response(frames).body!;
  await new Response(tapAnthropicSseForLog(upstream, anthropic, () => {})).text();
  expect(anthropic.generationStartedAt).toBeNumber();
  expect(anthropic.lastOutputAt).toBeNumber();
});
