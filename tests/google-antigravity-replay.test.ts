import { afterEach, describe, expect, test } from "bun:test";
import {
  antigravityUsesReplayCache,
  applyAntigravityReplay,
  clearAntigravityReplay,
  observeAntigravityReplay,
  __resetAntigravityReplayCache,
} from "../src/adapters/google-antigravity-replay";
import { sanitizeAntigravityClaudeSignatures } from "../src/adapters/google-antigravity-wire";

afterEach(() => __resetAntigravityReplayCache());

const SIG = "sig-1234567890abcdef"; // >= 16 chars
const MODEL = "gemini-3-pro";
const SESSION = "-12345";

describe("antigravity reasoning-replay cache", () => {
  // Signatures are keyed by functionCall identity (name + args), so observe/apply use functionCall parts.
  const fcPart = (name: string, args: unknown, sig?: string, nested = false) => {
    const part: Record<string, unknown> = { functionCall: { name, args } };
    if (sig && nested) part.extra_content = { google: { thought_signature: sig } };
    else if (sig) part.thoughtSignature = sig;
    return part;
  };

  test("observe then apply re-injects the signature onto the matching functionCall part", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    const contents = [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] },
    ];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[1].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("ignores signatures shorter than the minimum length", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", {}, "short")]);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  test("does not clobber an existing signature on the outgoing part", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", {}, SIG)]);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} }, thoughtSignature: "existing-sig-abcdef" }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("existing-sig-abcdef");
  });

  test("reads the nested extra_content.google.thought_signature alias", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", {}, SIG, true)]);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("clear-on-invalid empties the entry", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", {}, SIG)]);
    clearAntigravityReplay(MODEL, SESSION);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  test("retains EVERY signature across a sequential tool loop (regression)", () => {
    // Step 1: FC1 returns sig A.
    observeAntigravityReplay(MODEL, SESSION, [fcPart("fc1", { i: 1 }, "sig-aaaaaaaaaaaaaaaa")]);
    // Step 2: FC2 returns sig B (different identity, same partIndex 0).
    observeAntigravityReplay(MODEL, SESSION, [fcPart("fc2", { i: 2 }, "sig-bbbbbbbbbbbbbbbb")]);
    // Next request history has both model turns; BOTH must get their own signature back.
    const contents = [
      { role: "model", parts: [{ functionCall: { name: "fc1", args: { i: 1 } } }] },
      { role: "user", parts: [{ text: "result1" }] },
      { role: "model", parts: [{ functionCall: { name: "fc2", args: { i: 2 } } }] },
    ];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-aaaaaaaaaaaaaaaa");
    expect((contents[2].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-bbbbbbbbbbbbbbbb");
  });

  test("nested arg objects do not collide on the identity key (regression)", () => {
    // Same tool name + same top-level key shape, but different NESTED values → distinct signatures.
    observeAntigravityReplay(MODEL, SESSION, [fcPart("edit", { outer: { x: 1, y: 2 }, z: 3 }, "sig-nested-aaaa0000")]);
    observeAntigravityReplay(MODEL, SESSION, [fcPart("edit", { outer: { x: 9, y: 8 }, z: 3 }, "sig-nested-bbbb1111")]);
    const contents = [
      { role: "model", parts: [{ functionCall: { name: "edit", args: { outer: { x: 1, y: 2 }, z: 3 } } }] },
      { role: "model", parts: [{ functionCall: { name: "edit", args: { outer: { x: 9, y: 8 }, z: 3 } } }] },
    ];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-nested-aaaa0000");
    expect((contents[1].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-nested-bbbb1111");
  });

  test("key is order-independent for nested object keys (observe vs history key order)", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("e", { a: { p: 1, q: 2 } }, "sig-orderindep00000")]);
    // History serializes the same args with a different key order.
    const contents = [{ role: "model", parts: [{ functionCall: { name: "e", args: { a: { q: 2, p: 1 } } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-orderindep00000");
  });

  test("claude models do not use the replay cache", () => {
    expect(antigravityUsesReplayCache("claude-opus-4.6")).toBe(false);
    expect(antigravityUsesReplayCache("gemini-3-pro")).toBe(true);
    observeAntigravityReplay("claude-opus-4.6", SESSION, [fcPart("get_x", {}, SIG)]);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityReplay("claude-opus-4.6", SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });
});

describe("claude-on-antigravity inline signature sanitization", () => {
  test("drops thinking blocks lacking a valid signature on model turns", () => {
    const contents = [
      { role: "model", parts: [{ thought: true, text: "no sig" }, { text: "answer" }] },
    ];
    sanitizeAntigravityClaudeSignatures(contents);
    expect(contents[0].parts).toHaveLength(1);
    expect((contents[0].parts[0] as { text?: string }).text).toBe("answer");
  });

  test("keeps thinking blocks that carry a signature", () => {
    const contents = [
      { role: "model", parts: [{ thought: true, text: "kept", thoughtSignature: SIG }] },
    ];
    sanitizeAntigravityClaudeSignatures(contents);
    expect(contents[0].parts).toHaveLength(1);
  });

  test("strips signature fields from non-model (user) parts", () => {
    const contents = [
      { role: "user", parts: [{ text: "hi", thoughtSignature: SIG, thought_signature: SIG }] },
    ];
    sanitizeAntigravityClaudeSignatures(contents);
    const part = contents[0].parts[0] as { thoughtSignature?: string; thought_signature?: string };
    expect(part.thoughtSignature).toBeUndefined();
    expect(part.thought_signature).toBeUndefined();
  });
});
