/** Number and time formatting for the Live routing tab. All locale-aware, all Intl. */

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let cached = numberFormats.get(key);
  if (!cached) {
    cached = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, cached);
  }
  return cached;
}

export function formatDuration(ms: number, locale?: string): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) {
    return numberFormat(locale, { style: "unit", unit: "millisecond", unitDisplay: "narrow", maximumFractionDigits: 0 }).format(ms);
  }
  return numberFormat(locale, {
    style: "unit", unit: "second", unitDisplay: "narrow", maximumFractionDigits: ms < 10_000 ? 2 : 1,
  }).format(ms / 1000);
}

export function formatPercent(percent: number, locale?: string): string {
  return numberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(percent / 100);
}

export function formatRate(value: number, estimated: boolean, locale?: string): string {
  const digits = value >= 100 ? 0 : 1;
  const text = numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return estimated ? `~${text}` : text;
}

export function formatCount(value: number, locale?: string): string {
  return numberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatClock(timestamp: number, locale?: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString(locale, { hour12: false });
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

/** First 8 characters of an id: enough to tell sessions apart without printing the whole value. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
