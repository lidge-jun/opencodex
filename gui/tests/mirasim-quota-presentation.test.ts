import { expect, test } from "bun:test";
import { buildQuotaRows } from "../src/components/QuotaBars";
import { DICTS, type Locale, type TFn, type TKey } from "../src/i18n/shared";

function tFor(locale: Locale): TFn {
  return ((key: TKey) => DICTS[locale][key]) as TFn;
}

const CASES = [
  {
    locale: "en",
    labels: ["5-hour limit", "Weekly limit", "Claude · Weekly limit", "Fable · Weekly limit", "Sonnet · Weekly limit"],
  },
  {
    locale: "zh-TW",
    labels: ["5 小時限額", "每週限額", "Claude · 每週限額", "Fable · 每週限額", "Sonnet · 每週限額"],
  },
  {
    locale: "zh",
    labels: ["5 小时限额", "每周限额", "Claude · 每周限额", "Fable · 每周限额", "Sonnet · 每周限额"],
  },
] as const satisfies readonly { locale: Locale; labels: readonly string[] }[];

for (const { locale, labels } of CASES) {
  test(`Mirasim quota rows are localized without raw internal labels in ${locale}`, () => {
    const rows = buildQuotaRows({
      fiveHourPercent: 0.4,
      fiveHourResetAt: 1_800_000_000_000,
      weeklyPercent: 0.1,
      weeklyResetAt: 1_900_000_000_000,
      customWindows: [
        { label: "Model · 7d_claude", percent: 0.5, resetAt: 1_900_000_000_000 },
        { label: "Model · 7d_fable", percent: 0, resetAt: 1_900_000_000_000 },
        { label: "Model · 7d-sonnet", percent: 0.25, resetAt: 1_900_000_000_000 },
      ],
      updatedAt: Date.now(),
    }, null, tFor(locale));

    expect(rows.map(row => row.limitLabel)).toEqual(labels);
    expect(rows.some(row => row.limitLabel === "5h" || row.limitLabel === "7d")).toBe(false);
    expect(rows.some(row => row.limitLabel.startsWith("Model ·"))).toBe(false);
  });
}
