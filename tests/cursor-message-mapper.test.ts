import { describe, expect, test } from "bun:test";
import { createCursorKvStore } from "../src/adapters/cursor/kv-store";
import { mapCursorServerMessage } from "../src/adapters/cursor/message-mapper";
import type { CursorClientMessage } from "../src/adapters/cursor/types";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("Cursor message mapper", () => {
  test("maps text, thinking, done, and error messages to AdapterEvents", () => {
    const writes: CursorClientMessage[] = [];
    const state = { kv: createCursorKvStore(), writeClient: (message: CursorClientMessage) => writes.push(message) };

    expect(mapCursorServerMessage({ type: "text", text: "hello" }, state)).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(mapCursorServerMessage({ type: "thinking", thinking: "hmm" }, state)).toEqual([{ type: "thinking_delta", thinking: "hmm" }]);
    expect(mapCursorServerMessage({ type: "done" }, state)).toEqual([{ type: "done", usage: undefined }]);
    expect(mapCursorServerMessage({ type: "error", message: "bad" }, state)).toEqual([{ type: "error", message: "bad" }]);
    expect(writes).toEqual([]);
  });

  test("handles KV get and set as internal client replies only", () => {
    const writes: CursorClientMessage[] = [];
    const kv = createCursorKvStore({ present: bytes(1, 2) });
    const state = { kv, writeClient: (message: CursorClientMessage) => writes.push(message) };

    expect(mapCursorServerMessage({ type: "kv_get", key: "present" }, state)).toEqual([]);
    expect(mapCursorServerMessage({ type: "kv_set", key: "next", value: bytes(3) }, state)).toEqual([]);
    expect(mapCursorServerMessage({ type: "kv_get", key: "next" }, state)).toEqual([]);

    expect(writes.map(message => message.type)).toEqual(["kv_value", "kv_stored", "kv_value"]);
    expect(writes[0]).toMatchObject({ type: "kv_value", key: "present" });
    expect(writes[1]).toEqual({ type: "kv_stored", key: "next" });
    expect(writes[2]).toMatchObject({ type: "kv_value", key: "next" });
  });

  test("maps tool call messages to AdapterEvents", () => {
    const writes: CursorClientMessage[] = [];
    const state = { kv: createCursorKvStore(), writeClient: (message: CursorClientMessage) => writes.push(message) };

    expect(mapCursorServerMessage({ type: "tool_call_start", id: "call_1", name: "read_file" }, state)).toEqual([
      { type: "tool_call_start", id: "call_1", name: "read_file" },
    ]);
    expect(mapCursorServerMessage({ type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" }, state)).toEqual([
      { type: "tool_call_delta", arguments: "{\"path\":\"a.txt\"}" },
    ]);
    expect(mapCursorServerMessage({ type: "tool_call_end", id: "call_1" }, state)).toEqual([
      { type: "tool_call_end" },
    ]);
    expect(writes).toEqual([]);
  });

  test("answers requestContextArgs and returns legacy mock placeholders for native tool cases", () => {
    const writes: CursorClientMessage[] = [];
    const state = { kv: createCursorKvStore(), writeClient: (message: CursorClientMessage) => writes.push(message) };

    expect(mapCursorServerMessage({ type: "exec", execCase: "requestContextArgs", requestId: "ctx" }, state)).toEqual([]);
    expect(mapCursorServerMessage({ type: "exec", execCase: "shellArgs", requestId: "shell" }, state)).toEqual([]);
    expect(mapCursorServerMessage({ type: "exec", execCase: "readArgs", requestId: "read" }, state)).toEqual([]);
    expect(mapCursorServerMessage({ type: "exec", execCase: "unknownExecCase", requestId: "unknown" }, state)).toEqual([]);

    expect(writes[0]).toEqual({
      type: "exec_result",
      requestId: "ctx",
      ok: true,
      message: "Cursor request context is empty in legacy mock transport mode.",
    });
    expect(writes.slice(1).every(message => message.type === "exec_result" && message.ok === false)).toBe(true);
    expect(writes[1]?.message).toContain("shellArgs");
    expect(writes[2]?.message).toContain("readArgs");
    expect(writes[3]?.message).toContain("unknownExecCase");
  });
});
