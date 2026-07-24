import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

// 260718 dangling tool_calls hardening (devlog/_plan/260718_dangling_toolcall_hardening):
// strict chat providers (Kimi/Moonshot) 400 unless every assistant tool_call is answered
// immediately by role:"tool" messages. These tests drive the repair branches for real
// (defer + reattach + last-resort synthesize) and assert the wire-level invariants.

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
};

interface ChatMsg {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function wire(messages: OcxMessage[]): ChatMsg[] {
  const parsed: OcxParsedRequest = {
    modelId: "test-model",
    context: { messages },
    stream: false,
    options: {},
  };
  const req = createOpenAIChatAdapter(provider).buildRequest(parsed) as { body: string };
  return (JSON.parse(req.body) as { messages: ChatMsg[] }).messages;
}

function user(text: string): OcxMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function developer(text: string): OcxMessage {
  return { role: "developer", content: text, timestamp: 0 };
}

function assistantWithCalls(calls: { id: string; name: string }[], text = ""): OcxMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map(c => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: {} })),
    ],
    timestamp: 0,
  };
}

function toolResult(callId: string, name: string, output = "ok"): OcxMessage {
  return { role: "toolResult", toolCallId: callId, toolName: name, content: output, isError: false, timestamp: 0 };
}

/** Wire invariant (T9): every assistant tool_call block is answered immediately and
 *  completely; no tool message exists outside such a block; no generated id collides. */
function assertWireInvariants(messages: ChatMsg[]): void {
  const seenIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") {
      // must belong to the immediately preceding assistant block
      let j = i - 1;
      while (j >= 0 && messages[j].role === "tool") j--;
      expect(j).toBeGreaterThanOrEqual(0);
      expect(messages[j].role).toBe("assistant");
      const ids = (messages[j].tool_calls ?? []).map(tc => tc.id);
      expect(ids).toContain(m.tool_call_id);
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const ids = m.tool_calls.map(tc => tc.id);
      for (const id of ids) {
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(0);
        expect(seenIds.has(id)).toBe(false);
        seenIds.add(id);
      }
      // exactly the next ids.length messages must be tool answers with the same multiset
      const answers = messages.slice(i + 1, i + 1 + ids.length);
      expect(answers.every(a => a.role === "tool")).toBe(true);
      expect(answers.map(a => a.tool_call_id).sort()).toEqual([...ids].sort());
      // no other role inside the block
      const barrier = messages[i + 1 + ids.length];
      if (barrier) expect(barrier.role).not.toBe("tool");
    }
  }
}

describe("openai-chat dangling tool_calls hardening", () => {
  test("T1 incident: developer guidance is hoisted while the real result reattaches to the original call", () => {
    const messages = wire([
      user("hi"),
      assistantWithCalls([{ id: "call_x", name: "request_user_input" }]),
      developer("[injected guidance]"),
      toolResult("call_x", "request_user_input", '{"answers":{}}'),
      user("next"),
    ]);
    assertWireInvariants(messages);
    const roles = messages.map(m => m.role);
    expect(messages[0]).toEqual({ role: "system", content: "[injected guidance]" });
    // canonical history order: assistant, tool(real), user; no in-history system barrier
    const aIdx = roles.indexOf("assistant");
    expect(roles[aIdx + 1]).toBe("tool");
    expect(messages[aIdx + 1].tool_call_id).toBe("call_x");
    expect(messages[aIdx + 1].content).toBe('{"answers":{}}');
    expect(roles[aIdx + 2]).toBe("user");
    expect(messages.slice(1).some(m => m.role === "system")).toBe(false);
    // no synthetic result fabricated for an answered call
    expect(messages.some(m => typeof m.content === "string" && m.content.includes("no tool result was recorded"))).toBe(false);
  });

  test("T2 trailing dangle: unanswered call closes with a synthetic result at the end", () => {
    const messages = wire([
      user("hi"),
      assistantWithCalls([{ id: "call_t", name: "exec_command" }]),
    ]);
    assertWireInvariants(messages);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("tool");
    expect(last.tool_call_id).toBe("call_t");
    expect(String(last.content)).toContain("no tool result was recorded");
    expect(String(last.content)).toContain("exec_command");
    expect(String(last.content)).not.toContain("interrupted");
  });

  test("T3 normal pairing stays untouched (no synthetic messages)", () => {
    const messages = wire([
      user("hi"),
      assistantWithCalls([{ id: "call_a", name: "exec_command" }], "running"),
      toolResult("call_a", "exec_command"),
      assistantWithCalls([], "done"),
    ]);
    assertWireInvariants(messages);
    expect(messages.filter(m => m.role === "tool")).toHaveLength(1);
    expect(messages.some(m => String(m.content).includes("no tool result was recorded"))).toBe(false);
  });

  test("T4 orphan result with no call anywhere keeps the fake-assistant repair", () => {
    const messages = wire([
      user("hi"),
      toolResult("call_ghost", "exec_command"),
    ]);
    assertWireInvariants(messages);
    const aIdx = messages.findIndex(m => m.role === "assistant");
    expect(messages[aIdx].tool_calls?.[0].id).toBe("call_ghost");
    expect(messages[aIdx + 1].role).toBe("tool");
    expect(messages[aIdx + 1].tool_call_id).toBe("call_ghost");
  });

  test("T5 parallel calls with partial results: matched attach, remainder synthesized at round close", () => {
    const messages = wire([
      user("hi"),
      assistantWithCalls([{ id: "call_1", name: "exec_command" }, { id: "call_2", name: "view_image" }]),
      toolResult("call_2", "view_image", "img-ok"),
      developer("barrier while call_1 pending"),
      assistantWithCalls([], "next turn"),
    ]);
    assertWireInvariants(messages);
    const aIdx = messages.findIndex(m => m.role === "assistant");
    const block = messages.slice(aIdx + 1, aIdx + 3);
    expect(block.map(m => m.tool_call_id).sort()).toEqual(["call_1", "call_2"]);
    const synth = block.find(m => m.tool_call_id === "call_1");
    expect(String(synth?.content)).toContain("no tool result was recorded");
    const real = block.find(m => m.tool_call_id === "call_2");
    expect(real?.content).toBe("img-ok");
    expect(messages[0]).toEqual({ role: "system", content: "barrier while call_1 pending" });
    expect(messages[aIdx + 3].role).toBe("assistant");
    expect(messages.slice(1).some(m => m.role === "system")).toBe(false);
  });

  test("T6 mismatched result while calls pending: round closes synthetically, then orphan pair", () => {
    const messages = wire([
      user("hi"),
      assistantWithCalls([{ id: "call_p", name: "exec_command" }]),
      developer("deferred barrier"),
      toolResult("call_unknown", "exec_command", "mystery"),
    ]);
    assertWireInvariants(messages);
    const aIdx = messages.findIndex(m => m.role === "assistant");
    expect(messages[aIdx + 1].role).toBe("tool");
    expect(messages[aIdx + 1].tool_call_id).toBe("call_p");
    expect(String(messages[aIdx + 1].content)).toContain("no tool result was recorded");
    expect(messages[0]).toEqual({ role: "system", content: "deferred barrier" });
    expect(messages[aIdx + 2].role).toBe("assistant");
    expect(messages.slice(1).some(m => m.role === "system")).toBe(false);
    const orphanIdx = messages.findIndex((m, i) => i > aIdx && m.role === "assistant");
    expect(messages[orphanIdx].tool_calls?.[0].id).toBe("call_unknown");
    expect(messages[orphanIdx + 1].tool_call_id).toBe("call_unknown");
  });

  test("T7 consecutive assistants: first round is synthesized shut before the next assistant", () => {
    const messages = wire([
      user("hi"),
      assistantWithCalls([{ id: "call_c", name: "exec_command" }]),
      assistantWithCalls([], "plain text"),
    ]);
    assertWireInvariants(messages);
    expect(messages[2].role).toBe("tool");
    expect(messages[2].tool_call_id).toBe("call_c");
    expect(messages[3].role).toBe("assistant");
  });

  test("T8 empty call id is minted so the call can be answered", () => {
    const messages = wire([
      user("hi"),
      assistantWithCalls([{ id: "", name: "exec_command" }]),
    ]);
    assertWireInvariants(messages);
    const aIdx = messages.findIndex(m => m.role === "assistant");
    const minted = messages[aIdx].tool_calls?.[0].id ?? "";
    expect(minted).toMatch(/^call_ocx_minted_\d+$/);
    expect(messages[aIdx + 1].tool_call_id).toBe(minted);
  });

  test("T10 synthetic wording states unknown execution status without claiming interruption", () => {
    const messages = wire([
      user("hi"),
      assistantWithCalls([{ id: "call_w", name: "request_user_input" }]),
    ]);
    const synth = messages[messages.length - 1];
    const text = String(synth.content);
    expect(text).toContain("no tool result was recorded");
    expect(text).toContain("execution status unknown");
    expect(text).toContain("user-provided input");
    expect(text).not.toContain("interrupted");
  });
});
