import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  antigravityCanonicalJsonBoundedForTests,
  antigravityFunctionCallKeyForTests,
  canonicalScanUnitsForTestsValue,
  resetCanonicalScanUnitsForTests,
  antigravityReplayMetrics,
  antigravityReplayKeyForTests,
  antigravityReplayRetainedStoreSnapshot,
  antigravityReplaySessionKeysForTests,
  antigravityUsesReplayCache,
  applyAntigravityReplay,
  clearAntigravityReplay,
  evictOldestAntigravityReplayForBudget,
  observeAntigravityReplay,
  setAntigravityReplayLimitsForTests,
  sweepExpiredAntigravityReplay,
} from "../src/adapters/google-antigravity-replay";
import { sanitizeAntigravityClaudeSignatures } from "../src/adapters/google-antigravity-wire";

afterEach(() => setAntigravityReplayLimitsForTests());

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

  test("preserves 20+ live signed calls below count and byte caps", () => {
    for (let i = 0; i < 24; i++) {
      observeAntigravityReplay(MODEL, SESSION, [fcPart(`call-${i}`, { i }, `sig-${i}-${"x".repeat(20)}`)]);
    }
    expect(antigravityReplayMetrics()).toMatchObject({ sessions: 1, calls: 24 });
    const contents = Array.from({ length: 24 }, (_, i) => ({ role: "model", parts: [fcPart(`call-${i}`, { i })] }));
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect(contents.every(c => typeof (c.parts[0] as { thoughtSignature?: string }).thoughtSignature === "string")).toBe(true);
  });

  test("evicts oldest inner call at the exact per-session count boundary", () => {
    setAntigravityReplayLimitsForTests({ maxCallsPerSession: 2 });
    observeAntigravityReplay(MODEL, SESSION, [fcPart("one", {}, "sig-one-aaaaaaaaaaaa")]);
    observeAntigravityReplay(MODEL, SESSION, [fcPart("two", {}, "sig-two-bbbbbbbbbbbb")]);
    observeAntigravityReplay(MODEL, SESSION, [fcPart("three", {}, "sig-three-cccccccccc")]);
    const contents = ["one", "two", "three"].map(name => ({ role: "model", parts: [fcPart(name, {})] }));
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
    expect((contents[1].parts[0] as { thoughtSignature?: string }).thoughtSignature).toContain("sig-two");
    expect((contents[2].parts[0] as { thoughtSignature?: string }).thoughtSignature).toContain("sig-three");
  });

  test("evicts oldest inner calls to satisfy aggregate session bytes", () => {
    // Fixed-key arithmetic: 64-byte session key + (64-byte call key + 40-byte
    // signature) per call — two calls fit 300, three do not.
    setAntigravityReplayLimitsForTests({ maxBytesPerSession: 300 });
    for (const name of ["one", "two", "three"]) {
      observeAntigravityReplay(MODEL, SESSION, [fcPart(name, {}, `sig-${name}-${"x".repeat(32)}`)]);
    }
    const metrics = antigravityReplayMetrics();
    expect(metrics.totalBytes).toBeLessThanOrEqual(300);
    expect(metrics.calls).toBe(2);
    const contents = ["one", "two", "three"].map(name => ({ role: "model", parts: [fcPart(name, {})] }));
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  test("does not cache one oversized signature", () => {
    setAntigravityReplayLimitsForTests({ maxSignatureBytes: 20 });
    observeAntigravityReplay(MODEL, SESSION, [fcPart("huge", {}, "x".repeat(21))]);
    expect(antigravityReplayMetrics()).toEqual({ sessions: 0, calls: 0, totalBytes: 0, largestSessionBytes: 0 });
  });

  test("apply refreshes matched call recency without extending session TTL", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      observeAntigravityReplay(MODEL, SESSION, [fcPart("one", {}, "sig-one-aaaaaaaaaaaa")]);
      now = 1_001;
      observeAntigravityReplay(MODEL, SESSION, [fcPart("two", {}, "sig-two-bbbbbbbbbbbb")]);
      expect(antigravityReplayRetainedStoreSnapshot().oldestAt).toBe(1_000);
      now = 1_002;
      applyAntigravityReplay(MODEL, SESSION, [{ role: "model", parts: [fcPart("one", {})] }]);
      expect(antigravityReplayRetainedStoreSnapshot().oldestAt).toBe(1_001);
      now = 1_001 + 60 * 60 * 1000;
      const expired = [{ role: "model", parts: [fcPart("one", {})] }];
      applyAntigravityReplay(MODEL, SESSION, expired);
      expect((expired[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });

  test("clear-on-invalid drops the bounded session and all byte accounting", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("one", {}, "sig-one-aaaaaaaaaaaa")]);
    expect(antigravityReplayMetrics().totalBytes).toBeGreaterThan(0);
    clearAntigravityReplay(MODEL, SESSION);
    expect(antigravityReplayMetrics()).toEqual({ sessions: 0, calls: 0, totalBytes: 0, largestSessionBytes: 0 });
  });

  test("040 snapshot is observe-only and oldest-session eviction returns exact released bytes", () => {
    const originalNow = Date.now;
    let now = 10;
    Date.now = () => now;
    try {
      observeAntigravityReplay(MODEL, "old", [fcPart("one", {}, "sig-one-aaaaaaaaaaaa")]);
      now = 20;
      observeAntigravityReplay(MODEL, "new", [fcPart("two", {}, "sig-two-bbbbbbbbbbbb")]);
      const before = antigravityReplayRetainedStoreSnapshot();
      expect(antigravityReplayRetainedStoreSnapshot()).toEqual(before);
      const released = evictOldestAntigravityReplayForBudget();
      expect(released).toBeGreaterThan(0);
      expect(antigravityReplayRetainedStoreSnapshot().bytes).toBe(before.bytes - released);
      const old = [{ role: "model", parts: [fcPart("one", {})] }];
      applyAntigravityReplay(MODEL, "old", old);
      expect((old[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });

  test("retained-store snapshot does not iterate a large replay map", () => {
    for (let i = 0; i < 512; i += 1) {
      observeAntigravityReplay(MODEL, `large-${i}`, [fcPart(`call-${i}`, { i }, `sig-${i}-${"x".repeat(20)}`)]);
    }
    const values = spyOn(Map.prototype, "values").mockImplementation(() => {
      throw new Error("snapshot iterated Map entries");
    });
    let snapshot: ReturnType<typeof antigravityReplayRetainedStoreSnapshot>;
    try {
      snapshot = antigravityReplayRetainedStoreSnapshot();
    } finally {
      values.mockRestore();
    }
    expect(snapshot!).toMatchObject({ count: 512, evictableBytes: snapshot!.bytes });
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

describe("antigravity replay fixed-size key identities", () => {
  const fcPart = (name: string, args: unknown, sig?: string) => {
    const part: Record<string, unknown> = { functionCall: { name, args } };
    if (sig) part.thoughtSignature = sig;
    return part;
  };
  const MODEL = "gemini-3-pro";
  const SESSION = "-12345";

  test("enormous model/session identities derive a fixed 64-hex key and stay uncounted-safe", () => {
    const hugeModel = "m".repeat(1024 * 1024);
    const hugeSession = "s".repeat(1024 * 1024);
    const derived = antigravityReplayKeyForTests(hugeModel, hugeSession);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    // Retained bytes for such a session = fixed key + fixed call key + payload
    // only — the 2 MiB of raw identity strings never enter the store.
    observeAntigravityReplay(hugeModel, hugeSession, [fcPart("f", {}, "sig-1234567890abcdef")]);
    const metrics = antigravityReplayMetrics();
    expect(metrics.sessions).toBe(1);
    expect(metrics.totalBytes).toBe(64 + 64 + "sig-1234567890abcdef".length);
    // The INTERNAL map keys are the derived identities, never the raw strings.
    expect(antigravityReplaySessionKeysForTests()).toEqual([derived]);
  });

  test("sparse arrays and undefined elements canonicalize differently", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    const explicit = [1, undefined, 3];
    expect(antigravityFunctionCallKeyForTests("f", { a: sparse }))
      .not.toBe(antigravityFunctionCallKeyForTests("f", { a: explicit }));
  });

  test("string escaping stays byte-identical across nasty content", () => {
    const nasty = "quo\"te\\back\bslash\fform\nnew\rline\ttabcontrol unicode é한🎆\ud800";
    const a = antigravityFunctionCallKeyForTests(nasty, { k: nasty });
    expect(antigravityFunctionCallKeyForTests(nasty, { k: nasty })).toBe(a);
    expect(antigravityFunctionCallKeyForTests(nasty, { k: `${nasty}x` })).not.toBe(a);
  });

  test("a lone surrogate never collides with U+FFFD (ES2019 escaping)", () => {
    const lone = "bad\ud800arg";
    const replacement = "bad�arg";
    const keyLone = antigravityFunctionCallKeyForTests("f", { k: lone });
    const keyReplacement = antigravityFunctionCallKeyForTests("f", { k: replacement });
    expect(keyLone).not.toBe(keyReplacement);
    // End-to-end: two same-name calls differing only by surrogate vs U+FFFD
    // keep DISTINCT signatures, and apply injects each onto its own call.
    const sigLone = "sig-lone-aaaaaaaaaaa";
    const sigReplacement = "sig-repl-bbbbbbbbbb";
    observeAntigravityReplay(MODEL, SESSION, [fcPart("f", { k: lone }, sigLone)]);
    observeAntigravityReplay(MODEL, SESSION, [fcPart("f", { k: replacement }, sigReplacement)]);
    const contents = [{
      role: "model",
      parts: [fcPart("f", { k: lone }), fcPart("f", { k: replacement })],
    }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    const parts = contents[0].parts as Array<{ thoughtSignature?: string }>;
    expect(parts[0]!.thoughtSignature).toBe(sigLone);
    expect(parts[1]!.thoughtSignature).toBe(sigReplacement);
    // Valid surrogate pairs keep deriving stably alongside.
    expect(antigravityFunctionCallKeyForTests("f", { k: "pair🎆ok" }))
      .toBe(antigravityFunctionCallKeyForTests("f", { k: "pair🎆ok" }));
  });

  test("a session whose overhead exceeds its byte cap retains no zero-call shell", () => {
    setAntigravityReplayLimitsForTests({ maxBytesPerSession: 100 });
    // 64 key + (64 key + sig) call > 100: admitted then evicted by the overhead.
    observeAntigravityReplay(MODEL, SESSION, [fcPart("f", {}, `sig-${"x".repeat(40)}`)]);
    const metrics = antigravityReplayMetrics();
    expect(metrics.sessions).toBe(0);
    expect(metrics.calls).toBe(0);
    expect(metrics.totalBytes).toBe(0);
  });

  test("worst-case key storage stays fixed at full session capacity", () => {
    const SIG = "sig-1234567890abcdef";
    for (let index = 0; index < 10_240; index += 1) {
      observeAntigravityReplay(MODEL, `session-${index}`, [fcPart("f", { i: index }, SIG)]);
    }
    const metrics = antigravityReplayMetrics();
    expect(metrics.sessions).toBe(10_240);
    // 10,240 sessions x (64 session key + 64 call key + 20-byte signature) —
    // keys never scale with input length, all within the 64 MiB global cap.
    expect(metrics.totalBytes).toBeLessThan(64 * 1024 * 1024);
    expect(metrics.totalBytes).toBe(10_240 * (64 + 64 + SIG.length));
  }, 30_000);

  test("lazy expiry scan is throttled; the sweeper remains authoritative", () => {
    observeAntigravityReplay(MODEL, "s-1", [fcPart("f", {}, "sig-1234567890abcdef")]);
    const originalNow = Date.now;
    try {
      // An expired session is NOT re-scanned within the 30s lazy interval.
      Date.now = () => originalNow() + 1000;
      observeAntigravityReplay(MODEL, "s-2", [fcPart("f", {}, "sig-1234567890abcdef")]);
      expect(antigravityReplayMetrics().sessions).toBe(2);
      // The periodic sweeper still removes expired sessions on its own pass.
      Date.now = () => originalNow() + 60 * 60 * 1000 + 1000;
      const removed = sweepExpiredAntigravityReplay(Date.now());
      expect(removed).toBe(2);
      expect(antigravityReplayMetrics().sessions).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test("length-prefixed components are unambiguous across separator content", () => {
    expect(antigravityReplayKeyForTests("a\0b", "c")).not.toBe(antigravityReplayKeyForTests("a", "b\0c"));
    expect(antigravityReplayKeyForTests("ab", "c")).not.toBe(antigravityReplayKeyForTests("a", "bc"));
    expect(antigravityReplayKeyForTests(MODEL, SESSION)).toBe(antigravityReplayKeyForTests(MODEL, SESSION));
  });

  test("canonicalization overflow skips the call without an unbounded intermediate", () => {
    // Args whose canonical form exceeds 64 KiB: rejected DURING the walk.
    const bigArgs = { blob: "x".repeat(256 * 1024) };
    expect(antigravityFunctionCallKeyForTests("f", bigArgs)).toBeUndefined();
    observeAntigravityReplay(MODEL, SESSION, [fcPart("f", bigArgs, "sig-1234567890abcdef")]);
    const metrics = antigravityReplayMetrics();
    expect(metrics.calls).toBe(0);
    expect(metrics.sessions).toBe(0);
    expect(metrics.totalBytes).toBe(0);
    // A conforming call right after still caches normally.
    observeAntigravityReplay(MODEL, SESSION, [fcPart("g", { a: 1 }, "sig-1234567890abcdef")]);
    expect(antigravityReplayMetrics().calls).toBe(1);
  });

  test("canonical equality is preserved for nested structures", () => {
    const a = antigravityFunctionCallKeyForTests("f", { x: [1, { b: 2, a: 3 }], y: "z" });
    const b = antigravityFunctionCallKeyForTests("f", { y: "z", x: [1, { a: 3, b: 2 }] });
    expect(a).toBe(b);
    const different = antigravityFunctionCallKeyForTests("f", { x: [1, { a: 3, b: 9 }], y: "z" });
    expect(different).not.toBe(a);
  });

  test("session and function-name keys never fold lone surrogates into U+FFFD", () => {
    // The hash-level injectivity contract: UTF-8 encoding would map both to
    // the same bytes; code-unit streaming must keep them distinct.
    expect(antigravityReplayKeyForTests("m", "bad\ud800session"))
      .not.toBe(antigravityReplayKeyForTests("m", "bad�session"));
    expect(antigravityFunctionCallKeyForTests("bad\ud800name", {}))
      .not.toBe(antigravityFunctionCallKeyForTests("bad�name", {}));
    // End-to-end: the two sessions stay separate caches.
    observeAntigravityReplay(MODEL, "bad\ud800session", [fcPart("f", {}, "sig-1234567890abcdef")]);
    observeAntigravityReplay(MODEL, "bad�session", [fcPart("f", {}, "sig-1234567890abcdef")]);
    expect(antigravityReplayMetrics().sessions).toBe(2);
  });

  test("bounded canonicalization rejects mid-walk without materializing the escape", () => {
    const hugeString = "y".repeat(10 * 1024 * 1024);
    // A 100-byte budget must refuse almost immediately — an implementation
    // that materialized the escaped string first would succeed-or-OOM, never null.
    expect(antigravityCanonicalJsonBoundedForTests(hugeString, 100)).toBeNull();
    const hugeNested = { blob: hugeString };
    expect(antigravityCanonicalJsonBoundedForTests(hugeNested, 100)).toBeNull();
    // Under the budget the exact canonical form is produced.
    expect(antigravityCanonicalJsonBoundedForTests({ a: [1, "x"] }, 1024)).toBe('{"a":[1,"x"]}');
  });

  test("pathological nesting is refused by the depth cap, not by a stack overflow", () => {
    // The byte and key budgets do not bound RECURSION: a deeply nested argument
    // shape is tiny on the wire. Without the depth cap this walk exhausts the
    // stack and throws RangeError out of a replay observation, which is a crash
    // path rather than a skipped replay. Removing MAX_CANONICAL_DEPTH left every
    // other antigravity test green, so this is the only case that pins it.
    const nest = (levels: number): unknown => {
      let value: unknown = 1;
      for (let i = 0; i < levels; i++) value = { n: value };
      return value;
    };

    // Comfortably inside the cap: canonicalizes normally.
    expect(antigravityCanonicalJsonBoundedForTests(nest(120), 1024 * 1024)).toContain('{"n":');
    // Past the cap: a null refusal, never a thrown RangeError.
    expect(antigravityCanonicalJsonBoundedForTests(nest(200), 1024 * 1024)).toBeNull();
    expect(antigravityCanonicalJsonBoundedForTests(nest(50_000), 8 * 1024 * 1024)).toBeNull();
  });

  test("overflow aborts the walk near the cap, proven by scan instrumentation", () => {
    resetCanonicalScanUnitsForTests();
    const hugeString = "y".repeat(10 * 1024 * 1024);
    expect(antigravityCanonicalJsonBoundedForTests(hugeString, 100)).toBeNull();
    // EXACT abort point: 1 node + 4096 code points (first 4 KiB flush crosses
    // the 100-byte budget). A stringify-then-measure regression reads 0 here,
    // an unbounded walk reads 10 MiB — only mid-walk abort reads 4097.
    expect(canonicalScanUnitsForTestsValue()).toBe(4097);

    resetCanonicalScanUnitsForTests();
    // A 20k-key object exceeds the guaranteed-overflow key bound (64 KiB / 4),
    // so it is rejected after key collection but BEFORE the sorted walk.
    const wide: Record<string, number> = {};
    for (let index = 0; index < 20_000; index += 1) wide[`k${index}`] = index;
    const sortSpy = spyOn(Array.prototype, "sort");
    expect(antigravityCanonicalJsonBoundedForTests(wide, 64 * 1024)).toBeNull();
    // Exactly one node visited (the object itself) and NO sort happened.
    expect(canonicalScanUnitsForTestsValue()).toBe(1);
    expect(sortSpy).not.toHaveBeenCalled();
    sortSpy.mockRestore();
    // A conforming object still sorts and walks normally.
    expect(antigravityCanonicalJsonBoundedForTests({ b: 1, a: 2 }, 1024)).toBe('{"a":2,"b":1}');
  });

  test("fixed session keys are counted per session and released exactly", () => {
    setAntigravityReplayLimitsForTests({ maxCallsPerSession: 3 });
    for (let session = 0; session < 4; session += 1) {
      for (let call = 0; call < 3; call += 1) {
        observeAntigravityReplay(MODEL, `session-${session}`, [fcPart(`f${call}`, {}, "sig-1234567890abcdef")]);
      }
    }
    const metrics = antigravityReplayMetrics();
    expect(metrics.sessions).toBe(4);
    expect(metrics.calls).toBe(12);
    // 4 sessions x 64-byte fixed outer key + 12 call records (fixed 64-byte
    // call key + 20-byte signature each).
    expect(metrics.totalBytes).toBe(4 * 64 + 12 * (64 + "sig-1234567890abcdef".length));
    for (let session = 0; session < 4; session += 1) {
      clearAntigravityReplay(MODEL, `session-${session}`);
    }
    expect(antigravityReplayMetrics().totalBytes).toBe(0);
  });
});
