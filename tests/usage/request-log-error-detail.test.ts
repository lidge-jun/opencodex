import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFinalRequestLog, addRequestLog, clearRequestLogsForTests, getRequestLogEntries, requestLogEntryFromPersistedUsage,
  type RequestLogContext, type RequestLogEntry,
} from "../../src/server/request-log";
import { recordLocalFailureDetail, recordUpstreamValidationDetail } from "../../src/server/request-log-failure-detail";
import {
  appendUsageEntry, readUsageEntries, resetUsageReadCacheForTests, usageLogPath, type PersistedUsageEntry,
} from "../../src/usage/log";
import {
  boundedRateLimitResetAt, deriveRateLimitResetAt, errorDetailFor, LOG_ERROR_CODES, normalizeLogErrorCode,
  projectErrorDetail, RATE_LIMIT_RESET_MAX_MS,
} from "../../src/usage/error-detail";
import { museLimitReport } from "../../gui/src/muse-limit-observation";
import { requestLogDto } from "../../src/server/management/shared";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { log } from "../helpers/request-log-entry";

// A provider key with no recognizable prefix, so pattern-based redaction cannot spot it.
const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const NUMERIC_KEY = "73915028461739205817";
const UPSTREAM_TEXT = {
  upstreamError: "invalid key " + PROVIDER_KEY + " " + NUMERIC_KEY,
  upstreamErrorCode: PROVIDER_KEY,
  upstreamErrorType: "invalid_request_error",
  upstreamRequestId: PROVIDER_KEY,
};

function withHome<T>(run: () => T): T {
  const previous = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-error-detail-unit-"));
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  try {
    return run();
  } finally {
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
}

function persisted(): string {
  return readFileSync(usageLogPath(), "utf8");
}

describe("normalizeLogErrorCode", () => {
  test("vocabulary codes and proxy-formatted status codes are kept", () => {
    for (const code of LOG_ERROR_CODES) expect(normalizeLogErrorCode(code, 500)).toBe(code);
    expect(normalizeLogErrorCode("http_418", 418)).toBe("http_418");
  });

  test("anything else collapses to the proxy's code for the status", () => {
    expect(normalizeLogErrorCode(PROVIDER_KEY, 400)).toBe("invalid_request_error");
    expect(normalizeLogErrorCode(PROVIDER_KEY, 401)).toBe("invalid_api_key");
    expect(normalizeLogErrorCode(PROVIDER_KEY, 403)).toBe("permission_denied");
    expect(normalizeLogErrorCode(PROVIDER_KEY, 429)).toBe("rate_limit_exceeded");
    expect(normalizeLogErrorCode(PROVIDER_KEY, 499)).toBe("client_closed_request");
    expect(normalizeLogErrorCode(PROVIDER_KEY, 503)).toBe("server_is_overloaded");
    expect(normalizeLogErrorCode(PROVIDER_KEY, 502)).toBe("upstream_server_error");
    expect(normalizeLogErrorCode(PROVIDER_KEY, 422)).toBe("http_422");
    expect(normalizeLogErrorCode(PROVIDER_KEY, 200)).toBe("upstream_error");
    expect(normalizeLogErrorCode(PROVIDER_KEY)).toBe("upstream_error");
    expect(normalizeLogErrorCode("http_999", 500)).toBe("upstream_server_error");
    expect(normalizeLogErrorCode("constructor", 400)).toBe("invalid_request_error");
    expect(normalizeLogErrorCode(undefined, 500)).toBeUndefined();
    expect(normalizeLogErrorCode("", 500)).toBeUndefined();
  });
});

describe("errorDetailFor", () => {
  test("a failed row with upstream evidence gets a condition and no upstream text", () => {
    const detail = errorDetailFor({ status: 403, errorCode: PROVIDER_KEY, upstreamError: "User location is not supported", ...{ upstreamErrorCode: PROVIDER_KEY } });
    expect(detail).toEqual({ errorCode: "permission_denied", upstreamCondition: "location_unsupported" });
  });

  test("local refusals and successes get no condition", () => {
    expect(errorDetailFor({ status: 503, errorCode: "server_busy" })).toEqual({ errorCode: "server_busy" });
    expect(errorDetailFor({ status: 200, upstreamError: "rate limit" })).toEqual({});
    expect(errorDetailFor({ status: 200, terminalStatus: "incomplete", upstreamError: "Output reached the requested token limit" })).toEqual({});
    // A client close is not an upstream condition, whatever text the context captured.
    expect(errorDetailFor({ status: 499, upstreamError: "client closed request" })).toEqual({});
    expect(errorDetailFor({ status: 502, errorCode: "client_closed_request", upstreamError: "x" })).toEqual({ errorCode: "client_closed_request" });
  });

  test("a recorded condition is kept only when it is a known member", () => {
    expect(errorDetailFor({ status: 429, upstreamCondition: "billing_exhausted", upstreamError: "rate limit" }).upstreamCondition).toBe("billing_exhausted");
    expect(errorDetailFor({ status: 429, upstreamCondition: PROVIDER_KEY }).upstreamCondition).toBeUndefined();
    // A recorded condition follows the derivation rules: none on a success or a client close.
    expect(errorDetailFor({ status: 200, upstreamCondition: "rate_limited" }).upstreamCondition).toBeUndefined();
    expect(errorDetailFor({ status: 499, upstreamCondition: "rate_limited" }).upstreamCondition).toBeUndefined();
    expect(errorDetailFor({ status: 429, upstreamCondition: "constructor", upstreamError: "x" }).upstreamCondition).toBe("rate_limited");
  });

  test("only closed proxy sentences become failure detail, rebuilt from their bounded number", () => {
    expect(errorDetailFor({ status: 504, upstreamError: "Provider response-header timeout after 0300ms during web-search" }).failureDetail)
      .toEqual({ code: "header_timeout", value: 300 });
    expect(errorDetailFor({ status: 502, upstreamError: "Provider connect timeout after 15000ms" }).failureDetail)
      .toEqual({ code: "connect_timeout", value: 15000 });
    expect(errorDetailFor({ status: 499, upstreamError: "client closed request during web-search" }).failureDetail)
      .toEqual({ code: "client_closed" });
    for (const text of ["Provider connect timeout after " + NUMERIC_KEY + "ms", "x Provider connect timeout after 1ms",
      "Provider connect timeout after 1ms " + PROVIDER_KEY, "invalid key " + PROVIDER_KEY]) {
      expect(errorDetailFor({ status: 502, upstreamError: text }).failureDetail).toBeUndefined();
    }
  });

  test("failure detail is a closed code with bounded parameters; free text never survives", () => {
    expect(errorDetailFor({ status: 504, failureDetail: "anthropic passthrough timed out " + PROVIDER_KEY }).failureDetail).toBeUndefined();
    expect(errorDetailFor({ status: 504, failureDetail: { code: PROVIDER_KEY } }).failureDetail).toBeUndefined();
    expect(errorDetailFor({ status: 504, failureDetail: { code: "constructor" } }).failureDetail).toBeUndefined();
    expect(errorDetailFor({ status: 504, failureDetail: { code: "body_stall", value: 1000 } }).failureDetail)
      .toEqual({ code: "body_stall", value: 1000 });
    // Extra keys, unsafe numbers and unknown types are dropped from an otherwise valid detail.
    expect(errorDetailFor({ status: 502, failureDetail: { code: "body_overflow", value: Number(NUMERIC_KEY), note: PROVIDER_KEY } }).failureDetail)
      .toEqual({ code: "body_overflow" });
    expect(errorDetailFor({ status: 400, failureDetail: { code: "provider_error", type: PROVIDER_KEY } }).failureDetail)
      .toEqual({ code: "provider_error" });
    expect(errorDetailFor({ status: 400, failureDetail: { code: "provider_error", type: "permission_error" } }).failureDetail)
      .toEqual({ code: "provider_error", type: "permission_error" });
    expect(errorDetailFor({ status: 400, failureDetail: { code: "client_closed", value: 5 } }).failureDetail)
      .toEqual({ code: "client_closed" });
  });
});

describe("Meta Muse reset time", () => {
  const timestamp = Date.parse("2026-10-25T19:08:28Z");
  const resetAt = Date.parse("2026-10-26T00:00:00Z");
  const row = { provider: "meta-muse", status: 429, errorCode: "rate_limit_exceeded", timestamp,
    upstreamError: "Subscription quota exhausted. Your usage window resets at 2026-10-26T00:00:00Z." };

  test("only the exact sentence on a Muse 429 yields a bounded reset time", () => {
    expect(deriveRateLimitResetAt(row)).toBe(resetAt);
    for (const invalid of [{ ...row, provider: "xai" }, { ...row, status: 400 }, { ...row, errorCode: "insufficient_quota" },
      { ...row, upstreamError: row.upstreamError + " " }, { ...row, upstreamError: "prefix " + row.upstreamError },
      { ...row, upstreamError: "Subscription quota exhausted. Your usage window resets at 2099-10-26T00:00:00Z." },
      { ...row, upstreamError: "Subscription quota exhausted. Your usage window resets at 2026-10-25T00:00:00Z." },
      { ...row, timestamp: Number.NaN }]) expect(deriveRateLimitResetAt(invalid)).toBeUndefined();
  });

  test("stored reset times are kept only inside the eight-day window", () => {
    expect(boundedRateLimitResetAt(timestamp + RATE_LIMIT_RESET_MAX_MS, timestamp)).toBe(timestamp + RATE_LIMIT_RESET_MAX_MS);
    expect(boundedRateLimitResetAt(timestamp + RATE_LIMIT_RESET_MAX_MS + 1, timestamp)).toBeUndefined();
    expect(boundedRateLimitResetAt(timestamp, timestamp)).toBeUndefined();
    expect(boundedRateLimitResetAt(timestamp + 0.5, timestamp)).toBeUndefined();
    expect(boundedRateLimitResetAt(String(resetAt), timestamp)).toBeUndefined();
  });

  test("derive, persist, hydrate and render without the sentence", () => withHome(() => {
    addRequestLog(log({ requestId: "muse-reset", ...row, accountLogLabel: "o527765" }));
    const live = getRequestLogEntries().find(entry => entry.requestId === "muse-reset")!;
    expect(live.rateLimitResetAt).toBe(resetAt);
    expect(JSON.stringify(live)).not.toContain("Subscription quota exhausted");
    expect(persisted()).not.toContain("Subscription quota exhausted");
    const hydrated = requestLogEntryFromPersistedUsage(readUsageEntries().find(entry => entry.requestId === "muse-reset")!);
    expect(hydrated.rateLimitResetAt).toBe(resetAt);
    const report = museLimitReport(JSON.parse(JSON.stringify(hydrated)), "o527765", timestamp + 1000);
    expect(report?.quota?.customWindows?.[0]?.resetAt).toBe(resetAt);
  }));

  test("a legacy persisted sentence is recovered as the numeric reset on hydration", () => withHome(() => {
    const legacy = { requestId: "muse-legacy", timestamp, provider: "meta-muse", model: "m", status: 429, durationMs: 1,
      usageStatus: "unreported", errorCode: "rate_limit_exceeded", accountLogLabel: "o527765", upstreamError: row.upstreamError };
    writeFileSync(usageLogPath(), JSON.stringify(legacy) + "\n", { mode: 0o600 });
    resetUsageReadCacheForTests();
    const hydrated = requestLogEntryFromPersistedUsage(readUsageEntries().find(entry => entry.requestId === "muse-legacy")!);
    expect(hydrated.rateLimitResetAt).toBe(resetAt);
    expect((hydrated as Record<string, unknown>).upstreamError).toBeUndefined();
  }));
});

describe("request-log rows keep only proxy-owned error facts", () => {
  test("direct addRequestLog drops upstream text from the live row, ledger and hydration", () => withHome(() => {
    const attempt = { ordinal: 1, provider: "openai", model: "model", adapter: "openai-chat", status: 400, durationMs: 1,
      sendCount: 1, recoveryKinds: [], usageStatus: "unreported" as const, errorCode: PROVIDER_KEY, ...UPSTREAM_TEXT };
    addRequestLog(log({ requestId: "canary-direct", status: 400, errorCode: PROVIDER_KEY, attempts: [attempt], ...UPSTREAM_TEXT }));
    const live = getRequestLogEntries().find(entry => entry.requestId === "canary-direct")!;
    expect(JSON.stringify(live)).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(live)).not.toContain(NUMERIC_KEY);
    expect(live.errorCode).toBe("invalid_request_error");
    expect(live.attempts?.[0]?.errorCode).toBe("invalid_request_error");
    expect(live.upstreamCondition).toBe("request_rejected");
    const dto = JSON.stringify(requestLogDto(live));
    expect(dto).not.toContain(PROVIDER_KEY);
    expect(dto).not.toContain(NUMERIC_KEY);
    for (const field of ["upstreamError", "upstreamErrorCode", "upstreamErrorType", "upstreamRequestId"]) {
      expect((live as Record<string, unknown>)[field]).toBeUndefined();
    }
    expect(persisted()).not.toContain(PROVIDER_KEY);
    expect(persisted()).not.toContain(NUMERIC_KEY);
    const hydrated = requestLogEntryFromPersistedUsage(readUsageEntries().find(entry => entry.requestId === "canary-direct")!);
    expect(JSON.stringify(hydrated)).not.toContain(PROVIDER_KEY);
    expect(hydrated.upstreamCondition).toBe("request_rejected");
  }));

  test("direct appendUsageEntry never writes upstream text", () => withHome(() => {
    appendUsageEntry({ requestId: "canary-append", timestamp: Date.now(), provider: "openai", model: "m", status: 502,
      durationMs: 1, usageStatus: "unreported", errorCode: PROVIDER_KEY, ...UPSTREAM_TEXT } as unknown as PersistedUsageEntry);
    expect(persisted()).not.toContain(PROVIDER_KEY);
    expect(persisted()).not.toContain(NUMERIC_KEY);
    const row = JSON.parse(persisted().trim()) as Record<string, unknown>;
    expect(row.errorCode).toBe("upstream_server_error");
    expect(row.upstreamCondition).toBe("upstream_failed");
  }));

  test("legacy rows holding upstream text hydrate to closed facts only", () => withHome(() => {
    const legacy = { requestId: "canary-legacy", timestamp: Date.now(), provider: "openai", model: "m", status: 403,
      durationMs: 1, usageStatus: "unreported", errorCode: PROVIDER_KEY,
      upstreamError: "Your organization must be verified " + PROVIDER_KEY, upstreamErrorCode: PROVIDER_KEY, upstreamRequestId: PROVIDER_KEY };
    writeFileSync(usageLogPath(), JSON.stringify(legacy) + "\n", { mode: 0o600 });
    resetUsageReadCacheForTests();
    const entry = readUsageEntries().find(row => row.requestId === "canary-legacy")!;
    expect(JSON.stringify(entry)).not.toContain(PROVIDER_KEY);
    const hydrated = requestLogEntryFromPersistedUsage(entry);
    expect(JSON.stringify(hydrated)).not.toContain(PROVIDER_KEY);
    expect(hydrated.errorCode).toBe("permission_denied");
    expect(hydrated.upstreamCondition).toBe("account_verification_required");
  }));

  test("a local diagnostic is failure detail, not upstream evidence", () => {
    const final = (record: (ctx: RequestLogContext) => void, status: number) => {
      const ctx: RequestLogContext = { model: "m", provider: "anthropic-native" };
      record(ctx);
      const rows: RequestLogEntry[] = [];
      addFinalRequestLog("local-" + status, Date.now(), ctx, status, { closeReason: "non_stream" }, row => rows.push(row));
      return rows[0]!;
    };
    const timeout = final(ctx => recordLocalFailureDetail(ctx, "anthropic passthrough timed out waiting for response headers",
      { code: "header_timeout" }), 504);
    expect(timeout.failureDetail).toEqual({ code: "header_timeout" });
    expect(timeout.upstreamCondition).toBeUndefined();
    const restated = final(ctx => recordLocalFailureDetail(ctx, "Provider error 429: rate_limit_error",
      { code: "provider_error", type: "rate_limit_error" }, { upstreamEvidence: true }), 429);
    expect(restated.failureDetail).toEqual({ code: "provider_error", type: "rate_limit_error" });
    expect(restated.upstreamCondition).toBe("rate_limited");
  });

  test("projection keeps identity when nothing changes", () => {
    const entry = log({ requestId: "unchanged", status: 503, errorCode: "server_busy" });
    expect(projectErrorDetail(entry)).toBe(entry);
    const changed = log({ requestId: "changed", status: 503, errorCode: "server_busy", ...UPSTREAM_TEXT });
    expect(projectErrorDetail(changed)).not.toBe(changed);
  });
});

describe("closed upstream validation detail", () => {
  test("keeps only known fields and validation types through projection and usage hydration", () => withHome(() => {
    const validation = [{ field: "max_completion_tokens", type: "extra_forbidden" }, { field: "messages.role", type: "union_tag_invalid" }];
    const entry = { ...log({ status: 422 }), failureDetail: { code: "provider_error", type: "invalid_request_error", validation,
      message: PROVIDER_KEY, input: "private prompt" } };
    addRequestLog(entry as RequestLogEntry);
    const row = getRequestLogEntries().at(-1)!;
    expect(row.failureDetail).toEqual({ code: "provider_error", type: "invalid_request_error", validation });
    appendUsageEntry(row as unknown as PersistedUsageEntry);
    const disk = readUsageEntries().at(-1)!;
    expect(disk.failureDetail).toEqual(row.failureDetail);
    expect(requestLogEntryFromPersistedUsage(disk).failureDetail).toEqual(row.failureDetail);
    expect(persisted()).not.toContain(PROVIDER_KEY);
    expect(persisted()).not.toContain("private prompt");
  }));

  test("discards unknown names, types, free text and oversized lists", () => {
    const validation = [{ field: PROVIDER_KEY, type: "extra_forbidden" }, { field: "user", type: PROVIDER_KEY },
      ...Array.from({ length: 20 }, () => ({ field: "store", type: "extra_forbidden", input: PROVIDER_KEY }))];
    const projected = errorDetailFor({ status: 422, failureDetail: { code: "provider_error", validation } });
    expect(projected.failureDetail).toEqual({ code: "provider_error", validation: [{ field: "store", type: "extra_forbidden" }] });
    expect(JSON.stringify(projected)).not.toContain(PROVIDER_KEY);
    expect(errorDetailFor({ failureDetail: { code: "body_stall", value: 1, validation } }).failureDetail).toEqual({ code: "body_stall", value: 1 });
  });
});

test("validation capture requires a 4xx and bounds unique pairs", () => {
  const payload = { detail: ["user", "store", "thinking", "reasoning", "top_k", "max_tokens", "max_completion_tokens", "temperature", "top_p"].map(field => ({ loc: ["body", field], type: "extra_forbidden", input: PROVIDER_KEY })) };
  const ctx: RequestLogContext = {};
  recordUpstreamValidationDetail(ctx, 500, payload);
  expect(ctx.failureDetail).toBeUndefined();
  recordUpstreamValidationDetail(ctx, 200, payload);
  expect(ctx.failureDetail).toBeUndefined();
  recordUpstreamValidationDetail(ctx, 422, JSON.stringify(payload));
  expect(ctx.failureDetail?.validation).toHaveLength(8);
  expect(JSON.stringify(ctx.failureDetail)).not.toContain(PROVIDER_KEY);
});

test("validation capture distinguishes nested locations without arbitrary keys", () => {
  const ctx: RequestLogContext = {};
  recordUpstreamValidationDetail(ctx, 422, { detail: [
    { loc: ["body", "messages"], type: "extra_forbidden" },
    { loc: ["body", "messages", 0, "content"], type: "extra_forbidden" },
    { loc: ["body", "messages", 0, PROVIDER_KEY], type: "extra_forbidden" },
    { loc: ["body", "tools", 0, "function", "parameters", PROVIDER_KEY], type: "extra_forbidden" },
  ] });
  expect(ctx.failureDetail?.validation).toEqual([
    { field: "messages", type: "extra_forbidden" }, { field: "messages.content", type: "extra_forbidden" },
    { field: "messages.*", type: "extra_forbidden" }, { field: "tools.*", type: "extra_forbidden" },
  ]);
  expect(JSON.stringify(ctx.failureDetail)).not.toContain(PROVIDER_KEY);
});

test("validation capture preserves only an allowlisted upstream error type", () => {
  const detail = [{ loc: ["body", "store"], type: "extra_forbidden" }];
  for (const [payload, expected] of [
    [{ detail, type: "permission_error" }, "permission_error"],
    [{ detail, error: { type: "authentication_error" } }, "authentication_error"],
    [{ detail, type: PROVIDER_KEY }, undefined], [{ detail }, undefined],
  ] as const) {
    const ctx: RequestLogContext = {};
    recordUpstreamValidationDetail(ctx, 422, payload);
    expect(ctx.failureDetail?.type).toBe(expected);
    expect(ctx.failureDetail?.validation).toEqual([{ field: "store", type: "extra_forbidden" }]);
  }
});
