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

const CREDIT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
};

const CREDIT_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function cachedDateFormatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = cacheKey(locale, options);
  let fmt = dateFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dateFormatters.set(key, fmt);
  }
  return fmt;
}

export function formatCreditDate(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return cachedDateFormatter(locale, CREDIT_DATE_OPTIONS).format(date);
}

export function formatCreditDateTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return cachedDateFormatter(locale, CREDIT_DATE_TIME_OPTIONS).format(date);
}

const USD_ESTIMATE_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/**
 * Format a USD cost estimate for display. Returns "—" when unavailable.
 * The amount is a fixed `$1.2345` regardless of locale: the Logs column header and the CLI
 * usage report both print `~$`, and `Intl` under ko/zh renders `US$`, which read as a
 * different unit. The locale parameter is kept so callers stay source-compatible.
 */
export function formatEstimatedUsdValue(value: number, _locale?: string): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  return `~${USD_ESTIMATE_FORMAT.format(value)}`;
}
