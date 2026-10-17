import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaBars from "../src/components/QuotaBars";
import { en } from "../src/i18n/en";
import { zh } from "../src/i18n/zh";
import { I18nContext, interpolate, type TFn } from "../src/i18n/shared";
import type { AccountQuota } from "../src/codex-quota-utils";

type Layout = "compact" | "stacked";
type Lang = "en" | "zh";
type Bucket = NonNullable<AccountQuota["creditBuckets"]>[number];

function render(quota: Partial<AccountQuota>, layout: Layout, lang: Lang = "en"): string {
  const dict = lang === "zh" ? zh : en;
  const t = ((key, vars) => interpolate(dict[key] ?? key, vars)) as TFn;
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ t, locale: lang, setLocale: () => {} }}>
      <QuotaBars quota={{ updatedAt: 1, ...quota }} threshold={80} layout={layout} t={t} />
    </I18nContext.Provider>,
  );
}

const credit = (used: number, limit: number, percent?: number): Bucket => ({
  kind: "addOnQuota", used, limit, remaining: limit - used,
  ...(percent === undefined ? {} : { percent }),
});
const withBucket = (bucket: Bucket) => ({ creditBuckets: [bucket] });

describe("QuotaBars credit bucket and regular quota boundaries", () => {
  test("0/0 displays No quota, not exhausted or a false percent, in both layouts/locales", () => {
    const quota = withBucket({ kind: "userQuota", used: 0, limit: 0, remaining: 0, percent: 0 });
    for (const layout of ["compact", "stacked"] as const) {
      for (const lang of ["en", "zh"] as const) {
        const markup = render(quota, layout, lang);
        expect(markup).toContain(lang === "zh" ? "无配额" : "No quota");
        expect(markup).not.toContain("bar-fill");
        expect(markup).not.toContain(lang === "zh" ? "已达上限" : "Limit reached");
        expect(markup).not.toContain(lang === "zh" ? "已用 0%" : "0% used");
        if (layout === "compact") expect(markup).not.toContain("0%");
      }
    }
  });

  test("real 0% retains an empty bar and does not become No quota", () => {
    const quota = withBucket(credit(0, 1000, 0));
    for (const layout of ["compact", "stacked"] as const) {
      const markup = render(quota, layout);
      expect(markup).toContain("0%");
      expect(markup).toContain("--bar-scale:0");
      expect(markup).not.toContain("No quota");
    }
  });

  for (const { used, percent, shown, scale } of [
    { used: 2, percent: 0.2, shown: "0%", scale: "0.002" },
    { used: 8, percent: 0.8, shown: "1%", scale: "0.008" },
    { used: 500, percent: 50, shown: "50%", scale: "0.5" },
  ]) {
    test(String(percent) + "% credit uses rounded text, exact bar width and no 4% floor", () => {
      const quota = withBucket(credit(used, 1000, percent));
      for (const layout of ["compact", "stacked"] as const) {
        const markup = render(quota, layout);
        expect(markup).toContain(shown);
        expect(markup).toContain("--bar-scale:" + scale);
        expect(markup).not.toContain("--bar-scale:0.04");
        expect(markup).not.toContain("&lt;1%");
      }
    });
  }

  test("missing percent shows used / limit but invents no progress bar", () => {
    for (const layout of ["compact", "stacked"] as const) {
      const markup = render(withBucket(credit(250, 1000)), layout);
      expect(markup).toContain("250 / 1,000");
      expect(markup).not.toContain("bar-fill");
      expect(markup).not.toContain("%");
    }
  });

  test("ordinary rate limit 0.8% rounds to 1% and keeps 4% visibility floor", () => {
    for (const layout of ["compact", "stacked"] as const) {
      const markup = render({ fiveHourPercent: 0.8 }, layout, "zh");
      expect(markup).toContain(layout === "stacked" ? "已用 1%" : "1%");
      expect(markup).toContain("--bar-scale:0.04");
    }
  });
});
