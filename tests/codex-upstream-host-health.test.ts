import { beforeEach, describe, expect, test } from "bun:test";
import {
  CODEX_UPSTREAM_HOST_COOLDOWN_MS,
  CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD,
  CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS,
  CODEX_UPSTREAM_HOST_MAX_ENTRIES,
  acquireCodexUpstreamHostAdmission,
  canonicalCodexUpstreamHostKey,
  clearCodexUpstreamHostHealth,
  getCodexUpstreamHostCooldownUntil,
  getCodexUpstreamHostHealth,
  isCodexUpstreamRedirectStatus,
  recordCodexUpstreamHostFailure,
  recordCodexUpstreamHostResponse,
  releaseCodexUpstreamHostAdmissionLease,
  type CodexUpstreamHostAdmissionLease,
  type CodexUpstreamHostHealthSnapshot,
  type CodexUpstreamHostKey,
} from "../src/codex/upstream-host-health";

beforeEach(() => clearCodexUpstreamHostHealth());

function admit(key: CodexUpstreamHostKey, now: number): CodexUpstreamHostAdmissionLease {
  const admission = acquireCodexUpstreamHostAdmission(key, now);
  expect(admission.kind).toBe("admitted");
  if (admission.kind !== "admitted") throw new Error("expected host admission");
  return admission.lease;
}

function fail(key: CodexUpstreamHostKey, now: number): CodexUpstreamHostHealthSnapshot {
  const health = recordCodexUpstreamHostFailure(admit(key, now), now);
  expect(health).not.toBeNull();
  return health!;
}

describe("Codex upstream host health (#914)", () => {
  test("keys normalized provider plus canonical HTTP origin only", () => {
    const canonical = canonicalCodexUpstreamHostKey(
      " OpenAI ",
      "HTTPS://CHATGPT.COM:443/backend-api/codex/responses?account=secret#fragment",
    );
    expect(canonical).toBe(canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com/other"));
    expect(canonical).not.toBe(canonicalCodexUpstreamHostKey("other", "https://chatgpt.com/other"));
    expect(canonical).not.toBe(canonicalCodexUpstreamHostKey("openai", "http://chatgpt.com/other"));
    expect(canonicalCodexUpstreamHostKey("openai", "ftp://chatgpt.com/file")).toBeNull();
  });

  test("normalizes trailing dots, IPv6 brackets, and the implicit HTTP port", () => {
    expect(canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com./path"))
      .toBe(canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com/other"));
    expect(canonicalCodexUpstreamHostKey(" OpenAI ", "https://[2001:DB8::1]/path"))
      .toBe("openai\u0000https://[2001:db8::1]:443");
    expect(canonicalCodexUpstreamHostKey("openai", "http://chatgpt.com/path"))
      .toBe(canonicalCodexUpstreamHostKey("openai", "http://chatgpt.com:80/other"));
  });

  test("identifies only supported upstream redirect statuses", () => {
    for (const status of [300, 301, 302, 303, 307, 308]) {
      expect(isCodexUpstreamRedirectStatus(status)).toBe(true);
    }
    for (const status of [299, 304, 305, 306, 309]) {
      expect(isCodexUpstreamRedirectStatus(status)).toBe(false);
    }
  });

  test("opens only at its threshold and a half-open HTTP response clears it", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com/backend-api/codex")!;
    const now = 1_900_000_000_000;
    for (let attempt = 1; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      const health = fail(key, now + attempt);
      expect(health.consecutiveFailures).toBe(attempt);
      expect(health.cooldownUntil).toBeUndefined();
    }
    const trippedAt = now + CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD;
    const tripped = fail(key, trippedAt);
    expect(tripped.cooldownUntil).toBe(trippedAt + CODEX_UPSTREAM_HOST_COOLDOWN_MS);
    expect(getCodexUpstreamHostCooldownUntil(key, trippedAt)).toBe(tripped.cooldownUntil!);
    const probeAt = tripped.cooldownUntil!;
    expect(recordCodexUpstreamHostResponse(admit(key, probeAt), probeAt)).toBe(true);
    expect(getCodexUpstreamHostHealth(key, probeAt)).toBeNull();
  });

  test("an expired window starts a fresh streak", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    fail(key, 1_000);
    const next = fail(key, 1_000 + CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS + 1);
    expect(next.consecutiveFailures).toBe(1);
  });

  test("admits exactly one half-open logical request after cooldown", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const now = 1_900_000_000_000;
    let tripped: CodexUpstreamHostHealthSnapshot | null = null;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      tripped = fail(key, now + attempt);
    }
    const cooldownUntil = tripped!.cooldownUntil!;
    expect(acquireCodexUpstreamHostAdmission(key, cooldownUntil - 1)).toMatchObject({ kind: "blocked" });
    const probe = acquireCodexUpstreamHostAdmission(key, cooldownUntil);
    expect(probe.kind).toBe("admitted");
    expect(acquireCodexUpstreamHostAdmission(key, cooldownUntil)).toEqual({
      kind: "blocked",
      retryAfterSeconds: 1,
    });
    if (probe.kind !== "admitted") throw new Error("expected half-open admission");
    expect(recordCodexUpstreamHostResponse(probe.lease, cooldownUntil)).toBe(true);
    expect(getCodexUpstreamHostHealth(key, cooldownUntil)).toBeNull();
  });

  test("a half-open terminal rejection immediately reopens the cooldown", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const trippedAt = 2_000;
    let tripped: CodexUpstreamHostHealthSnapshot | null = null;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      tripped = fail(key, trippedAt);
    }
    const probeAt = tripped!.cooldownUntil!;
    const reopened = recordCodexUpstreamHostFailure(admit(key, probeAt), probeAt)!;
    expect(reopened.cooldownUntil).toBe(probeAt + CODEX_UPSTREAM_HOST_COOLDOWN_MS);
    expect(acquireCodexUpstreamHostAdmission(key, probeAt)).toMatchObject({ kind: "blocked" });
  });

  test("a half-open rejection after an observed response starts a fresh streak", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const trippedAt = 2_500;
    let tripped: CodexUpstreamHostHealthSnapshot | null = null;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      tripped = fail(key, trippedAt);
    }
    const probeAt = tripped!.cooldownUntil!;
    const afterResponse = recordCodexUpstreamHostFailure(admit(key, probeAt), probeAt, {
      observedResponse: true,
    })!;

    expect(afterResponse.consecutiveFailures).toBe(1);
    expect(afterResponse.cooldownUntil).toBeUndefined();
    const next = admit(key, probeAt);
    expect(next.halfOpen).toBe(false);
    expect(releaseCodexUpstreamHostAdmissionLease(next, probeAt)).toBe(true);
  });

  test("an observed response preserves a concurrent lease and its later failure", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const now = 2_750;
    const observedResponse = admit(key, now);
    const concurrentFailure = admit(key, now);

    const reset = recordCodexUpstreamHostFailure(observedResponse, now, {
      observedResponse: true,
    })!;
    expect(reset.consecutiveFailures).toBe(1);
    expect(reset.cooldownUntil).toBeUndefined();

    const afterConcurrentFailure = recordCodexUpstreamHostFailure(concurrentFailure, now + 1);
    expect(afterConcurrentFailure?.consecutiveFailures).toBe(2);
    expect(afterConcurrentFailure?.cooldownUntil).toBeUndefined();
  });

  test("caller abort releases a half-open admission without adding evidence", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const trippedAt = 3_000;
    let tripped: CodexUpstreamHostHealthSnapshot | null = null;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      tripped = fail(key, trippedAt);
    }
    const probeAt = tripped!.cooldownUntil!;
    const first = admit(key, probeAt);
    const before = getCodexUpstreamHostHealth(key, probeAt);
    expect(releaseCodexUpstreamHostAdmissionLease(first, probeAt)).toBe(true);
    expect(getCodexUpstreamHostHealth(key, probeAt)).toEqual(before);
    expect(admit(key, probeAt).halfOpen).toBe(true);
  });

  test("stale pre-trip success and failure cannot settle a newer half-open generation", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const now = 4_000;
    const staleSuccess = admit(key, now);
    const staleFailure = admit(key, now);
    let tripped: CodexUpstreamHostHealthSnapshot | null = null;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      tripped = fail(key, now + attempt);
    }
    const probeAt = tripped!.cooldownUntil!;
    const halfOpen = admit(key, probeAt);
    const before = getCodexUpstreamHostHealth(key, probeAt);

    expect(recordCodexUpstreamHostResponse(staleSuccess, probeAt)).toBe(false);
    expect(recordCodexUpstreamHostFailure(staleFailure, probeAt)).toBeNull();
    expect(getCodexUpstreamHostHealth(key, probeAt)).toEqual(before);
    expect(acquireCodexUpstreamHostAdmission(key, probeAt)).toEqual({
      kind: "blocked",
      retryAfterSeconds: 1,
    });
    expect(recordCodexUpstreamHostResponse(halfOpen, probeAt)).toBe(true);
  });

  test("capacity pressure never evicts an active half-open admission", () => {
    const protectedKey = canonicalCodexUpstreamHostKey("openai", "https://protected.example")!;
    const now = 5_000;
    let tripped: CodexUpstreamHostHealthSnapshot | null = null;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      tripped = fail(protectedKey, now);
    }
    const probeAt = tripped!.cooldownUntil!;
    const halfOpen = admit(protectedKey, probeAt);
    const pressureLeases: CodexUpstreamHostAdmissionLease[] = [];
    for (let index = 0; index < CODEX_UPSTREAM_HOST_MAX_ENTRIES + 16; index++) {
      const key = canonicalCodexUpstreamHostKey(`provider-${index}`, `https://host-${index}.example`)!;
      pressureLeases.push(admit(key, probeAt + index));
    }
    expect(acquireCodexUpstreamHostAdmission(protectedKey, probeAt)).toEqual({
      kind: "blocked",
      retryAfterSeconds: 1,
    });
    for (const lease of pressureLeases) releaseCodexUpstreamHostAdmissionLease(lease, probeAt);
    expect(acquireCodexUpstreamHostAdmission(protectedKey, probeAt)).toEqual({
      kind: "blocked",
      retryAfterSeconds: 1,
    });
    expect(recordCodexUpstreamHostResponse(halfOpen, probeAt)).toBe(true);
  });

  test("capacity pressure evicts a non-cooldown entry before an active cooldown", () => {
    const cooldownKey = canonicalCodexUpstreamHostKey("openai", "https://cooldown.example")!;
    const trippedAt = 6_000;
    let tripped: CodexUpstreamHostHealthSnapshot | null = null;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      tripped = fail(cooldownKey, trippedAt + attempt);
    }
    const cooldownUntil = tripped!.cooldownUntil!;
    const oldestOrdinaryKey = canonicalCodexUpstreamHostKey(
      "ordinary-0",
      "https://ordinary-0.example",
    )!;
    for (let index = 0; index < CODEX_UPSTREAM_HOST_MAX_ENTRIES - 1; index++) {
      const key = canonicalCodexUpstreamHostKey(
        `ordinary-${index}`,
        `https://ordinary-${index}.example`,
      )!;
      fail(key, trippedAt + 100 + index);
    }

    const newcomerKey = canonicalCodexUpstreamHostKey("newcomer", "https://newcomer.example")!;
    const pressureAt = trippedAt + 100 + CODEX_UPSTREAM_HOST_MAX_ENTRIES;
    fail(newcomerKey, pressureAt);

    expect(getCodexUpstreamHostCooldownUntil(cooldownKey, pressureAt)).toBe(cooldownUntil);
    expect(getCodexUpstreamHostHealth(oldestOrdinaryKey, pressureAt)).toBeNull();
    expect(getCodexUpstreamHostHealth(newcomerKey, pressureAt)).not.toBeNull();
  });

  test("bounds the process-local map and evicts the oldest non-leased entry", () => {
    const first = canonicalCodexUpstreamHostKey("provider-0", "https://host-0.example")!;
    for (let index = 0; index <= CODEX_UPSTREAM_HOST_MAX_ENTRIES; index++) {
      const key = canonicalCodexUpstreamHostKey(`provider-${index}`, `https://host-${index}.example`)!;
      fail(key, 10_000 + index);
    }
    expect(getCodexUpstreamHostHealth(first, 10_000 + CODEX_UPSTREAM_HOST_MAX_ENTRIES)).toBeNull();
  });
});
