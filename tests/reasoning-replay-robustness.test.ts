import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import {
  clearReasoningReplayCacheForTests,
  peekReasoningForCall,
  rememberReasoningForCall,
} from "../src/responses/reasoning-replay-cache";
import type { AdapterEvent, OcxReasoningReplayScopeRef } from "../src/types";

const REASONING = "I need to inspect files before answering.";
const SCOPE: OcxReasoningReplayScopeRef = {
  clientThreadId: "thread-empty-delta",
  current: {
    providerName: "opencode-free",
    providerDestinationIdentity: "destination:provider",
    adapterName: "openai-chat",
    modelId: "deepseek-v4-flash-free",
    credentialIdentity: "key:test",
  },
};

function reasoningToolRound(intervening: AdapterEvent): AdapterEvent[] {
  return [
    { type: "reasoning_raw_delta", text: REASONING },
    intervening,
    { type: "tool_call_start", id: "call_empty_delta", name: "read_file" },
    { type: "tool_call_delta", arguments: '{"path":"README.md"}' },
    { type: "tool_call_end" },
    { type: "done" },
  ];
}

async function consumeStreaming(events: AdapterEvent[]): Promise<void> {
  async function* replay(): AsyncGenerator<AdapterEvent> {
    yield* events;
  }
  const reader = bridgeToResponsesSSE(
    replay(),
    "opencode-free/deepseek-v4-flash-free",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { replayCacheScope: SCOPE },
  ).getReader();
  while (!(await reader.read()).done) {
    // Drain the response so the bridge closes and records the replay candidate.
  }
}

describe("reasoning replay empty-delta robustness", () => {
  beforeEach(() => {
    clearReasoningReplayCacheForTests();
  });

  afterEach(() => {
    clearReasoningReplayCacheForTests();
  });

  test("an empty cache update does not replace an existing replay candidate", () => {
    rememberReasoningForCall("call_cache", REASONING, SCOPE);
    rememberReasoningForCall("call_cache", "", SCOPE);

    expect(peekReasoningForCall("call_cache", SCOPE)).toBe(REASONING);
  });

  test("batch: an empty thinking delta preserves reasoning for the following tool call", () => {
    buildResponseJSON(
      reasoningToolRound({ type: "thinking_delta", thinking: "" }),
      "opencode-free/deepseek-v4-flash-free",
      { replayCacheScope: SCOPE },
    );

    expect(peekReasoningForCall("call_empty_delta", SCOPE)).toBe(REASONING);
  });

  test("stream: an empty thinking delta preserves reasoning for the following tool call", async () => {
    await consumeStreaming(reasoningToolRound({ type: "thinking_delta", thinking: "" }));

    expect(peekReasoningForCall("call_empty_delta", SCOPE)).toBe(REASONING);
  });

  test("non-empty thinking still consumes the pending raw-reasoning candidate", () => {
    buildResponseJSON(
      reasoningToolRound({ type: "thinking_delta", thinking: "A visible summary." }),
      "opencode-free/deepseek-v4-flash-free",
      { replayCacheScope: SCOPE },
    );

    expect(peekReasoningForCall("call_empty_delta", SCOPE)).toBeUndefined();
  });

  test("the memory-only cache writes no reasoning state to disk even when persistence env vars are set", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ocx-reasoning-memory-only-"));
    const spill = join(scratch, "must-not-exist.json");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../src/responses/reasoning-replay-cache.ts")).href;
    const script = [
      `const cache = await import(${JSON.stringify(moduleUrl)});`,
      `const scope = {clientThreadId:"disk-guard",current:{providerName:"test",providerDestinationIdentity:"destination:test",adapterName:"openai-chat",modelId:"model",credentialIdentity:"key:test"}};`,
      `cache.rememberReasoningForCall("call_disk_guard", ${JSON.stringify(REASONING)}, scope);`,
    ].join("\n");

    try {
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: scratch,
        env: {
          ...process.env,
          OPENCODEX_HOME: scratch,
          OPENCODEX_REASONING_REPLAY_PERSIST: "1",
          OPENCODEX_REASONING_REPLAY_FILE: spill,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();

      expect(exitCode, stderr).toBe(0);
      expect(existsSync(spill)).toBe(false);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
