import { describe, expect, test } from "bun:test";
import { formatTokens, formatTokensWithCache } from "../../gui/src/format-tokens";

/**
 * A cached request's total is mostly cache. The logs table has always shown the
 * total with a stacked `c <read>`; every other surface printed the total alone,
 * which reads as a different, smaller request than the rows beside it.
 */
describe("formatTokensWithCache", () => {
  test("renders the cached subset beside the total in both number scales", () => {
    expect(formatTokensWithCache(58_000, 57_000, "ko")).toBe("5.8만 c5.7만");
    expect(formatTokensWithCache(58_000, 57_000, "en")).toBe("58K c57K");
    expect(formatTokensWithCache(58_000, 57_000, "zh")).toBe("5.8万 c5.7万");
  });

  test("a provider that reports no cache is left exactly as it was", () => {
    for (const cached of [undefined, 0, Number.NaN]) {
      expect(formatTokensWithCache(58_000, cached, "ko")).toBe(formatTokens(58_000, "ko"));
    }
    // A negative count is nonsense rather than a cache miss; treat it as absent.
    expect(formatTokensWithCache(58_000, -1, "en")).toBe("58K");
  });

  test("a turn served entirely from cache still shows the marker", () => {
    // This is the most cached row on the page. Hiding the companion when the
    // subset equals the total would blank exactly the case worth showing.
    expect(formatTokensWithCache(57_000, 57_000, "en")).toBe("57K c57K");
  });
});
