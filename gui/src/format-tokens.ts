/**
 * Locale-aware token-count formatting, shared by Dashboard/Usage/Logs.
 *
 * Western locales use the K/M/B/T thousands scale; CJK locales (ko/zh/zh-TW) use the
 * myriad (1e4) scale — ko 만/억/조/경, zh 万/亿/兆/京, zh-TW 萬/億/兆/京 — which reads
 * naturally there.
 */
const CJK_UNITS: Record<string, Array<{ v: number; s: string }>> = {
  ko: [{ v: 1e16, s: "경" }, { v: 1e12, s: "조" }, { v: 1e8, s: "억" }, { v: 1e4, s: "만" }],
  zh: [{ v: 1e16, s: "京" }, { v: 1e12, s: "兆" }, { v: 1e8, s: "亿" }, { v: 1e4, s: "万" }],
  "zh-TW": [{ v: 1e16, s: "京" }, { v: 1e12, s: "兆" }, { v: 1e8, s: "億" }, { v: 1e4, s: "萬" }],
};

/** Trim a trailing ".0"/".00" so 12.00만 renders as 12만. */
function trim(s: string): string {
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function formatTokens(n: number, locale: string): string {
  const units = CJK_UNITS[locale];
  if (units) {
    for (const u of units) {
      if (n >= u.v) {
        return `${trim((n / u.v).toFixed(1))}${u.s}`;
      }
    }
    return String(n);
  }
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${trim((n / 1000).toFixed(1))}K`;
  if (n < 1_000_000_000) return `${trim((n / 1_000_000).toFixed(1))}M`;
  if (n < 1_000_000_000_000) return `${trim((n / 1_000_000_000).toFixed(1))}B`;
  return `${trim((n / 1_000_000_000_000).toFixed(1))}T`;
}
