import { describe, expect, test } from "bun:test";
import { maskAccountId } from "../src/lib/privacy";

describe("maskAccountId", () => {
  test("redacts long account ids to account-…suffix", () => {
    expect(maskAccountId("acct_abcdefghijklmnopqrstuvwxyz")).toBe("account-…wxyz");
  });

  test("returns null for empty", () => {
    expect(maskAccountId(null)).toBeNull();
    expect(maskAccountId("")).toBeNull();
  });

  test("short ids still redact without leaking full value when length > 4", () => {
    expect(maskAccountId("abcdef")).toBe("account-…cdef");
  });

  test("ids of four characters or fewer never include the source identifier", () => {
    for (const id of ["a", "ab", "abc", "abcd"]) {
      const masked = maskAccountId(id);
      expect(masked).toBe("account-…");
      expect(masked!.endsWith(id)).toBe(false);
      expect(masked).not.toBe(id);
    }
  });
});
