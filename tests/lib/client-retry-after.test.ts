import { describe, expect, test } from "bun:test";
import { formatClientRetryAfter, MAX_CLIENT_RETRY_AFTER_SECONDS } from "../../src/lib/client-retry-after";

const now = Date.parse("2026-11-02T00:00:00Z");

describe("formatClientRetryAfter", () => {
  test("delay seconds become a proxy-formatted integer", () => {
    expect(formatClientRetryAfter("15", now)).toBe("15");
    expect(formatClientRetryAfter(" 15 ", now)).toBe("15");
    expect(formatClientRetryAfter("0", now)).toBe("0");
    expect(formatClientRetryAfter("000", now)).toBe("0");
    expect(formatClientRetryAfter("1.2", now)).toBe("2");
    expect(formatClientRetryAfter("007", now)).toBe("7");
    expect(formatClientRetryAfter(0, now)).toBe("0");
    expect(formatClientRetryAfter(7.01, now)).toBe("8");
  });

  test("long delays clamp to the client maximum", () => {
    expect(formatClientRetryAfter("600", now)).toBe("600");
    expect(formatClientRetryAfter(String(MAX_CLIENT_RETRY_AFTER_SECONDS), now)).toBe("3600");
    expect(formatClientRetryAfter("3601", now)).toBe("3600");
    // An all-digit value of credential length is a valid delay, but its bytes are never echoed.
    expect(formatClientRetryAfter("73915028461739205817", now)).toBe("3600");
    expect(formatClientRetryAfter(1e30, now)).toBe("3600");
  });

  test("HTTP dates become seconds from now", () => {
    expect(formatClientRetryAfter("Mon, 02 Nov 2026 00:00:30 GMT", now)).toBe("30");
    expect(formatClientRetryAfter("Mon, 02 Nov 2026 00:00:00 GMT", now)).toBe("0");
    expect(formatClientRetryAfter("Sun, 01 Nov 2026 23:00:00 GMT", now)).toBe("0");
    expect(formatClientRetryAfter("Tue, 03 Nov 2026 00:00:00 GMT", now)).toBe("3600");
  });

  test("anything else yields no advice", () => {
    for (const value of ["", "  ", "-1", "1e3", "Infinity", "NaN", "15s", "0x10", "must-not-echo",
      "2026-11-02T00:00:30Z", "Mon, 02 Nov 2026 00:00:30 GMT extra", "9".repeat(200), null, undefined,
      -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatClientRetryAfter(value as string | number | null | undefined, now)).toBeUndefined();
    }
  });
});
