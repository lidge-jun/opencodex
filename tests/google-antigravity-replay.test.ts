import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../src/config";
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
  antigravitySupportsThoughtSignatureSentinel,
  applyAntigravityThoughtSignatureFallback,
  clearAntigravityReplay,
  evictOldestAntigravityReplayForBudget,
  flushAntigravityReplay,
  observeAntigravityReplay,
  setAntigravityReplayLimitsForTests,
  setAntigravityReplaySnapshotMaxBytesForTests,
  setAntigravityReplayWriteSeamForTests,
  sweepExpiredAntigravityReplay,
} from "../src/adapters/google-antigravity-replay";
import { sanitizeAntigravityClaudeSignatures } from "../src/adapters/google-antigravity-wire";

import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "./helpers/remove-tree";

afterEach(() => {
  setAntigravityReplayLimitsForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
});

// Sandbox OPENCODEX_HOME: the replay cache now snapshots to disk, and these tests must
// never touch the real ~/.opencodex.
let replayTestHome: string;
const priorOpenCodexHome = process.env["OPENCODEX_HOME"];

beforeEach(() => {
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
  setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "processed file: 1" }));
  replayTestHome = mkdtempSync(join(tmpdir(), "ocx-antigravity-replay-test-"));
  process.env["OPENCODEX_HOME"] = replayTestHome;
});

afterEach(() => {
  removeTreeWithRetry(replayTestHome);
  if (priorOpenCodexHome === undefined) delete process.env["OPENCODEX_HOME"];
  else process.env["OPENCODEX_HOME"] = priorOpenCodexHome;
});

const SIG = "sig-1234567890abcdef"; // >= 16 chars
const MODEL = "gemini-3-pro";
const SESSION = "-12345";

// Signatures are keyed by functionCall identity (name + args), so observe/apply use functionCall parts.
const fcPart = (name: string, args: unknown, sig?: string, nested = false) => {
  const part: Record<string, unknown> = { functionCall: { name, args } };
  if (sig && nested) part.extra_content = { google: { thought_signature: sig } };
  else if (sig) part.thoughtSignature = sig;
  return part;
};

describe("antigravity reasoning-replay cache", () => {
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

  test("a signature on a standalone thought part replays onto the next functionCall (#897)", () => {
    observeAntigravityReplay(MODEL, SESSION, [
      { thought: true, thoughtSignature: SIG },
      fcPart("get_x", { a: 1 }),
    ]);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("a signature on a standalone thought part replays onto all subsequent functionCalls in the same turn", () => {
    observeAntigravityReplay(MODEL, SESSION, [
      { thought: true, thoughtSignature: SIG },
      fcPart("get_x", { a: 1 }),
      fcPart("get_y", { b: 2 }),
    ]);
    const contents = [{
      role: "model",
      parts: [
        { functionCall: { name: "get_x", args: { a: 1 } } },
        { functionCall: { name: "get_y", args: { b: 2 } } },
      ],
    }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
    expect((contents[0].parts[1] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("carried thought signature across separate stream chunks pairs with subsequent functionCalls", () => {
    const carried = observeAntigravityReplay(MODEL, SESSION, [{ thought: true, thought_signature: SIG }]);
    expect(carried).toBe(SIG);
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 })], carried);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("a call's own signature wins over a preceding standalone thought signature", () => {
    observeAntigravityReplay(MODEL, SESSION, [
      { thought: true, thoughtSignature: "sig-standalone-aaaa" },
      fcPart("get_x", {}, SIG),
    ]);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("a standalone thought signature does not pair backwards or leak into a later observe", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", {}), { thought: true, thoughtSignature: SIG }]);
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_y", {})]);
    const contents = [{
      role: "model",
      parts: [
        { functionCall: { name: "get_x", args: {} } },
        { functionCall: { name: "get_y", args: {} } },
      ],
    }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
    expect((contents[0].parts[1] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  test("a signature on a non-thought part does not attach to the next call", () => {
    // Text parts survive replayed history with their own signature; only thought parts are stripped.
    observeAntigravityReplay(MODEL, SESSION, [
      { text: "answer", thoughtSignature: SIG },
      fcPart("get_x", {}),
    ]);
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
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

  test("matches freeform/custom_tool_call {input: string} against observed parsed JSON args", () => {
    // Upstream saw functionCall with parsed args { cmd: "ls -la" }
    observeAntigravityReplay(MODEL, SESSION, [fcPart("default_api:exec", { cmd: "ls -la" }, "sig-freeform-exec-1111")]);
    // Client replays custom_tool_call with serialized input { input: '{"cmd":"ls -la"}' }
    const contents = [{
      role: "model",
      parts: [{ functionCall: { name: "default_api:exec", args: { input: JSON.stringify({ cmd: "ls -la" }) } } }],
    }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-freeform-exec-1111");
  });

  test("matches alternate key even when wrapped representation exceeds canonical key limit (ck undefined)", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("default_api:exec", { cmd: "x" }, "sig-whitespace-overflow")]);
    // 2 MiB of leading/trailing whitespace makes the raw string large, but trimmed payload is small (under 64 KiB).
    // It must parse the trimmed slice directly rather than passing the 2 MiB string to JSON.parse.
    const smallJson = JSON.stringify({ cmd: "x" });
    const bigWhitespaceJson = " ".repeat(2 * 1024 * 1024) + smallJson + " ".repeat(1024);
    let parsedString = "";
    const originalParse = JSON.parse;
    JSON.parse = (text, reviver) => {
      if (typeof text === "string" && text.includes('"cmd":"x"')) {
        parsedString = text;
      }
      return originalParse(text, reviver);
    };
    const contents = [{
      role: "model",
      parts: [{ functionCall: { name: "default_api:exec", args: { input: bigWhitespaceJson } } }],
    }];
    try {
      applyAntigravityReplay(MODEL, SESSION, contents);
      expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-whitespace-overflow");
      expect(parsedString).toBe(smallJson);
    } finally {
      JSON.parse = originalParse;
    }
  });

  test("rejects oversized input before JSON.parse without matching or allocating", () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("default_api:exec", { data: "huge" }, "sig-should-not-match")]);
    // 100 KiB of valid JSON payload exceeds REPLAY_MAX_CANONICAL_ARGS_BYTES and must be rejected before TextEncoder.encode / JSON.parse.
    let parseCalled = false;
    let encodeCalledOnPayload = false;
    const originalParse = JSON.parse;
    const originalEncode = TextEncoder.prototype.encode;
    JSON.parse = (text, reviver) => {
      if (typeof text === "string" && text.includes('"data":')) {
        parseCalled = true;
      }
      return originalParse(text, reviver);
    };
    TextEncoder.prototype.encode = function (input) {
      if (typeof input === "string" && input.includes('"data":')) {
        encodeCalledOnPayload = true;
      }
      return originalEncode.call(this, input);
    };
    const oversizedPayload = JSON.stringify({ data: "a".repeat(100 * 1024) });
    const contents = [{
      role: "model",
      parts: [{ functionCall: { name: "default_api:exec", args: { input: oversizedPayload } } }],
    }];
    try {
      applyAntigravityReplay(MODEL, SESSION, contents);
      expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
      expect(parseCalled).toBe(false);
      expect(encodeCalledOnPayload).toBe(false);
    } finally {
      JSON.parse = originalParse;
      TextEncoder.prototype.encode = originalEncode;
    }
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

describe("durable antigravity replay snapshot", () => {
  const snapshotPath = () => join(getConfigDir(), "antigravity-replay.json");

  test("observed signatures survive a cache reset via the disk snapshot", async () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    await flushAntigravityReplay();
    expect(existsSync(snapshotPath())).toBe(true);
    // Proxy-restart simulation: wipe the in-process cache, then reload lazily.
    setAntigravityReplayLimitsForTests();
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("flush writes the pending snapshot without waiting for the debounce", async () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    await flushAntigravityReplay();
    const raw = JSON.parse(readFileSync(snapshotPath(), "utf8")) as { version?: unknown; sessions?: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.sessions).toHaveLength(1);
    expect((raw.sessions![0] as unknown[])[0]).toBe(antigravityReplayKeyForTests(MODEL, SESSION));
  });

  test("expired sessions are dropped when the snapshot is loaded", async () => {
    const now = Date.now();
    const callKey = antigravityFunctionCallKeyForTests("get_x", { a: 1 });
    const staleCallKey = antigravityFunctionCallKeyForTests("get_stale", {});
    writeFileSync(snapshotPath(), JSON.stringify({
      version: 1,
      sessions: [
        [antigravityReplayKeyForTests(MODEL, "-stale"), {
          expiresAtMs: now - 1_000,
          byCall: [[staleCallKey, { signature: SIG, sizeBytes: SIG.length, touchedAtMs: now }]],
        }],
        [antigravityReplayKeyForTests(MODEL, SESSION), {
          expiresAtMs: now + 60_000,
          byCall: [[callKey, { signature: SIG, sizeBytes: SIG.length, touchedAtMs: now }]],
        }],
      ],
    }));
    const staleContents = [{ role: "model", parts: [{ functionCall: { name: "get_stale", args: {} } }] }];
    // Load alone drops the expired session and persists the cleanup, before any
    // replay-induced dirty state exists.
    expect(antigravityReplayMetrics().sessions).toBe(1);
    await flushAntigravityReplay();
    const raw = JSON.parse(readFileSync(snapshotPath(), "utf8")) as { sessions?: unknown[] };
    const keys = raw.sessions!.map(session => (session as unknown[])[0]);
    expect(keys).not.toContain(antigravityReplayKeyForTests(MODEL, "-stale"));
    expect(keys).toContain(antigravityReplayKeyForTests(MODEL, SESSION));
    // The surviving session still replays.
    applyAntigravityReplay(MODEL, "-stale", staleContents);
    expect((staleContents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
    // Persist the apply-time touch so no debounced write is left pending.
    await flushAntigravityReplay();
  });

  test("sweeping expired sessions removes them from the durable snapshot", async () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    await flushAntigravityReplay();
    expect(readFileSync(snapshotPath(), "utf8")).toContain(SIG);

    expect(sweepExpiredAntigravityReplay(Number.MAX_SAFE_INTEGER)).toBe(1);
    await flushAntigravityReplay();

    const rawText = readFileSync(snapshotPath(), "utf8");
    const snapshot = JSON.parse(rawText) as { sessions?: unknown[] };
    expect(snapshot.sessions).toHaveLength(0);
    expect(rawText).not.toContain(SIG);
  });

  test("snapshot cap keeps the most recently active sessions", async () => {
    // A (two calls, ~899 serialized bytes) fits under the cap; A+B (~1,347)
    // does not, so the cap must pick exactly one session by activity.
    setAntigravityReplaySnapshotMaxBytesForTests(1_200);
    const sigA = "a".repeat(200);
    const sigB = "b".repeat(200);
    // A is inserted first, B second, then A is re-observed: A is now the
    // active session, so it must be the one retained under the byte cap.
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, sigA)]);
    observeAntigravityReplay(MODEL, "-second", [fcPart("get_y", {}, sigB)]);
    await Bun.sleep(2);
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_z", { c: 2 }, sigA)]);
    await flushAntigravityReplay();
    const raw = JSON.parse(readFileSync(snapshotPath(), "utf8")) as { sessions?: unknown[] };
    const keys = raw.sessions!.map(session => (session as unknown[])[0]);
    expect(keys).toContain(antigravityReplayKeyForTests(MODEL, SESSION));
    expect(keys).not.toContain(antigravityReplayKeyForTests(MODEL, "-second"));
  });

  test("loaded sessions are trimmed to the current per-session caps", () => {
    setAntigravityReplayLimitsForTests({ maxBytesPerSession: 300 });
    const now = Date.now();
    const callKey = antigravityFunctionCallKeyForTests("get_x", { a: 1 });
    const trimKey = antigravityFunctionCallKeyForTests("get_y", {});
    // 100-byte signatures: one call (64+64+100 = 228) fits the 300-byte cap,
    // two calls (392) do not, so the oldest is evicted on load.
    const sigA = "a".repeat(100);
    const sigB = "b".repeat(100);
    writeFileSync(snapshotPath(), JSON.stringify({
      version: 1,
      sessions: [
        [antigravityReplayKeyForTests(MODEL, SESSION), {
          expiresAtMs: now + 60_000,
          // Oldest (get_y) is evicted first on load: only get_x survives the cap.
          byCall: [
            [trimKey, { signature: sigB, sizeBytes: 200, touchedAtMs: now }],
            [callKey, { signature: sigA, sizeBytes: 200, touchedAtMs: now }],
          ],
        }],
      ],
    }));
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(sigA);
    const metrics = antigravityReplayMetrics();
    expect(metrics.sessions).toBe(1);
    expect(metrics.calls).toBe(1);
    // Recomputed from the signature: 64-byte session key + 64-byte call key + 100-byte signature.
    expect(metrics.totalBytes).toBe(64 + 64 + 100);
  });

  test("load recomputes call sizes from the signature and ignores serialized sizeBytes", () => {
    const now = Date.now();
    const callKey = antigravityFunctionCallKeyForTests("get_x", { a: 1 });
    const unicodeSig = "\u00e9".repeat(16);
    const oversizedUnicodeSig = "\u{1f600}".repeat(16_500);
    writeFileSync(snapshotPath(), JSON.stringify({
      version: 1,
      sessions: [
        [antigravityReplayKeyForTests(MODEL, SESSION), {
          expiresAtMs: now + 60_000,
          // Forged tiny sizeBytes must not shrink the accounted UTF-8 bytes.
          byCall: [[callKey, { signature: unicodeSig, sizeBytes: 1, touchedAtMs: now }]],
        }],
        [antigravityReplayKeyForTests(MODEL, "-forged"), {
          expiresAtMs: now + 60_000,
          // The UTF-16 length is below 64 KiB, but the UTF-8 byte length is not.
          byCall: [[antigravityFunctionCallKeyForTests("get_y", {}), {
            signature: oversizedUnicodeSig,
            sizeBytes: 1,
            touchedAtMs: now,
          }]],
        }],
      ],
    }));
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(unicodeSig);
    const metrics = antigravityReplayMetrics();
    expect(metrics.sessions).toBe(1);
    // 64-byte session key + 64-byte call key + 32-byte UTF-8 signature.
    expect(metrics.totalBytes).toBe(64 + 64 + new TextEncoder().encode(unicodeSig).byteLength);
  });

  test("duplicate call keys in a snapshot are collapsed to one admitted call", async () => {
    const now = Date.now();
    const callKey = antigravityFunctionCallKeyForTests("get_x", { a: 1 });
    writeFileSync(snapshotPath(), JSON.stringify({
      version: 1,
      sessions: [
        [antigravityReplayKeyForTests(MODEL, SESSION), {
          expiresAtMs: now + 60_000,
          byCall: [
            [callKey, { signature: SIG, touchedAtMs: now }],
            [callKey, { signature: "sig-abcdef0123456789", touchedAtMs: now }],
          ],
        }],
      ],
    }));
    // Metrics first: the load itself must collapse the duplicate and count once.
    const metrics = antigravityReplayMetrics();
    expect(metrics.calls).toBe(1);
    // 64-byte session key + one 64-byte call key + 20-byte signature: no double count.
    expect(metrics.totalBytes).toBe(64 + 64 + SIG.length);
    // Load-time cleanup is persisted back to the snapshot.
    await flushAntigravityReplay();
    const raw = JSON.parse(readFileSync(snapshotPath(), "utf8")) as { sessions?: unknown[] };
    const session = raw.sessions![0] as [unknown, { byCall?: unknown[] }];
    expect(session[1].byCall).toHaveLength(1);
    // The surviving call still replays.
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
    // Persist the apply-time touch so no debounced write is left pending.
    await flushAntigravityReplay();
  });

  test("snapshot never serializes sizeBytes", async () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    await flushAntigravityReplay();
    expect(readFileSync(snapshotPath(), "utf8")).not.toContain("sizeBytes");
  });

  test("corrupt or unknown-version snapshots start the cache empty", () => {
    writeFileSync(snapshotPath(), "{not valid json");
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
    setAntigravityReplayLimitsForTests();
    writeFileSync(snapshotPath(), JSON.stringify({ version: 99, sessions: [] }));
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  test("clear-on-invalid removes the session from the next snapshot", async () => {
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    clearAntigravityReplay(MODEL, SESSION);
    await flushAntigravityReplay();
    const raw = JSON.parse(readFileSync(snapshotPath(), "utf8")) as { sessions?: unknown[] };
    expect(raw.sessions).toHaveLength(0);
  });

  test("oversized snapshot files are refused before parsing", () => {
    writeFileSync(snapshotPath(), "x".repeat(33 * 1024 * 1024));
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: { a: 1 } } }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  test("flush waits out a blocked writer and persists mutations that land during it", async () => {
    let firstWriteReached!: () => void;
    const reached = new Promise<void>(resolve => { firstWriteReached = resolve; });
    let firstWriteRelease!: () => void;
    const release = new Promise<void>(resolve => { firstWriteRelease = resolve; });
    let writes = 0;
    setAntigravityReplayWriteSeamForTests({
      afterTempWrite: async () => {
        writes += 1;
        if (writes === 1) {
          firstWriteReached();
          await release;
        }
      },
    });
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    const flushing = flushAntigravityReplay();
    await reached;
    // A mutation lands while the first snapshot write is still blocked.
    observeAntigravityReplay(MODEL, "-second", [fcPart("get_y", {}, SIG)]);
    firstWriteRelease();
    await flushing;
    const raw = JSON.parse(readFileSync(snapshotPath(), "utf8")) as { sessions?: unknown[] };
    const keys = raw.sessions!.map(session => (session as unknown[])[0]);
    expect(keys).toHaveLength(2);
    expect(keys).toContain(antigravityReplayKeyForTests(MODEL, SESSION));
    expect(keys).toContain(antigravityReplayKeyForTests(MODEL, "-second"));
  });

  test("flush surfaces snapshot write failures for shutdown diagnostics", async () => {
    setAntigravityReplayWriteSeamForTests({
      afterTempWrite: async () => { throw new Error("simulated disk failure"); },
    });
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    await expect(flushAntigravityReplay()).rejects.toThrow("simulated disk failure");
  });

  test("flush rejects when its retry budget cannot converge", async () => {
    // A mutation that lands during every attempted write means the durable
    // generation never catches up. Resolving here would tell drainAndShutdown()
    // the snapshot is durable while the latest thought signature may never have
    // reached disk, so shutdown would report a durability we cannot demonstrate.
    let writes = 0;
    setAntigravityReplayWriteSeamForTests({
      afterTempWrite: async () => {
        writes += 1;
        // Dirty the cache again inside every write, so each attempt finishes
        // behind the newest mutation.
        observeAntigravityReplay(MODEL, `-racer-${writes}`, [fcPart("get_y", { n: writes }, SIG)]);
      },
    });
    observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
    await expect(flushAntigravityReplay()).rejects.toThrow(
      "Antigravity replay snapshot flush did not converge.",
    );
    // The bound is still honored: it gives up rather than spinning forever.
    expect(writes).toBe(8);
  });

  test("the written snapshot stays within the byte cap once framing is counted", async () => {
    // The cap must bound the file, not the sum of its entries. Counting only
    // per-entry sizes ignored the {"version":N,"sessions":[...]} framing and the
    // comma between entries, so the written document exceeded the advertised cap
    // by a margin that grew with every additional session.
    const sig = "s".repeat(120);
    observeAntigravityReplay(MODEL, "-one", [fcPart("get_a", { i: 1 }, sig)]);
    await Bun.sleep(2);
    observeAntigravityReplay(MODEL, "-two", [fcPart("get_b", { i: 2 }, sig)]);
    await Bun.sleep(2);
    observeAntigravityReplay(MODEL, "-three", [fcPart("get_c", { i: 3 }, sig)]);
    await flushAntigravityReplay();

    // Set the cap to exactly the sum of the entry sizes. Per-entry accounting
    // admits all three and writes `framing` bytes too many; correct accounting
    // sees that the document does not fit and drops one entry.
    const full = readFileSync(snapshotPath(), "utf8");
    const entries = (JSON.parse(full) as { sessions: unknown[] }).sessions;
    expect(entries).toHaveLength(3);
    const entrySum = entries.reduce(
      (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry), "utf8"),
      0,
    );
    // The framing is what this test is about, so assert it is actually there.
    expect(Buffer.byteLength(full, "utf8")).toBeGreaterThan(entrySum);
    setAntigravityReplaySnapshotMaxBytesForTests(entrySum);

    // Re-observe the identical call: the cache dirties without any size changing.
    observeAntigravityReplay(MODEL, "-three", [fcPart("get_c", { i: 3 }, sig)]);
    await flushAntigravityReplay();

    const written = readFileSync(snapshotPath(), "utf8");
    // The whole file honors the cap, not merely the entries inside it.
    expect(Buffer.byteLength(written, "utf8")).toBeLessThanOrEqual(entrySum);
    // Not vacuous: it drops what does not fit instead of emptying the snapshot.
    const kept = (JSON.parse(written) as { sessions: unknown[] }).sessions;
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.length).toBeLessThan(3);
  });

  test("background snapshot failures log a redacted warning and keep the service running", async () => {
    const FAKE_SECRET = "FAKE_SECRET_antigravity_replay_12345";
    let warned!: () => void;
    const warningSeen = new Promise<void>(resolve => { warned = resolve; });
    const warn = spyOn(console, "warn").mockImplementation((...args) => {
      if (String(args[0]).includes("antigravity")) warned();
    });
    try {
      setAntigravityReplayWriteSeamForTests({
        afterTempWrite: async () => { throw new Error(`simulated disk failure ${FAKE_SECRET}`); },
      });
      observeAntigravityReplay(MODEL, SESSION, [fcPart("get_x", { a: 1 }, SIG)]);
      // Deterministic: wait until the debounced write actually failed and
      // warned (bounded), instead of racing a fixed sleep against the timer.
      await Promise.race([warningSeen, Bun.sleep(5_000)]);
      expect(warn.mock.calls.some(call => String(call[0]).includes("antigravity"))).toBe(true);
      // The warning is redacted: error payload must never reach the log.
      expect(warn.mock.calls.every(call => !call.some(arg => String(arg).includes(FAKE_SECRET)))).toBe(true);
      // The failure must not wedge the cache: a later mutation still works.
      observeAntigravityReplay(MODEL, SESSION, [fcPart("get_y", {}, SIG)]);
      expect(antigravityReplayMetrics().calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("thought-signature validator-bypass fallback (#2693)", () => {
  const BYPASS = "skip_thought_signature_validator";
  const sigOf = (part: unknown) => (part as { thoughtSignature?: string }).thoughtSignature;
  const modelTurn = (parts: unknown[]) => [{ role: "model", parts }];

  test("the FIRST functionCall gets the sentinel even when a later sibling is signed", () => {
    // The original attempt tracked a turn-wide "any part is signed" boolean, so a second call
    // matching the cache voted away the sentinel the first call still required. Gemini rejects
    // that turn: the requirement is about the first functionCall, not about the turn.
    observeAntigravityReplay(MODEL, SESSION, [fcPart("second", {}, SIG)]);
    const contents = modelTurn([
      { functionCall: { name: "first", args: {} } },
      { functionCall: { name: "second", args: {} } },
    ]);
    applyAntigravityReplay(MODEL, SESSION, contents);
    applyAntigravityThoughtSignatureFallback(MODEL, contents);
    expect(sigOf(contents[0].parts[1])).toBe(SIG);
    expect(sigOf(contents[0].parts[0])).toBe(BYPASS);
  });

  test("a valid NESTED signature counts as signed and gets no competing sentinel", () => {
    // extra_content.google.thought_signature is a wire shape this module already supports, but a
    // bare key-presence check cannot see it, so it added a second, conflicting signature.
    const contents = modelTurn([fcPart("get_x", {}, SIG, true)]);
    applyAntigravityThoughtSignatureFallback(MODEL, contents);
    expect(sigOf(contents[0].parts[0])).toBeUndefined();
    expect((contents[0].parts[0] as { extra_content?: { google?: { thought_signature?: string } } })
      .extra_content?.google?.thought_signature).toBe(SIG);
  });

  test("a present but too-short signature still gets the sentinel", () => {
    // "short" is below MIN_SIGNATURE_LEN, so extractSignature rejects it. A presence check reads
    // the key as set and suppresses the fallback on a turn that genuinely needs it.
    const contents = modelTurn([fcPart("get_x", {}, "short")]);
    applyAntigravityThoughtSignatureFallback(MODEL, contents);
    expect(sigOf(contents[0].parts[0])).toBe(BYPASS);
  });

  test("a non-Gemini model never receives the Gemini-only sentinel", () => {
    // antigravityUsesReplayCache is !/claude/i, so gating on it injected this token into
    // gpt-oss-120b-medium. Replay scope is broad by design; sentinel scope must not be.
    const contents = modelTurn([{ functionCall: { name: "get_x", args: {} } }]);
    applyAntigravityThoughtSignatureFallback("gpt-oss-120b-medium", contents);
    expect(sigOf(contents[0].parts[0])).toBeUndefined();
  });

  test("a Gemini turn with no cache entry at all still gets the sentinel", () => {
    // The feature's whole point: nothing was recorded for this session, so replay cannot help.
    const contents = modelTurn([{ functionCall: { name: "never_seen", args: {} } }]);
    applyAntigravityReplay(MODEL, "session-with-no-entry", contents);
    applyAntigravityThoughtSignatureFallback(MODEL, contents);
    expect(sigOf(contents[0].parts[0])).toBe(BYPASS);
  });

  test("the Vertex transport-prefixed model id is recognised as Gemini", () => {
    // src/adapters/google.ts builds vertex:<project>:<location>:<modelId>. A predicate matching
    // only "/" would skip every Vertex Gemini request while looking correct on CCA ids.
    expect(antigravitySupportsThoughtSignatureSentinel("vertex:proj:global:gemini-3-pro")).toBe(true);
    expect(antigravitySupportsThoughtSignatureSentinel("google/gemini-3-pro")).toBe(true);
    expect(antigravitySupportsThoughtSignatureSentinel("gemini-3-pro")).toBe(true);
    expect(antigravitySupportsThoughtSignatureSentinel("vertex:proj:global:gpt-oss-120b")).toBe(false);
    expect(antigravitySupportsThoughtSignatureSentinel("geminibot")).toBe(false);
  });


  test("a later sibling signed ON THE WIRE does not vote away the first call's sentinel", () => {
    // Sibling arm of defect 2, with NO cache involved. A patch that only ignores cache-set
    // signatures would still pass the cache-hit case above while leaving this open, so bind it
    // explicitly: the decision reads the FIRST functionCall, never the turn.
    const contents = [{
      role: "model",
      parts: [
        { functionCall: { name: "first", args: {} } },
        { functionCall: { name: "second", args: {} }, thoughtSignature: SIG },
      ],
    }];
    applyAntigravityThoughtSignatureFallback(MODEL, contents);
    expect(sigOf(contents[0].parts[0])).toBe(BYPASS);
    expect(sigOf(contents[0].parts[1])).toBe(SIG);
  });

  test("Vertex-prefixed Gemini turns still receive the sentinel end to end", () => {
    // The Vertex replay key is vertex:<project>:<location>:<modelId>. Asserting only the
    // predicate would let a regex that matches "/" but not ":" look correct; drive the real
    // function with the real identity instead.
    const vertexModel = "vertex:api-key:global:gemini-3-pro";
    const contents = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityThoughtSignatureFallback(vertexModel, contents);
    expect(sigOf(contents[0].parts[0])).toBe(BYPASS);

    const vertexNonGemini = "vertex:api-key:global:gpt-oss-120b-medium";
    const other = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityThoughtSignatureFallback(vertexNonGemini, other);
    expect(sigOf(other[0].parts[0])).toBeUndefined();
  });

  test("a gemini-named Vertex PROJECT does not arm the sentinel for a non-Gemini model", () => {
    // The Vertex replay key is vertex:<project>:<location>:<modelId> and the project id is
    // operator-chosen. Scanning the whole identity meant a project called "gemini-prod" armed
    // the Gemini-only sentinel for gpt-oss-120b — the same class of defect the predicate exists
    // to prevent, one layer up. Reduce to the model component before matching.
    expect(antigravitySupportsThoughtSignatureSentinel("vertex:gemini-prod:global:gpt-oss-120b"))
      .toBe(false);
    expect(antigravitySupportsThoughtSignatureSentinel("vertex:gemini-team:us:claude-fable-5"))
      .toBe(false);

    const contents = [{
      role: "model",
      parts: [{ functionCall: { name: "get_x", args: {} } }],
    }];
    applyAntigravityThoughtSignatureFallback("vertex:gemini-prod:global:gpt-oss-120b", contents);
    expect(sigOf(contents[0].parts[0])).toBeUndefined();

    // The positive control still holds under the same parsing.
    const gemini = [{ role: "model", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityThoughtSignatureFallback("vertex:gemini-prod:global:gemini-3-pro", gemini);
    expect(sigOf(gemini[0].parts[0])).toBe(BYPASS);
  });

  test("a user-role turn is untouched", () => {
    const contents = [{ role: "user", parts: [{ functionCall: { name: "get_x", args: {} } }] }];
    applyAntigravityThoughtSignatureFallback(MODEL, contents);
    expect(sigOf(contents[0].parts[0])).toBeUndefined();
  });
});
