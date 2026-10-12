import { describe, expect, test } from "bun:test";
import {
  FAILURE_FINGERPRINT_VERSION,
  FAILURE_STATUS_CLASSES,
  canonicalFailureFingerprintTuple,
  computeFailureFingerprint,
  failureStatusClass,
  type FailureFingerprintFacts,
} from "../../src/usage/failure-fingerprint";
import { REQUEST_FAILURE_CAUSES } from "../../src/lib/request-failure-model";
import { REQUEST_CLOSE_REASONS, REQUEST_TERMINAL_STATUSES } from "../../src/usage/request-outcome";

/**
 * A fingerprint that can carry content is not privacy-safe, and one that collides is not a
 * grouping key. Both properties are asserted structurally rather than by example, so a slot
 * added later has to be given a position instead of quietly joining an existing one.
 */
const BASE: FailureFingerprintFacts = {
  cause: "upstream-fault",
  statusClass: "5xx",
  providerClass: null,
  inboundProtocol: null,
  terminalStatus: null,
  closeReason: null,
  transportPhase: null,
  terminalSource: null,
};

/** Every slot, with a value that differs from BASE, read from the roster that declares it. */
const VARIATIONS: ReadonlyArray<[keyof FailureFingerprintFacts, unknown]> = [
  ["cause", REQUEST_FAILURE_CAUSES.find(cause => cause !== BASE.cause)!],
  ["statusClass", FAILURE_STATUS_CLASSES.find(value => value !== BASE.statusClass)!],
  ["providerClass", "openai"],
  ["inboundProtocol", "responses"],
  ["terminalStatus", REQUEST_TERMINAL_STATUSES[0]!],
  ["closeReason", REQUEST_CLOSE_REASONS[0]!],
  ["transportPhase", "mid_stream"],
  ["terminalSource", "upstream"],
];

describe("failure fingerprint", () => {
  test("it is deterministic and carries its version in the value", () => {
    const first = computeFailureFingerprint(BASE);
    expect(computeFailureFingerprint({ ...BASE })).toBe(first);
    // The version is imported, never written out: a bump must not be contradicted here.
    expect(first.startsWith(`v${FAILURE_FINGERPRINT_VERSION}:`)).toBe(true);
  });

  test("every tuple position changes the fingerprint", () => {
    const base = computeFailureFingerprint(BASE);
    const unchanged: string[] = [];
    for (const [key, value] of VARIATIONS) {
      const varied = computeFailureFingerprint({ ...BASE, [key]: value } as FailureFingerprintFacts);
      if (varied === base) unchanged.push(String(key));
    }
    expect(unchanged).toEqual([]);
  });

  test("the tuple has one fixed position per declared fact plus the version", () => {
    const tuple = canonicalFailureFingerprintTuple(BASE);
    expect(tuple.length).toBe(Object.keys(BASE).length + 1);
    expect(tuple[0]).toBe(FAILURE_FINGERPRINT_VERSION);
    // Absent facts are explicit nulls. Dropping them would let [a, null, b] and [a, b] collide.
    expect(tuple.slice(3).every(slot => slot === null)).toBe(true);
  });

  test("a missing fact is structurally distinct from a present one that looks like it", () => {
    const absent = computeFailureFingerprint(BASE);
    const present = computeFailureFingerprint({ ...BASE, providerClass: "null" });
    expect(present).not.toBe(absent);
  });

  test("a field outside the declared facts cannot reach the identity", () => {
    const withExtras = {
      ...BASE,
      provider: "cursor-alice@example.com",
      model: "secret-model",
      upstreamError: "prompt fragment",
      requestId: "req_1",
      timestamp: 1,
    } as FailureFingerprintFacts;
    expect(computeFailureFingerprint(withExtras)).toBe(computeFailureFingerprint(BASE));
    expect(JSON.stringify(canonicalFailureFingerprintTuple(withExtras))).not.toContain("example.com");
  });

  test("the status class covers every hundred and refuses anything else", () => {
    expect(failureStatusClass(101)).toBe("1xx");
    expect(failureStatusClass(204)).toBe("2xx");
    expect(failureStatusClass(302)).toBe("3xx");
    expect(failureStatusClass(429)).toBe("4xx");
    expect(failureStatusClass(503)).toBe("5xx");
    for (const value of [undefined, null, 0, 99, 600, 1.5, Number.NaN, "500"]) {
      expect(failureStatusClass(value)).toBe("unknown");
    }
  });

  test("every cause the recorder can store produces a distinct fingerprint", () => {
    const seen = new Map<string, string>();
    for (const cause of REQUEST_FAILURE_CAUSES) {
      const fingerprint = computeFailureFingerprint({ ...BASE, cause });
      expect(seen.has(fingerprint)).toBe(false);
      seen.set(fingerprint, cause);
    }
    expect(seen.size).toBe(REQUEST_FAILURE_CAUSES.length);
  });
});
