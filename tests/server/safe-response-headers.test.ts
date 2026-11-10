import { describe, expect, test } from "bun:test";
import { CodexWsMetadata } from "../../src/server/responses/codex-ws-metadata";
import { isSafeResponseHeader, normalizeSafeResponseHeader, safeResponseHeaders } from "../../src/server/safe-response-headers";
import { resolveTurnStateHandle } from "../../src/server/turn-state-handles";
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

  test("request ids, the models etag and quota limit labels are never relayed", () => {
    for (const name of ["x-request-id", "openai-request-id", "x-models-etag", "x-codex-primary-limit-name", "x-codex-bengalfox-limit-name"]) {
      expect(isSafeResponseHeader(name)).toBe(false);
      expect(normalizeSafeResponseHeader(name, "req_abc-123")).toBeUndefined();
    }
  });

  test("a model header is kept only as a model id the proxy already knows", () => {
    // A catalog model, and a requested model the send names, pass as the proxy's own copy.
    expect(normalizeSafeResponseHeader("openai-model", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeSafeResponseHeader("openai-model", "custom-model-1", { knownModels: ["custom-model-1"] })).toBe("custom-model-1");
    // A prefixless key fits the identifier grammar but names no known model, so it is dropped.
    for (const name of ["openai-model", "x-codex-safety-buffering-faster-model"]) {
      expect(normalizeSafeResponseHeader(name, PROVIDER_KEY)).toBeUndefined();
      expect(normalizeSafeResponseHeader(name, PROVIDER_KEY, { knownModels: ["gpt-5.5"] })).toBeUndefined();
      expect(normalizeSafeResponseHeader(name, "custom-model-1")).toBeUndefined();
    }
    expect(normalizeSafeResponseHeader("openai-model", "model+" + PROVIDER_KEY)).toBeUndefined();
  });

  test("the turn-state token is replaced by a handle bound to the send, or dropped without one", () => {
    const handle = normalizeSafeResponseHeader("x-codex-turn-state", PROVIDER_KEY, { turnStateBinding: "send-a" })!;
    expect(handle).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
    expect(handle).not.toContain(PROVIDER_KEY);
    expect(resolveTurnStateHandle(handle, "send-a")).toEqual({ value: PROVIDER_KEY });
    expect(resolveTurnStateHandle(handle, "send-b")).toEqual({ dropped: "mismatch" });
    // An already issued handle passes a second normalization; a raw token without a binding does not.
    expect(normalizeSafeResponseHeader("x-codex-turn-state", handle)).toBe(handle);
    expect(normalizeSafeResponseHeader("x-codex-turn-state", PROVIDER_KEY)).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-codex-turn-state", "bad value", { turnStateBinding: "send-a" })).toBeUndefined();
  });

  test("quota windows are relayed only for known limit families", () => {
    expect(normalizeSafeResponseHeader("x-codex-primary-used-percent", "5")).toBe("5");
    expect(normalizeSafeResponseHeader("x-codex-bengalfox-primary-used-percent", "5")).toBe("5");
    expect(normalizeSafeResponseHeader(`x-codex-${PROVIDER_KEY.toLowerCase()}-primary-used-percent`, "5")).toBeUndefined();
    expect(normalizeSafeResponseHeader("x-codex-extra-secondary-used-percent", "5")).toBeUndefined();
  });

  test("no upstream header bytes reach the WebSocket error frame or the metadata frame", () => {
    const upstreamHeaders: Record<string, string> = {
      "x-request-id": PROVIDER_KEY, "openai-request-id": PROVIDER_KEY, "x-models-etag": PROVIDER_KEY,
      "x-codex-turn-state": PROVIDER_KEY, "x-codex-primary-limit-name": PROVIDER_KEY, "x-codex-primary-reset-at": NUMERIC_KEY,
      "openai-model": PROVIDER_KEY, "x-codex-safety-buffering-faster-model": PROVIDER_KEY,
      [`x-codex-${PROVIDER_KEY.toLowerCase()}-primary-used-percent`]: "5", "x-ratelimit-remaining": "7",
    };
    const errorFrame = JSON.stringify(buildWsErrorFrame(429, { message: "Rate limited" }, new Headers(upstreamHeaders)));
    const owner = new CodexWsMetadata(undefined, { turnStateBinding: "send-a", knownModels: ["gpt-5.5"] });
    owner.commit();
    const metadataFrame = owner.consume({ type: "codex.response.metadata", headers: upstreamHeaders }, 700)!;
    const snapshot = JSON.stringify([...owner.snapshot()]);
    // Non-vacuous: each output carries the allowlisted count; the bound outputs carry the handle.
    expect(errorFrame).not.toContain("x-codex-turn-state");
    for (const text of [errorFrame, metadataFrame, snapshot]) {
      expect(text).toContain("x-ratelimit-remaining");
      if (text !== errorFrame) expect(text).toMatch(/ocx-ts-[0-9a-f]{32}/);
      expect(text).not.toContain("openai-model");
      expect(text.toLowerCase()).not.toContain(PROVIDER_KEY.toLowerCase());
      expect(text).not.toContain(NUMERIC_KEY);
    }
  });

  test("the codex.rate_limits frame is rebuilt from known fields with bounded values", () => {
    const owner = new CodexWsMetadata();
    owner.commit();
    const text = owner.consume({
      type: "codex.rate_limits", secret: PROVIDER_KEY, nested: { deeper: { key: PROVIDER_KEY } },
      plan_type: "plus", metered_limit_name: "codex_bengalfox", limit_name: PROVIDER_KEY,
      rate_limits: {
        allowed: true, limit_reached: false, extra: PROVIDER_KEY,
        primary: { used_percent: 33.333333, window_minutes: 300, reset_at: 1_900_000_000, note: PROVIDER_KEY },
        secondary: { used_percent: Number(NUMERIC_KEY), window_minutes: Number(NUMERIC_KEY), reset_at: 1.5 },
      },
      credits: { has_credits: true, unlimited: false, balance: "12.50", owner: PROVIDER_KEY },
    }, 900)!;
    expect(JSON.parse(text)).toEqual({
      type: "codex.rate_limits", plan_type: "plus", metered_limit_name: "codex_bengalfox",
      rate_limits: {
        allowed: true, limit_reached: false,
        primary: { used_percent: 33.33, window_minutes: 300, reset_at: 1_900_000_000 },
        secondary: { used_percent: 100 },
      },
      credits: { has_credits: true, unlimited: false },
    });
    // The balance reaches clients only as the proxy-formatted header.
    expect(owner.snapshot().get("x-codex-credits-balance")).toBe("12.5");
    expect(owner.snapshot().get("x-codex-bengalfox-secondary-used-percent")).toBe("100");
    for (const output of [text, JSON.stringify([...owner.snapshot()])]) {
      expect(output).not.toContain(PROVIDER_KEY);
      expect(output).not.toContain(NUMERIC_KEY.slice(0, 12));
    }
  });

  test("every retained rate-limit field drops a prefixless key", () => {
    const owner = new CodexWsMetadata();
    owner.commit();
    const text = owner.consume({
      type: "codex.rate_limits", plan_type: PROVIDER_KEY, metered_limit_name: PROVIDER_KEY,
      rate_limits: { allowed: PROVIDER_KEY, primary: { used_percent: 5, reset_at: Number(NUMERIC_KEY) } },
      credits: { has_credits: PROVIDER_KEY, balance: NUMERIC_KEY },
    }, 600)!;
    // An unknown limit id drops its windows rather than relabelling them as ordinary quota.
    expect(JSON.parse(text)).toEqual({ type: "codex.rate_limits", rate_limits: {}, credits: {} });
    expect([...owner.snapshot()]).toHaveLength(0);
    const ordinary = owner.consume({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 5, reset_at: Number(NUMERIC_KEY) } } }, 200)!;
    expect(JSON.parse(ordinary)).toEqual({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 5 } } });
    expect([...owner.snapshot()]).toEqual([["x-codex-primary-used-percent", "5"]]);
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
