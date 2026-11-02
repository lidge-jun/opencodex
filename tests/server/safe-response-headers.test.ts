import { describe, expect, test } from "bun:test";
import { CodexWsMetadata } from "../../src/server/responses/codex-ws-metadata";
import { isSafeResponseHeader, normalizeSafeResponseHeader, safeResponseHeaders } from "../../src/server/safe-response-headers";
import { buildWsErrorFrame } from "../../src/server/ws-bridge";

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

  test("rate-limit resets are rebuilt from whole units and clamp to eight days", () => {
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-requests", "6m0s")).toBe("6m0s");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-tokens", "1h2m3.5s")).toBe("1h2m4s");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-tokens", "20ms")).toBe("20ms");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-tokens", "0.5ms")).toBe("1ms");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset", "30")).toBe("30");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset", "2.75")).toBe("3");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset", "0")).toBe("0");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset", "-1")).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-ratelimit-reset", "soon")).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-ratelimit-reset", "900000000")).toBe("691200");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset", NUMERIC_KEY)).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-requests", PROVIDER_KEY)).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-requests", "999999h")).toBe("192h0m0s");
    expect(normalizeSafeResponseHeader("x-ratelimit-reset-requests", "")).toBeUndefined();
  });

  test("rate-limit counts are rebuilt as bounded non-negative integers", () => {
    const name = "x-ratelimit-limit";
    expect(normalizeSafeResponseHeader(name, "1.25")).toBe("1");
    expect(normalizeSafeResponseHeader(name, "0.999999")).toBe("0");
    expect(normalizeSafeResponseHeader(name, "-5")).toBeUndefined();
    expect(normalizeSafeResponseHeader(name, "NaN")).toBeUndefined();
    expect(normalizeSafeResponseHeader(name, "Infinity")).toBeUndefined();
    expect(normalizeSafeResponseHeader(name, "12 requests")).toBeUndefined();
    expect(normalizeSafeResponseHeader(name, "999999999999999")).toBe("1000000000000");
    expect(normalizeSafeResponseHeader(name, NUMERIC_KEY)).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-ratelimit-remaining-tokens", "4000.5")).toBe("4000");
    expect(normalizeSafeResponseHeader("x-codex-primary-window-minutes", "60.5")).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-codex-primary-reset-at", "1790000000")).toBe("1790000000");
  });

  test("header names that match Object.prototype members are never relayed", () => {
    const names = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"];
    for (const name of names) {
      expect(isSafeResponseHeader(name)).toBe(false);
      expect(normalizeSafeResponseHeader(name, PROVIDER_KEY)).toBeUndefined();
    }
    const headers = new Headers();
    for (const name of names.filter(name => name !== "__proto__" && name !== "__defineGetter__")) headers.set(name, PROVIDER_KEY);
    headers.set("x-ratelimit-remaining", "7");
    const frame = buildWsErrorFrame(429, { message: "Rate limited" }, headers);
    expect(frame.headers).toEqual({ "x-ratelimit-remaining": "7" });
    expect(JSON.stringify(frame)).not.toContain(PROVIDER_KEY);
  });

  test("the native WebSocket metadata path ignores prototype-member header names", () => {
    const owner = new CodexWsMetadata();
    owner.commit();
    const event = JSON.parse(
      '{"type":"codex.response.metadata","headers":{"constructor":"' + PROVIDER_KEY + '","__proto__":"' + PROVIDER_KEY
      + '","toString":"' + PROVIDER_KEY + '","hasOwnProperty":"' + PROVIDER_KEY + '","x-ratelimit-limit":"1.25"}}',
    ) as Record<string, unknown>;
    const text = owner.consume(event, 200);
    expect(text).toBe('{"type":"codex.response.metadata","headers":{"x-ratelimit-limit":"1"}}');
    expect(JSON.stringify([...owner.snapshot()])).not.toContain(PROVIDER_KEY);
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
