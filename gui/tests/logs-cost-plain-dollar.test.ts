import { describe, expect, test } from "bun:test";
import { DICTS } from "../src/i18n/catalogs";
import { interpolate, type Locale, type TFn } from "../src/i18n/shared";
import { formatEstimatedUsdValue as formatLogsUsd } from "../src/pages/logs-cost-format";
import { formatEstimatedUsdValue as formatUsageUsd } from "../src/intl-formatters";

const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  ko: "ko-KR",
  ja: "ja-JP",
  zh: "zh-CN",
  "zh-TW": "zh-TW",
  de: "de-DE",
  fr: "fr-FR",
  ru: "ru-RU",
  tr: "tr-TR",
};

function translator(locale: Locale): TFn {
  return (key, vars) => interpolate(DICTS[locale][key], vars);
}

/**
 * The Logs column header is the untranslated `~$`. Under it, `약 US$0.1401` (ko), `0,1401 $US`
 * (fr) and `ca. 0,1401 $` (de) each read as a different unit. Every locale now renders the same
 * `$0.1401`, with `≥` as the only allowed prefix (priority lower bound).
 */
describe("Logs cost cells are a plain dollar amount in every locale", () => {
  const locales = Object.keys(DICTS) as Locale[];

  test("covers every shipped locale", () => {
    expect(locales.sort()).toEqual(Object.keys(LOCALE_TAGS).sort());
  });

  for (const locale of locales) {
    test(`${locale}: ordinary estimate is $n.nnnn, lower bound is ≥$n.nnnn`, () => {
      const t = translator(locale);
      expect(formatLogsUsd(0.1401, t, LOCALE_TAGS[locale], false)).toBe("$0.1401");
      expect(formatLogsUsd(0.1401, t, LOCALE_TAGS[locale], true)).toBe("≥$0.1401");
      expect(formatLogsUsd(1234.5, t, LOCALE_TAGS[locale], false)).toBe("$1,234.5000");
    });

    test(`${locale}: the cost templates carry no prose or currency code`, () => {
      expect(DICTS[locale]["logs.cost.approximate"]).toBe("{amount}");
      expect(DICTS[locale]["logs.cost.lowerBound"]).toBe("≥{amount}");
    });
  }
});

describe("Usage total estimate keeps ~ and the same fixed dollar shape", () => {
  for (const [locale, tag] of Object.entries(LOCALE_TAGS)) {
    test(`${locale}`, () => {
      expect(formatUsageUsd(0.1401, tag)).toBe("~$0.1401");
    });
  }
  test("unavailable stays an em dash", () => {
    expect(formatUsageUsd(Number.NaN)).toBe("\u2014");
    expect(formatUsageUsd(-1)).toBe("\u2014");
  });
});
