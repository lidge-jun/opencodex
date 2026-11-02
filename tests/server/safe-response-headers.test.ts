import { describe, expect, test } from "bun:test";
import { CodexWsMetadata } from "../../src/server/responses/codex-ws-metadata";
import { isSafeResponseHeader, normalizeSafeResponseHeader, safeResponseHeaders } from "../../src/server/safe-response-headers";

// A provider key with no recognizable prefix, so pattern-based redaction cannot spot it.
const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const NUMERIC_KEY = "73915028461739205817";

describe("response metadata headers are allowlisted by name and rebuilt by contract", () => {
  test("unlisted names never pass, whatever their prefix", () => {
    const out = safeResponseHeaders(new Headers({
      "x-ratelimit-secret": PROVIDER_KEY, "x-ratelimit-fixture-1": "1", "x-codex-private-token": PROVIDER_KEY,
      "x-codex-promo-message": "Upgrade now " + PROVIDER_KEY, "set-cookie": PROVIDER_KEY,
    }));
    expect(out).toEqual({});
    expect(isSafeResponseHeader("x-ratelimit-secret")).toBe(false);
    expect(isSafeResponseHeader("x-codex-promo-message")).toBe(false);
  });

  test("numeric values are rebuilt; anything else is dropped", () => {
    const out = safeResponseHeaders(new Headers({
      "x-ratelimit-remaining-requests": PROVIDER_KEY, "x-ratelimit-limit-tokens": "0400", "x-ratelimit-remaining-tokens": "1e3",
      "x-codex-primary-used-percent": "100.0", "x-codex-primary-window-minutes": PROVIDER_KEY,
      "x-codex-primary-reset-at": NUMERIC_KEY, "x-codex-credits-balance": "12.50",
      "x-codex-credits-has-credits": "TRUE", "x-codex-credits-unlimited": PROVIDER_KEY,
    }));
    expect(out).toEqual({
      "x-ratelimit-limit-tokens": "400", "x-codex-primary-used-percent": "100",
      "x-codex-credits-balance": "12.5", "x-codex-credits-has-credits": "true",
    });
  });

  test("rate-limit resets are rebuilt as durations", () => {
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-requests", "6m0s")).toBe("6m0s");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-tokens", "1h2m3.5s")).toBe("1h2m3.5s");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-tokens", "20ms")).toBe("20ms");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset", "30")).toBe("30");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-requests", PROVIDER_KEY)).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-requests", "999999h")).toBeUndefined();
  });

  test("identifiers keep their grammar; credential-shaped text does not pass", () => {
    expect(normalizeSafeResponseHeader("x-request-id", "req_abc-123")).toBe("req_abc-123");
    expect(normalizeSafeResponseHeader("x-request-id", "req " + PROVIDER_KEY)).toBeUndefined();
    expect(normalizeSafeResponseHeader("openai-request-id", "a".repeat(129))).toBeUndefined();
    expect(normalizeSafeResponseHeader("openai-model", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeSafeResponseHeader("openai-model", "model+" + PROVIDER_KEY)).toBeUndefined();
    expect(normalizeSafeResponseHeader("openai-model", "sk-proj-" + PROVIDER_KEY)).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-codex-primary-limit-name", "GPT-5 (weekly)")).toBe("GPT-5 (weekly)");
    expect(normalizeSafeResponseHeader("x-codex-primary-limit-name", "line\nbreak")).toBeUndefined();
  });

  test("the native WebSocket metadata path relays the same rebuilt values", () => {
    const owner = new CodexWsMetadata();
    owner.commit();
    const text = owner.consume({ type: "codex.response.metadata", headers: {
      "x-ratelimit-secret": PROVIDER_KEY, "x-request-id": PROVIDER_KEY + "!", "x-ratelimit-remaining-requests": "7",
      "x-codex-promo-message": PROVIDER_KEY,
    } }, 200);
    expect(text).toBe('{"type":"codex.response.metadata","headers":{"x-ratelimit-remaining-requests":"7"}}');
    expect(JSON.stringify([...owner.snapshot()])).not.toContain(PROVIDER_KEY);
    const quota = new CodexWsMetadata();
    quota.commit();
    quota.consume({ type: "codex.rate_limits", credits: { balance: PROVIDER_KEY, has_credits: true } }, 200);
    expect(quota.snapshot().get("x-codex-credits-balance")).toBeNull();
    expect(quota.snapshot().get("x-codex-credits-has-credits")).toBe("true");
  });
});
