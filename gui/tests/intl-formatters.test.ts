import { describe, expect, test } from "bun:test";
import { formatCreditDate, formatCreditDateTime } from "../src/intl-formatters";

describe("credit date formatting", () => {
  test("keeps the compact date format for grant dates", () => {
    expect(formatCreditDate("2026-07-31T12:34:56Z")).not.toContain("12:34");
  });

  test("includes the local time for expiration dates", () => {
    const iso = "2026-07-31T12:34:56Z";

    expect(formatCreditDateTime(iso)).not.toBe(formatCreditDate(iso));
    expect(formatCreditDateTime(iso)).not.toBe("—");
  });

  test("handles invalid dates consistently", () => {
    expect(formatCreditDateTime("invalid")).toBe("—");
  });
});
