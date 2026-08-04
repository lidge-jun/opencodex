import { expect, test } from "bun:test";

/**
 * D1a formatting: a window at or above 1 MiB is a whole "1M". Providers report 2^20
 * (1048576), and 1048576 / 1e6 = 1.048576 reads as a bug — that string must never ship.
 *
 * The helpers live inline in the page components, so this test re-implements the exact
 * arithmetic and asserts it; the mounted tests prove the page calls them.
 */

function format(value: number | undefined, t: (k: string, v: { n: number }) => string): string | null {
  if (!value) return null;
  if (value >= 1_048_576) return t("contextM", { n: Math.round(value / 1_048_576) });
  return value >= 1_000_000 ? t("contextM", { n: value / 1_000_000 }) : t("contextK", { n: Math.round(value / 1_000) });
}

const t = (key: string, v: { n: number }) => (key === "contextM" ? `${v.n}M context` : `${v.n}k context`);

test("1 MiB and above is a whole 1M, never 1.048576M", () => {
  expect(format(1_048_576, t)).toBe("1M context");
  expect(format(1_048_576 * 2, t)).toBe("2M context");
});

test("exactly 1M still renders 1M", () => {
  expect(format(1_000_000, t)).toBe("1M context");
});

test("sub-MiB windows keep the k formatting", () => {
  expect(format(200_000, t)).toBe("200k context");
  expect(format(372_000, t)).toBe("372k context");
  expect(format(983_616, t)).toBe("984k context");
});

test("no window is null, so the page shows the unknown marker", () => {
  expect(format(undefined, t)).toBeNull();
});
