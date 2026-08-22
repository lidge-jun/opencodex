import { describe, expect, test } from "bun:test";
import { anthropicToolCallId, createToolCallIdAllocator, MAX_TOOL_CALL_ID_LENGTH } from "../src/adapters/tool-call-id";

// #1767: Anthropic validates tool_use.id against [a-zA-Z0-9_-]. A history replayed from another
// provider path can carry ids that do not conform, and one of them anywhere in the transcript
// fails the whole request with a 400.
describe("anthropicToolCallId", () => {
  test("leaves a conforming id untouched", () => {
    expect(anthropicToolCallId("call_5sNzuhhhfcuN91ysezpcwXjp")).toBe("call_5sNzuhhhfcuN91ysezpcwXjp");
    expect(anthropicToolCallId("call-9f1c2d3e-4")).toBe("call-9f1c2d3e-4");
    expect(anthropicToolCallId("toolu_01A2b3C4")).toBe("toolu_01A2b3C4");
  });

  test("rewrites the composite id from the report", () => {
    const raw = "call_5sNzuhhhfcuN91ysezpcwXjp\nfc_0c71abbccafaad67016a803ba3007487d2afa509a7ca8c9687";
    const out = anthropicToolCallId(raw)!;

    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(out).not.toContain("\n");
    expect(out.startsWith("call_5sNzuhhhfcuN91ysezpcwXjp_fc_")).toBe(true);
  });

  test("is deterministic, so a call and its result still pair up", () => {
    const raw = "call:a/b c";
    expect(anthropicToolCallId(raw)).toBe(anthropicToolCallId(raw));
  });

  test("keeps distinct raw ids distinct after rewriting", () => {
    // Without the hash suffix both of these would collapse to "call_a".
    const a = anthropicToolCallId("call:a");
    const b = anthropicToolCallId("call/a");

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(b).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  test("returns undefined for an empty id so the caller can omit the field", () => {
    expect(anthropicToolCallId("")).toBeUndefined();
    expect(anthropicToolCallId(undefined)).toBeUndefined();
  });
});

describe("createToolCallIdAllocator", () => {
  test("is injective where the stateless transform is not", () => {
    // `call:a` normalizes to `call_a_<hash>`. A raw id already equal to that value conforms and
    // passes through untouched, so the stateless helper maps two distinct sources onto one id.
    const collidingId = anthropicToolCallId("call:a")!;
    expect(anthropicToolCallId(collidingId)).toBe(collidingId);

    const allocator = createToolCallIdAllocator();
    allocator.reserve(collidingId);
    const rewritten = allocator.allocate("call:a");
    const conforming = allocator.allocate(collidingId);

    expect(rewritten).toBeDefined();
    expect(conforming).toBe(collidingId);
    expect(rewritten).not.toBe(conforming);
  });

  test("is stable, so a result reuses its call's wire id", () => {
    const allocator = createToolCallIdAllocator();
    const first = allocator.allocate("call:a");
    expect(allocator.allocate("call:a")).toBe(first);
    expect(allocator.lookup("call:a")).toBe(first);
  });

  test("lookup never mints an id", () => {
    const allocator = createToolCallIdAllocator();
    expect(allocator.lookup("call:a")).toBeUndefined();
  });

  test("returns undefined for an empty id instead of an unusable value", () => {
    const allocator = createToolCallIdAllocator();
    expect(allocator.allocate("")).toBeUndefined();
    expect(allocator.allocate(undefined)).toBeUndefined();
  });

  test("keeps every candidate within the Anthropic length bound", () => {
    const allocator = createToolCallIdAllocator();
    const long = "x".repeat(MAX_TOOL_CALL_ID_LENGTH * 2) + ":";
    const first = allocator.allocate(long)!;
    expect(first.length).toBeLessThanOrEqual(MAX_TOOL_CALL_ID_LENGTH);

    // Force the collision branch: the disambiguating suffix must fit inside the bound too.
    const second = allocator.allocate(long.slice(0, -1) + "/")!;
    expect(second.length).toBeLessThanOrEqual(MAX_TOOL_CALL_ID_LENGTH);
    expect(second).not.toBe(first);
  });

  test("an over-length character-valid id is rewritten, not reserved verbatim", () => {
    const allocator = createToolCallIdAllocator();
    const long = "c".repeat(MAX_TOOL_CALL_ID_LENGTH + 10);
    allocator.reserve(long);
    const wire = allocator.allocate(long)!;
    expect(wire).not.toBe(long);
    expect(wire.length).toBeLessThanOrEqual(MAX_TOOL_CALL_ID_LENGTH);
  });
});
