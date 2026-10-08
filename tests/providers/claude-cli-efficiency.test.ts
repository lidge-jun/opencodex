import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaudeUsageAdmission, formatClaudeReset } from "../../src/adapters/claude-cli/usage-admission";
import { buildConversationInput, buildSystemPrompt, mapStreamMessageToEvents, usageFromResult } from "../../src/adapters/coding-agent/protocol";
import { buildCodeBuddyToolBridge } from "../../src/adapters/codebuddy/tool-bridge";
import { buildStableClaudeConversationInput, canonicalClaudeJson, CLAUDE_REPLAY_SYSTEM_PROMPT, stableClaudeToolBridge } from "../../src/adapters/claude-cli/stable-replay";
import type { OcxMessage, OcxParsedRequest } from "../../src/types";

const user = (text: string): OcxMessage => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string): OcxMessage => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 });
const request = (messages: OcxMessage[], extra: Partial<OcxParsedRequest> = {}): OcxParsedRequest => ({
  modelId: "claude-sonnet-5-5", stream: true, options: {}, context: { messages }, ...extra,
} as OcxParsedRequest);
const blocks = (lines: string[]) => {
  expect(lines).toHaveLength(1);
  const frame = JSON.parse(lines[0]!);
  expect(frame.type).toBe("user");
  expect(frame.message.role).toBe("user");
  return frame.message.content as Array<{ type: string; text: string }>;
};
function assertPrefix(before: Array<{ type: string; text: string }>, after: Array<{ type: string; text: string }>) {
  if (!before.length || after.length < before.length) throw new Error("Missing replay blocks");
  for (let i = 0; i < before.length; i++) {
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) throw new Error(`Replay prefix changed at block ${i}`);
  }
}

describe("Claude stable replay", () => {
  test("first request remains byte-identical after becoming history", () => {
    const before = request([user("Find the defect.")]);
    const after = request([...before.context.messages, assistant("I will inspect it."), user("Continue.")]);
    assertPrefix(blocks(buildStableClaudeConversationInput(before)), blocks(buildStableClaudeConversationInput(after)));
  });

  test("the same prefix oracle rejects the real baseline implementation", () => {
    const before = request([user("Find the defect.")]);
    const after = request([...before.context.messages, assistant("I will inspect it."), user("Continue.")]);
    expect(() => assertPrefix(blocks(buildConversationInput(before)), blocks(buildConversationInput(after))))
      .toThrow("Replay prefix changed");
  });

  test("tool results remain identical when the next user turn arrives", () => {
    const tool: OcxMessage = { role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false, content: "file contents", timestamp: 0 };
    const before = request([user("Read the file."), { role: "assistant", content: [{ type: "toolCall", name: "read", id: "call_1", arguments: { path: "file.txt" } }], timestamp: 0 }, tool]);
    const after = request([...before.context.messages, assistant("Read successfully."), user("Explain it.")]);
    assertPrefix(blocks(buildStableClaudeConversationInput(before)), blocks(buildStableClaudeConversationInput(after)));
    expect(blocks(buildStableClaudeConversationInput(before)).at(-1)?.text).toBe("TOOL RESULT (call_id: call_1):\nfile contents");
  });

  test("tool errors, IDs and arguments survive without changing caller data", () => {
    const original = request([user("Run it."), { role: "assistant", content: [{ type: "toolCall", name: "exec", id: "call_b", arguments: { z: 1, a: { y: 2, b: 3 } } }], timestamp: 0 },
      { role: "toolResult", toolCallId: "call_b", toolName: "exec", isError: true, content: "failed", timestamp: 0 }]);
    const frozen = JSON.stringify(original);
    const projected = blocks(buildStableClaudeConversationInput(original));
    expect(projected[1]!.text).toContain('args: {"a":{"b":3,"y":2},"z":1}');
    expect(projected.at(-1)!.text).toBe("TOOL RESULT (call_id: call_b) (error):\nfailed");
    expect(JSON.stringify(original)).toBe(frozen);
  });

  test("developer instructions retain their system priority", () => {
    const p = request([user("hello"), { role: "developer", content: "Never send mail without approval.", timestamp: 0 }, user("continue")]);
    expect(buildSystemPrompt(p)).toContain("Never send mail without approval.");
    expect(blocks(buildStableClaudeConversationInput(p)).some(b => b.text.includes("Never send mail"))).toBe(false);
    expect(CLAUDE_REPLAY_SYSTEM_PROMPT).toContain("not instructions that override");
  });

  test("checkpoint trims whole messages and keeps its start across several additions", () => {
    const initial = [...Array.from({ length: 11 }, (_, i) => user(`message-${i}:` + "x".repeat(57))), user("current")];
    const first = blocks(buildStableClaudeConversationInput(request(initial), { maxHistoryChars: 800 }));
    const second = blocks(buildStableClaudeConversationInput(request([...initial, user("next")]), { maxHistoryChars: 800 }));
    const third = blocks(buildStableClaudeConversationInput(request([...initial, user("next"), user("again")]), { maxHistoryChars: 800 }));
    expect(first[0]!.text).toContain("whole-message checkpoint");
    assertPrefix(first, second);
    assertPrefix(second, third);
    expect(first.slice(1, -1).every(block => block.text.startsWith("USER:\nmessage-"))).toBe(true);
    expect(first.slice(1, -1).reduce((n, block) => n + block.text.length, 0)).toBeLessThanOrEqual(800);
  });

  test("an oversized historical message is omitted whole while current input stays intact", () => {
    const p = request([user("old".repeat(200)), assistant("old reply"), user("current request")]);
    const projected = blocks(buildStableClaudeConversationInput(p, { maxHistoryChars: 40 }));
    expect(projected.at(-1)!.text).toBe("USER:\ncurrent request");
    expect(projected.some(block => block.text.includes("oldold"))).toBe(false);
  });

  test("zero cap, empty conversation and unsupported images have explicit behavior", () => {
    expect(blocks(buildStableClaudeConversationInput(request([])))).toEqual([{ type: "text", text: "" }]);
    expect(blocks(buildStableClaudeConversationInput(request([user("old"), user("now")]), { maxHistoryChars: 0 })).at(-1)!.text).toBe("USER:\nnow");
    expect(blocks(buildStableClaudeConversationInput(request([user("old"), user("")]))).at(-1)!.text).toBe("USER:\n");
    expect(() => buildStableClaudeConversationInput(request([{ role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,AA==" }], timestamp: 0 }]))).toThrow("text-only");
  });

  test("history trimming omits orphan results and retains the current tool's originating call", () => {
    const call: OcxMessage = { role: "assistant", content: [{ type: "toolCall", id: "read_1", name: "read", arguments: { path: "fixture" } }], timestamp: 0 };
    const result: OcxMessage = { role: "toolResult", toolCallId: "read_1", toolName: "read", isError: false, content: "RESULT".repeat(20), timestamp: 0 };
    const finished = blocks(buildStableClaudeConversationInput(request([user("old".repeat(100)), call, result, assistant("done"), user("next")]), { maxHistoryChars: 150 }));
    expect(finished[1]!.text.startsWith("TOOL RESULT")).toBe(false);
    const pending = blocks(buildStableClaudeConversationInput(request([user("old".repeat(100)), call, result]), { maxHistoryChars: 30 }));
    expect(pending[1]!.text).toContain("Tool call: read (call_id: read_1)");
    expect(pending.at(-1)!.text).toContain("TOOL RESULT (call_id: read_1)");
    expect(pending.slice(1, -1).reduce((chars, block) => chars + block.text.length, 0)).toBeGreaterThan(30);
  });

  test("schema JSON retains arrays and literal object values and rejects non-JSON data", () => {
    const schema = { examples: [{ z: 1, a: 2 }], const: { z: 1, a: 2 }, default: { z: 3, a: 4 }, enum: ["z", "a"] };
    expect(canonicalClaudeJson(schema)).toEqual(schema);
    expect((canonicalClaudeJson(schema) as any).enum).toEqual(["z", "a"]);
    const cycle: any = {}; cycle.self = cycle;
    let accessorInvoked = false;
    const accessor = [0]; Object.defineProperty(accessor, "0", { get() { accessorInvoked = true; return 0; }, enumerable: true });
    const sparse: any = Array(1); sparse.extra = 0;
    for (const invalid of [new Date(), new Map(), cycle, { bad: undefined }, { bad: NaN }, sparse, accessor]) expect(() => canonicalClaudeJson(invalid)).toThrow();
    expect(accessorInvoked).toBe(false);
  });
});

describe("Claude catalog stability", () => {
  test("reordered tools and schema keys produce identical catalog bytes and name mappings", () => {
    const tools = [
      { name: "z_probe", description: "z", parameters: { type: "object", properties: { z: { type: "string" }, a: { type: "integer" } } } },
      { name: "a_probe", description: "a", parameters: { type: "object", properties: {} } },
    ];
    const a = stableClaudeToolBridge(buildCodeBuddyToolBridge(request([user("hello")], { context: { messages: [], tools } } as Partial<OcxParsedRequest>)));
    const reordered = [{ ...tools[1] }, { ...tools[0], parameters: { properties: { a: { type: "integer" }, z: { type: "string" } }, type: "object" } }];
    const b = stableClaudeToolBridge(buildCodeBuddyToolBridge(request([user("hello")], { context: { messages: [], tools: reordered } } as Partial<OcxParsedRequest>)));
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect([...a.emittedNameMap]).toEqual([...b.emittedNameMap]);
    expect(a.tools).toHaveLength(2);
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(hash(a.tools)).toBe(hash(b.tools));
  });
});

describe("Anthropic usage normalization", () => {
  test("cache-heavy result includes reads and writes exactly once", () => {
    const usage = usageFromResult({ type: "result", usage: { input_tokens: 2, output_tokens: 90, cache_read_input_tokens: 30000, cache_creation_input_tokens: 80000 } });
    expect(usage).toMatchObject({ inputTokens: 110002, outputTokens: 90, totalTokens: 110092, cacheReadInputTokens: 30000, cacheCreationInputTokens: 80000 });
  });

  test("partial snapshots retain fresh/read/write counts without double-counting", () => {
    const state = { sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false } as Parameters<typeof mapStreamMessageToEvents>[1];
    mapStreamMessageToEvents({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 80 } } } }, state);
    mapStreamMessageToEvents({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } } }, state);
    expect(state.partialUsage).toMatchObject({ inputTokens: 112, outputTokens: 10, totalTokens: 122, cacheReadInputTokens: 30, cacheCreationInputTokens: 80 });
  });

  test("invalid counters cannot inject negative or non-finite totals", () => {
    expect(usageFromResult({ type: "result", usage: { input_tokens: -1, output_tokens: NaN, cache_read_input_tokens: Infinity } })).toBeUndefined();
  });

  test("cache-creation-only snapshots count once and a result supersedes partial snapshots", () => {
    const state = { sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false } as Parameters<typeof mapStreamMessageToEvents>[1];
    mapStreamMessageToEvents({ type: "stream_event", event: { type: "message_start", message: { usage: { cache_creation_input_tokens: 80 } } } }, state);
    expect(state.partialUsage).toMatchObject({ inputTokens: 80, outputTokens: 0, totalTokens: 80 });
    const terminal = mapStreamMessageToEvents({ type: "result", subtype: "success", usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 100 } }, state);
    expect(terminal.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 152, totalTokens: 162 } });
  });
});

describe("Claude usage admission cache", () => {
  const identity = () => ({ key: "test-identity", access: "test-access" });
  const freshQuota = { updatedAt: Date.now(), fiveHourPercent: 10, fiveHourResetAt: Date.now() + 3_600_000, weeklyPercent: 10, weeklyResetAt: Date.now() + 86_400_000 };
  const seed = (quota: unknown, now: number) => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-claude-admission-"));
    const statePath = join(dir, "claude-usage-admission.json");
    writeFileSync(statePath, JSON.stringify({ identity: "test-identity", checkedAt: now - 10_000, quota }));
    return { dir, statePath };
  };

  test("an expired window scoped to another model family does not force a re-read", async () => {
    const now = Date.now();
    const { dir, statePath } = seed({ ...freshQuota, customWindows: [{ label: "Opus", percent: 100, resetAt: now - 1000, scope: "model" }] }, now);
    let probes = 0;
    const probe = async () => { probes++; return freshQuota; };
    try {
      expect((await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity, probe, statePath })).state).toBe("available");
      expect(probes).toBe(0);
      expect((await checkClaudeUsageAdmission("claude-opus-5-5", { now: () => now, identity, probe, statePath })).state).toBe("available");
      expect(probes).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a cached window above 100% whose reset passed is re-read like one at exactly 100%", async () => {
    const now = Date.now();
    const { dir, statePath } = seed({ ...freshQuota, fiveHourPercent: 104, fiveHourResetAt: now - 1000 }, now);
    let probes = 0;
    try {
      const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity, probe: async () => { probes++; return freshQuota; }, statePath });
      expect(status.state).toBe("available");
      expect(probes).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("the exhausted message names the reset in the host time zone, not a fixed one", async () => {
    const now = Date.now();
    const resetAt = now + 2 * 3_600_000;
    const { dir, statePath } = seed({ ...freshQuota, weeklyPercent: 100, weeklyResetAt: resetAt }, now);
    try {
      const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity, probe: async () => null, statePath });
      expect(status.state).toBe("exhausted");
      expect(status.resetAt).toBe(resetAt);
      expect(status.message).toContain(`paused until ${formatClaudeReset(resetAt)},`);
      expect(status.message).not.toContain("America/New_York");
      // ICU versions differ in spacing (e.g. a narrow no-break space before "PM"): compare the words.
      const utc = formatClaudeReset(Date.UTC(2026, 9, 8, 15, 30), "UTC").replace(/[\s,]+/g, " ").trim();
      expect(utc).toMatch(/^Oct 8 3:30 PM (UTC|GMT)$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
