import { afterEach, describe, expect, test } from "bun:test";
import { observeContextBreakdown, type ContextBreakdownV1 } from "../../src/server/context-breakdown";
import { addFinalRequestLog, clearRequestLogsForTests, type RequestLogEntry } from "../../src/server/request-log";

afterEach(() => clearRequestLogsForTests());

const breakdown: ContextBreakdownV1 = {
  v: 1,
  parts: { system: 10, tools: 20, skills: 5, memory: 6, files: 7, results: 8, chat: 9 },
  turns: [4, 5],
  toolCount: 2,
};

function finalRow(extra: Record<string, unknown>): RequestLogEntry {
  const rows: RequestLogEntry[] = [];
  addFinalRequestLog("ctx-row", Date.now(), { model: "gpt-5", provider: "openai", ...extra }, 200, undefined, row => rows.push(row));
  return rows[0]!;
}

describe("context breakdown on the final request row", () => {
  test("the breakdown rides to the row; the window is set only where the adapter knows it", () => {
    const row = finalRow({ contextBreakdown: breakdown, provider: "devin", providerAdapter: "devin", model: "swe-2" });
    expect(row.contextBreakdown).toEqual(breakdown);
    expect(row.contextWindow).toBe(262_000);
  });

  test("a hosted model the adapter does not size takes the bundled vendor window", () => {
    const row = finalRow({ contextBreakdown: breakdown, model: "gpt-5" });
    expect(row.contextWindow).toBe(400_000);
  });

  test("an unknown window is left out, never guessed", () => {
    const row = finalRow({ contextBreakdown: breakdown, model: "ocx-unknown-model-xyz" });
    expect(row.contextBreakdown).toEqual(breakdown);
    expect("contextWindow" in row).toBe(false);
  });

  test("a row without a breakdown carries neither field", () => {
    const row = finalRow({ provider: "devin", providerAdapter: "devin", model: "swe-2" });
    expect("contextBreakdown" in row).toBe(false);
    expect("contextWindow" in row).toBe(false);
  });

  test("a combo row takes the window of the final attempt, not the combo's own provider", () => {
    const attempt = (adapter: string, model: string, ordinal: number) => ({
      ordinal, provider: adapter, model, adapter, status: ordinal === 1 ? 429 : 200, durationMs: 5,
      sendCount: 1, recoveryKinds: [], usageStatus: "unknown",
    });
    const row = finalRow({
      comboId: "combo-1",
      contextBreakdown: breakdown,
      attempts: [attempt("openai-chat", "other", 1), attempt("devin", "swe-1-6", 2)],
    });
    expect(row.contextWindow).toBe(200_000);
  });

  test("the first observer's reading is the one the row carries", () => {
    const ctx: { contextBreakdown?: ContextBreakdownV1 } = {};
    observeContextBreakdown(ctx, { messages: [{ role: "user", content: "a".repeat(40) }] }, "messages");
    const first = ctx.contextBreakdown;
    observeContextBreakdown(ctx, { input: "b".repeat(4000) }, "responses");
    expect(ctx.contextBreakdown).toBe(first);
    const row = finalRow(ctx);
    expect(row.contextBreakdown?.parts.chat).toBe(10);
  });
});
