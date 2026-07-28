/** Cached Intl formatters — avoids reconstructing on every render/call. */

const numberFormatters = new Map<string, Intl.NumberFormat>();

function cacheKey(locale: string | undefined, options: object): string {
  return `${locale ?? ""}\0${JSON.stringify(options)}`;
}

export function cachedNumberFormat(
  locale: string | undefined,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = cacheKey(locale, options ?? {});
  let fmt = numberFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, options);
    numberFormatters.set(key, fmt);
  }
  return fmt;
}

const CREDIT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const CREDIT_DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatCreditDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return CREDIT_DATE_FORMAT.format(date);
}

export function formatCreditDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return CREDIT_DATE_TIME_FORMAT.format(date);
}

/** Format a USD cost estimate for display. Returns "—" when unavailable. */
export function formatEstimatedUsdValue(value: number, locale?: string): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  const formatted = cachedNumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value);
  return `~${formatted}`;
}
