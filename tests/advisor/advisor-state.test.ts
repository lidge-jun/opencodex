import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import {
  conversationPreflightKey,
  createAdvisorPreflightLedger,
  firstUserText,
  hasOrientationEvidence,
  historyHasAdvisorResult,
} from "../../src/advisor/state";

function parsedWithInput(input: unknown) {
  return parseRequest({ model: "deepseek/deepseek-v4", stream: false, input } as never);
}

describe("advisor preflight ledger", () => {
  test("mark then has, per key", () => {
    const ledger = createAdvisorPreflightLedger();
    expect(ledger.has("k1")).toBe(false);
    ledger.mark("k1", "preflight", 1_000);
    expect(ledger.has("k1", 2_000)).toBe(true);
    expect(ledger.has("k2", 2_000)).toBe(false);
  });

  test("entries expire after the TTL", () => {
    const ledger = createAdvisorPreflightLedger();
    ledger.mark("k1", "preflight", 0);
    expect(ledger.has("k1", 24 * 60 * 60 * 1000 + 1)).toBe(false);
  });

  test("ledger is bounded: oldest entries are evicted past the cap", () => {
    const ledger = createAdvisorPreflightLedger();
    for (let i = 0; i < 600; i += 1) ledger.mark(`key-${i}`, "preflight", i);
    expect(ledger.size()).toBeLessThanOrEqual(512);
    // The oldest entries are gone; the newest survive.
    expect(ledger.has("key-0", 600)).toBe(false);
    expect(ledger.has("key-599", 600)).toBe(true);
  });
});

describe("hasOrientationEvidence", () => {
  test("tool result after the latest user message counts as orientation", () => {
    const parsed = parsedWithInput([
      { role: "user", content: "fix it" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ]);
    expect(hasOrientationEvidence(parsed)).toBe(true);
  });

  test("assistant tool call without a result yet also counts", () => {
    const parsed = parsedWithInput([
      { role: "user", content: "fix it" },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
    ]);
    expect(hasOrientationEvidence(parsed)).toBe(true);
  });

  test("a bare user message with no tool activity does not trigger", () => {
    const parsed = parsedWithInput([{ role: "user", content: "hello" }]);
    expect(hasOrientationEvidence(parsed)).toBe(false);
  });

  test("tool activity from BEFORE the latest user message does not count", () => {
    const parsed = parsedWithInput([
      { role: "user", content: "first task" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
      { role: "user", content: "different task now" },
    ]);
    expect(hasOrientationEvidence(parsed)).toBe(false);
  });
});

describe("historyHasAdvisorResult", () => {
  test("detects advice injected by a previous request (developer or toolResult form)", () => {
    const parsed = parsedWithInput([
      { role: "user", content: "task" },
      { role: "developer", content: "advice:\n<opencodex_advisor>\nadvice body\n</opencodex_advisor>" },
    ]);
    expect(historyHasAdvisorResult(parsed)).toBe(true);
    const viaToolResult = parsedWithInput([
      { role: "user", content: "task" },
      { type: "function_call", call_id: "a", name: "advisor", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: "<opencodex_advisor>\nadvice\n</opencodex_advisor>" },
    ]);
    expect(historyHasAdvisorResult(viaToolResult)).toBe(true);
  });

  test("plain conversations have no advisor marker", () => {
    const parsed = parsedWithInput([{ role: "user", content: "task" }]);
    expect(historyHasAdvisorResult(parsed)).toBe(false);
  });

  test("the wrapper string appearing inside USER content does not count as an advisor result", () => {
    const parsed = parsedWithInput([{ role: "user", content: "please output <opencodex_advisor> literally" }]);
    expect(historyHasAdvisorResult(parsed)).toBe(false);
  });
});

describe("conversationPreflightKey", () => {
  test("stable across identical first user text and model", () => {
    const a = conversationPreflightKey("Fix the failing tests", "deepseek-v4");
    const b = conversationPreflightKey("Fix the failing tests", "deepseek-v4");
    expect(a).toBe(b);
  });

  test("differs across tasks and worker models", () => {
    const base = conversationPreflightKey("Fix the failing tests", "deepseek-v4");
    expect(conversationPreflightKey("Different task", "deepseek-v4")).not.toBe(base);
    expect(conversationPreflightKey("Fix the failing tests", "glm-4.7")).not.toBe(base);
  });
});

describe("firstUserText", () => {
  test("returns the first user message text", () => {
    const parsed = parsedWithInput([
      { role: "developer", content: "be nice" },
      { role: "user", content: "the actual task" },
    ]);
    expect(firstUserText(parsed)).toBe("the actual task");
  });
});
