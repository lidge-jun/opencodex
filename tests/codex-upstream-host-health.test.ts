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
  recordCodexUpstreamHostFailure,
  recordCodexUpstreamHostResponse,
  releaseCodexUpstreamHostProbeLease,
} from "../src/codex/upstream-host-health";

beforeEach(() => clearCodexUpstreamHostHealth());

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

  test("opens a fixed host cooldown only at its own threshold and clears on HTTP response", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com/backend-api/codex")!;
    const now = 1_900_000_000_000;
    for (let attempt = 1; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      const health = recordCodexUpstreamHostFailure(key, now + attempt);
      expect(health.consecutiveFailures).toBe(attempt);
      expect(health.cooldownUntil).toBeUndefined();
    }
    const trippedAt = now + CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD;
    const tripped = recordCodexUpstreamHostFailure(key, trippedAt);
    expect(tripped.cooldownUntil).toBe(trippedAt + CODEX_UPSTREAM_HOST_COOLDOWN_MS);
    expect(getCodexUpstreamHostCooldownUntil(key, trippedAt)).toBe(tripped.cooldownUntil!);
    recordCodexUpstreamHostResponse(key);
    expect(getCodexUpstreamHostHealth(key, trippedAt)).toBeNull();
  });

  test("an expired window starts a fresh streak", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    recordCodexUpstreamHostFailure(key, 1_000);
    const next = recordCodexUpstreamHostFailure(key, 1_000 + CODEX_UPSTREAM_HOST_FAILURE_WINDOW_MS + 1);
    expect(next.consecutiveFailures).toBe(1);
  });

  test("admits exactly one half-open logical request after cooldown", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const now = 1_900_000_000_000;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      recordCodexUpstreamHostFailure(key, now + attempt);
    }
    const cooldownUntil = now + CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD - 1
      + CODEX_UPSTREAM_HOST_COOLDOWN_MS;
    expect(acquireCodexUpstreamHostAdmission(key, cooldownUntil - 1)).toMatchObject({
      kind: "blocked",
    });
    const probe = acquireCodexUpstreamHostAdmission(key, cooldownUntil);
    expect(probe.kind).toBe("admitted");
    if (probe.kind !== "admitted") throw new Error("expected half-open admission");
    expect(probe.probeLease).not.toBeNull();
    expect(acquireCodexUpstreamHostAdmission(key, cooldownUntil)).toEqual({
      kind: "blocked",
      retryAfterSeconds: 1,
    });

    recordCodexUpstreamHostResponse(key);
    expect(acquireCodexUpstreamHostAdmission(key, cooldownUntil)).toEqual({
      kind: "admitted",
      probeLease: null,
    });
  });

  test("a half-open terminal rejection immediately reopens the cooldown", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const trippedAt = 2_000;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      recordCodexUpstreamHostFailure(key, trippedAt);
    }
    const probeAt = trippedAt + CODEX_UPSTREAM_HOST_COOLDOWN_MS;
    expect(acquireCodexUpstreamHostAdmission(key, probeAt).kind).toBe("admitted");
    const reopened = recordCodexUpstreamHostFailure(key, probeAt);
    expect(reopened.cooldownUntil).toBe(probeAt + CODEX_UPSTREAM_HOST_COOLDOWN_MS);
    expect(acquireCodexUpstreamHostAdmission(key, probeAt)).toMatchObject({ kind: "blocked" });
  });

  test("caller abort releases a half-open probe without adding evidence", () => {
    const key = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com")!;
    const trippedAt = 3_000;
    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      recordCodexUpstreamHostFailure(key, trippedAt);
    }
    const probeAt = trippedAt + CODEX_UPSTREAM_HOST_COOLDOWN_MS;
    const first = acquireCodexUpstreamHostAdmission(key, probeAt);
    if (first.kind !== "admitted") throw new Error("expected half-open admission");
    const before = getCodexUpstreamHostHealth(key, probeAt);
    expect(releaseCodexUpstreamHostProbeLease(first.probeLease)).toBe(true);
    expect(getCodexUpstreamHostHealth(key, probeAt)).toEqual(before);
    const replacement = acquireCodexUpstreamHostAdmission(key, probeAt);
    expect(replacement.kind).toBe("admitted");
    if (replacement.kind !== "admitted") throw new Error("expected replacement probe");
    expect(replacement.probeLease).not.toBeNull();
  });

  test("bounds the process-local map and evicts the oldest entry", () => {
    const first = canonicalCodexUpstreamHostKey("provider-0", "https://host-0.example")!;
    for (let index = 0; index <= CODEX_UPSTREAM_HOST_MAX_ENTRIES; index++) {
      const key = canonicalCodexUpstreamHostKey(`provider-${index}`, `https://host-${index}.example`)!;
      recordCodexUpstreamHostFailure(key, 10_000 + index);
    }
    expect(getCodexUpstreamHostHealth(first, 10_000 + CODEX_UPSTREAM_HOST_MAX_ENTRIES)).toBeNull();
  });
});
