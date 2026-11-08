/** Bounded decimal arithmetic for WorkBuddy's informational credit balances. */
export interface WorkBuddyDecimal { digits: bigint; scale: number }

const MAX_DECIMAL_LENGTH = 384;
const MAX_SCALE = 324;

/** Parse the original decimal string, or the decimal representation of an already parsed number. */
export function parseWorkBuddyDecimal(value: unknown): WorkBuddyDecimal | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)) return undefined;
  const text = String(value);
  if (text.length > MAX_DECIMAL_LENGTH) return undefined;
  // Exponents are accepted only for numbers: the public provider input accepts decimal strings.
  const match = (typeof value === "number" ? /^(\d+)(?:\.(\d+))?(?:e([+-]?\d{1,3}))?$/i : /^(\d+)(?:\.(\d+))?$/).exec(text);
  if (!match) return undefined;
  const exponent = Number(match[3] ?? 0);
  let scale = (match[2]?.length ?? 0) - exponent;
  if (Math.abs(exponent) > MAX_SCALE || scale > MAX_SCALE || scale < -MAX_SCALE) return undefined;
  let digits = BigInt(`${match[1]}${match[2] ?? ""}`);
  if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && digits % 10n === 0n) { digits /= 10n; scale--; }
  return { digits, scale };
}

export function sumWorkBuddyDecimals(values: readonly WorkBuddyDecimal[]): WorkBuddyDecimal {
  const scale = values.reduce((max, value) => Math.max(max, value.scale), 0);
  const digits = values.reduce((sum, value) => sum + value.digits * 10n ** BigInt(scale - value.scale), 0n);
  return { digits, scale };
}

export function subtractWorkBuddyDecimals(total: WorkBuddyDecimal, ...values: WorkBuddyDecimal[]): WorkBuddyDecimal {
  const scale = [total, ...values].reduce((max, value) => Math.max(max, value.scale), 0);
  const scaled = (value: WorkBuddyDecimal) => value.digits * 10n ** BigInt(scale - value.scale);
  const digits = values.reduce((left, value) => left - scaled(value), scaled(total));
  return { digits: digits > 0n ? digits : 0n, scale };
}

export function formatWorkBuddyDecimal(value: WorkBuddyDecimal): string {
  let digits = value.digits, scale = value.scale;
  while (scale > 0 && digits % 10n === 0n) { digits /= 10n; scale--; }
  const text = digits.toString().padStart(scale + 1, "0");
  return scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text;
}

/** Nearest integer, with an exact half rounded up; caller validates the balance. */
export function roundedWorkBuddyUnavailable(total: WorkBuddyDecimal, remaining: WorkBuddyDecimal): number {
  const scale = Math.max(total.scale, remaining.scale);
  const totalDigits = total.digits * 10n ** BigInt(scale - total.scale);
  const remainingDigits = remaining.digits * 10n ** BigInt(scale - remaining.scale);
  const available = remainingDigits > totalDigits ? totalDigits : remainingDigits;
  return Number(((totalDigits - available) * 200n + totalDigits) / (2n * totalDigits));
}
