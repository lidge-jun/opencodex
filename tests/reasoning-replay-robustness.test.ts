import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { parseRequest } from "../src/responses/parser";
import {
  clearReasoningReplayCacheForTests,
  flushReasoningReplayCache,
  getReasoningReplayStats,
  peekReasoningForCall,
  recordBareToolCallSerialization,
  rememberReasoningForCall,
  setReasoningReplayPersistenceForTests,
} from "../src/responses/reasoning-replay-cache";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

/**
 * Robustness + privacy coverage for issue #950's enhancement checklist:
 * restart-safe (opt-in disk spill), counter-only diagnostics, and the
 * bare tool-call serialization invariant.
 */

const MODEL = "opencode-go/deepseek-v4-flash";
const REASONING = "I need to inspect files before answering.";

function configFor(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "key",
        models: ["deepseek-v4-flash"],
      },
    },
  };
}

function wireFor(input: unknown[]): { messages: Array<Record<string, unknown>> } {
  const parsed = parseRequest({ model: MODEL, input, stream: true });
  const route = routeModel(configFor(), parsed.modelId);
  parsed.modelId = route.modelId;
  const req = createOpenAIChatAdapter(route.provider).buildRequest(parsed as OcxParsedRequest);
  return JSON.parse(req.body as string) as { messages: Array<Record<string, unknown>> };
}

const userMessage = () => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "inspect the repo" }],
});

const functionCallItem = () => ({
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "read_file",
  arguments: '{"path":"README.md"}',
});

const functionCallOutputItem = () => ({
  type: "function_call_output",
  call_id: "call_1",
  output: "contents",
});

let spillDir = "";
let spillFile = "";

beforeAll(() => {
  spillDir = mkdtempSync(join(tmpdir(), "ocx-reasoning-replay-"));
  spillFile = join(spillDir, "reasoning-replay-cache.json");
});

afterAll(() => {
  setReasoningReplayPersistenceForTests(false);
  clearReasoningReplayCacheForTests();
  rmSync(spillDir, { recursive: true, force: true });
});

afterEach(() => {
  setReasoningReplayPersistenceForTests(false);
  clearReasoningReplayCacheForTests();
  rmSync(spillFile, { force: true });
});

describe("reasoning replay — opt-in disk spill", () => {
  test("round-trips reasoning across a simulated restart (memory cleared, file reloaded)", () => {
    setReasoningReplayPersistenceForTests(true, spillFile);
    rememberReasoningForCall("call_restart", REASONING, "thread-1");
    flushReasoningReplayCache();

    // Simulate a proxy restart: memory wiped, persistence re-enabled at boot.
    setReasoningReplayPersistenceForTests(false);
    clearReasoningReplayCacheForTests();
    setReasoningReplayPersistenceForTests(true, spillFile);

    expect(peekReasoningForCall("call_restart", "thread-1")).toBe(REASONING);
  });

  test("expired entries are not restored from the spill file", () => {
    let clock = 0;
    clearReasoningReplayCacheForTests(() => clock);
    setReasoningReplayPersistenceForTests(true, spillFile);
    rememberReasoningForCall("call_expired", REASONING, "thread-2");
    flushReasoningReplayCache();

    clock = 61 * 60 * 1000; // past the 60-minute TTL
    setReasoningReplayPersistenceForTests(false);
    clearReasoningReplayCacheForTests(() => clock);
    setReasoningReplayPersistenceForTests(true, spillFile);

    expect(peekReasoningForCall("call_expired", "thread-2")).toBeUndefined();
    expect(getReasoningReplayStats().entries).toBe(0);
  });

  test("corrupt or unreadable spill file loads as an empty cache without throwing", () => {
    writeFileSync(spillFile, "{not json!!", "utf8");
    setReasoningReplayPersistenceForTests(true, spillFile);
    expect(getReasoningReplayStats().entries).toBe(0);
    expect(peekReasoningForCall("anything", "thread-3")).toBeUndefined();
  });

  test("reload respects the entry-count cap", () => {
    setReasoningReplayPersistenceForTests(true, spillFile);
    for (let i = 0; i < 80; i++) {
      rememberReasoningForCall(`call_${i}`, "x", "thread-4");
    }
    flushReasoningReplayCache();

    setReasoningReplayPersistenceForTests(false);
    clearReasoningReplayCacheForTests();
    setReasoningReplayPersistenceForTests(true, spillFile);

    expect(getReasoningReplayStats().entries).toBeLessThanOrEqual(64);
  });
});

describe("reasoning replay — privacy-safe diagnostics", () => {
  test("stats expose counters and bounds, never reasoning text", () => {
    clearReasoningReplayCacheForTests();
    rememberReasoningForCall("call_stats", REASONING, "thread-5");
    expect(peekReasoningForCall("call_stats", "thread-5")).toBe(REASONING);
    expect(peekReasoningForCall("call_missing", "thread-5")).toBeUndefined();
    recordBareToolCallSerialization("deepseek-v4-flash");
    recordBareToolCallSerialization("deepseek-v4-flash");

    const stats = getReasoningReplayStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.bareSerializationsByModel["deepseek-v4-flash"]).toBe(2);
    expect(JSON.stringify(stats)).not.toContain(REASONING);
  });

  test("persistence stays off by default — no spill file is created", () => {
    const untouched = join(spillDir, "must-not-exist.json");
    setReasoningReplayPersistenceForTests(false, untouched);
    clearReasoningReplayCacheForTests();
    rememberReasoningForCall("call_default", REASONING, "thread-6");
    flushReasoningReplayCache();
    expect(getReasoningReplayStats().persistence.enabled).toBe(false);
    expect(existsSync(untouched)).toBe(false);
  });

  test("bare tool-call continuation increments the invariant counter (wire-level)", () => {
    clearReasoningReplayCacheForTests();
    const { messages } = wireFor([userMessage(), functionCallItem(), functionCallOutputItem()]);
    const assistant = messages.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(assistant).toBeDefined();
    // No reasoning anywhere, no cache entry: the serialization is bare, which
    // is exactly the 400 shape the invariant counter must surface.
    expect(assistant!["reasoning_content"]).toBeUndefined();
    expect(getReasoningReplayStats().bareSerializationsByModel["deepseek-v4-flash"]).toBe(1);
  });
});
