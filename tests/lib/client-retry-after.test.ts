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
    expect(MAX_CLIENT_RETRY_AFTER_SECONDS).toBe(691_200);
    expect(formatClientRetryAfter("84692", now)).toBe("84692");
    expect(formatClientRetryAfter("172800", now)).toBe("172800");
    expect(formatClientRetryAfter("691200", now)).toBe("691200");
    expect(formatClientRetryAfter("691201", now)).toBe("691200");
    // An all-digit value of credential length is a valid delay, but its bytes are never echoed.
    expect(formatClientRetryAfter("73915028461739205817", now)).toBe("691200");
    expect(formatClientRetryAfter(1e30, now)).toBe("691200");
  });

  test("HTTP dates become seconds from now", () => {
    expect(formatClientRetryAfter("Mon, 02 Nov 2026 00:00:30 GMT", now)).toBe("30");
    expect(formatClientRetryAfter("Mon, 02 Nov 2026 00:00:00 GMT", now)).toBe("0");
    expect(formatClientRetryAfter("Sun, 01 Nov 2026 23:00:00 GMT", now)).toBe("0");
    expect(formatClientRetryAfter("Tue, 03 Nov 2026 00:00:00 GMT", now)).toBe("86400");
    expect(formatClientRetryAfter("Mon, 30 Nov 2026 00:00:00 GMT", now)).toBe("691200");
  });

  test("obsolete RFC 850 and asctime dates are read as GMT", () => {
    expect(formatClientRetryAfter("Monday, 02-Nov-26 00:00:30 GMT", now)).toBe("30");
    expect(formatClientRetryAfter("Sunday, 01-Nov-26 23:00:00 GMT", now)).toBe("0");
    // A two-digit year far in the future is the previous century, so it is already past.
    expect(formatClientRetryAfter("Friday, 02-Nov-99 00:00:30 GMT", now)).toBe("0");
    expect(formatClientRetryAfter("Mon Nov  2 00:00:30 2026", now)).toBe("30");
    expect(formatClientRetryAfter("Tue Nov 03 00:00:00 2026", now)).toBe("86400");
    expect(formatClientRetryAfter("Mon Feb 30 00:00:00 2026", now)).toBeUndefined();
    expect(formatClientRetryAfter("Monday, 02-Xyz-26 00:00:30 GMT", now)).toBeUndefined();
    expect(formatClientRetryAfter("Mon, 02 Nov 2026 25:00:00 GMT", now)).toBeUndefined();
  });

  test("anything else yields no advice", () => {
    for (const value of ["", "  ", "-1", "1e3", "Infinity", "NaN", "15s", "0x10", "must-not-echo",
      "2026-11-02T00:00:30Z", "Mon, 02 Nov 2026 00:00:30 GMT extra", "9".repeat(200), null, undefined,
      -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatClientRetryAfter(value as string | number | null | undefined, now)).toBeUndefined();
    }
  });
});
