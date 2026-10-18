import { test, expect } from "bun:test";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import {
  enableAnthropicReplayCapture, createAnthropicReplayCapture, takeAnthropicReplay,
  bindAnthropicReplay, anthropicReplayContent,
} from "../../../src/adapters/anthropic-replay";

function start(limit = 100_000) {
  const response = new Response();
  const budget = createTranslatorBudget({ maxTurnBytes: limit });
  const cleanup = enableAnthropicReplayCapture(response);
  const capture = createAnthropicReplayCapture(response, budget)!;
  capture.accept({ type: "message_start" });
  capture.accept({ type: "content_block_start", index: 0, content_block: { type: "text", text: "initial" } });
  return { budget, capture, cleanup };
}
function complete(capture: ReturnType<typeof start>["capture"]) {
  capture.accept({ type: "content_block_stop", index: 0 });
  capture.accept({ type: "message_stop" });
  const done = { type: "done" } as const;
  capture.finish(done);
  return done;
}

test("capture cancellation releases retained bytes idempotently", () => {
  const { budget, capture, cleanup } = start();
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  capture.discard(); cleanup(); capture.discard();
  expect(budget.snapshot().currentBytes).toBe(0);
});
test("invalid index releases bytes and cannot issue a snapshot", () => {
  const { budget, capture, cleanup } = start();
  capture.accept({ type: "content_block_stop", index: 9 });
  expect(takeAnthropicReplay(complete(capture))).toBeUndefined();
  cleanup();
  expect(budget.snapshot().currentBytes).toBe(0);
});
test("response cleanup releases an unclaimed complete snapshot", () => {
  const { budget, capture, cleanup } = start();
  complete(capture); capture.discard();
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  cleanup();
  expect(budget.snapshot().currentBytes).toBe(0);
});
test("claim transfers ownership until release; external and expired snapshots are refused", () => {
  const { budget, capture, cleanup } = start();
  const snapshot = takeAnthropicReplay(complete(capture))!;
  const message = { role: "assistant", content: [], timestamp: 0 } as const;
  const mutableMessage = { ...message, content: [] };
  bindAnthropicReplay(mutableMessage, snapshot);
  expect(anthropicReplayContent(mutableMessage)).toEqual([{ type: "text", text: "initial" }]);
  expect(() => bindAnthropicReplay(mutableMessage, { content: [], release() {} })).toThrow();
  cleanup(); capture.discard();
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  snapshot.release(); snapshot.release();
  expect(budget.snapshot().currentBytes).toBe(0);
  expect(() => bindAnthropicReplay(mutableMessage, snapshot)).toThrow();
  expect(() => anthropicReplayContent(mutableMessage)).toThrow();
});
test("budget overflow invalidates optional capture without throwing or refunding other owners", () => {
  const { budget, capture, cleanup } = start(1_000);
  budget.chargeRetained(100, { kind: "retained_collectors" });
  expect(() => capture.accept({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "x".repeat(2_000) } })).not.toThrow();
  expect(takeAnthropicReplay(complete(capture))).toBeUndefined();
  expect(budget.snapshot().currentBytes).toBe(100);
  capture.discard(); cleanup();
  expect(budget.snapshot().currentBytes).toBe(100);
  budget.releaseRetained(100, { kind: "retained_collectors" });
  expect(budget.snapshot().currentBytes).toBe(0);
  budget.dispose();
});

test("finish reservation pressure invalidates capture and preserves foreign retained bytes", () => {
  const { budget, capture, cleanup } = start(1_000);
  budget.chargeRetained(500, { kind: "retained_collectors" });
  let done: ReturnType<typeof complete> | undefined;
  expect(() => { done = complete(capture); }).not.toThrow();
  expect(takeAnthropicReplay(done!)).toBeUndefined();
  expect(budget.snapshot().currentBytes).toBe(500);
  cleanup();
  budget.releaseRetained(500, { kind: "retained_collectors" });
  expect(budget.snapshot().currentBytes).toBe(0);
  budget.dispose();
});

test("optional capture pressure does not replace a healthy adapter terminal", async () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 6_000 });
  const adapter = createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://synthetic.invalid", apiKey: "synthetic" });
  const text = "x".repeat(1_000);
  const response = new Response([
    { type: "message_start", message: { content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ].map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
  const cleanup = enableAnthropicReplayCapture(response);
  try {
    const events = [];
    for await (const event of adapter.parseStream(response, budget)) events.push(event);
    expect(events.filter(event => event.type === "error")).toEqual([]);
    expect(events.some(event => event.type === "text_delta" && event.text === text)).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    expect(takeAnthropicReplay(events.at(-1)!)).toBeUndefined();
    expect(budget.snapshot().overflows).toBeGreaterThan(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { cleanup(); budget.dispose(); }
});
