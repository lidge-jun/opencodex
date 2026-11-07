import { anthropicRateLimitHeaders } from "../../server/anthropic-rate-limit-headers";

export type PassiveKeyProvider = "openai" | "xai" | "groq" | "anthropic" | "mistral";
export type PassiveKeyLimit = {
  dimension: "requests" | "tokens" | "input-tokens" | "output-tokens";
  window?: "minute" | "month";
  observedAt: number;
  limit?: number;
  remaining?: number;
  resetAt?: number;
};
export type PassiveKeyLimitReading = PassiveKeyLimit & { stale: boolean };
export type PassiveKeyIdentity = { owner: string; provider: PassiveKeyProvider; model: string };

const PROVIDERS: readonly string[] = ["openai", "xai", "groq", "anthropic", "mistral"];
const MAX_COUNT = 1_000_000_000_000;
const MAX_TIME = 253_402_300_799_999;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 512;
const MAX_RETENTION_MS = 24 * 60 * 60 * 1000;

function timestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
}

// Mistral's private count helper has the same integer grammar but lives in the transport
// module; importing it here would also import transport and pacing. Keep this parser bounded.
function count(value: string | null | undefined): number | undefined {
  if (value == null || value.length > 128 || !/^\d{1,16}$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed <= MAX_COUNT ? parsed : undefined;
}

/** Strict, descending units; arithmetic is exact and accepts only whole milliseconds. */
function duration(value: string | null): number | undefined {
  if (value === null || value.length > 64) return undefined;
  const input = value.trim();
  const part = /(\d+(?:\.\d+)?)(ms|h|m|s)/gy;
  const units: Record<string, [number, bigint]> = { h: [3, 3_600_000n], m: [2, 60_000n], s: [1, 1000n], ms: [0, 1n] };
  let cursor = 0, previous = 4, total = 0n;
  while (cursor < input.length) {
    part.lastIndex = cursor;
    const match = part.exec(input);
    if (!match) return undefined;
    const [rank, multiplier] = units[match[2]!]!;
    if (rank >= previous) return undefined;
    const [whole, fraction = ""] = match[1]!.split(".");
    const scale = 10n ** BigInt(fraction.length);
    const scaled = (BigInt(whole!) * scale + BigInt(fraction || "0")) * multiplier;
    if (scaled % scale !== 0n) return undefined;
    total += scaled / scale;
    if (total > BigInt(MAX_DURATION_MS)) return undefined;
    previous = rank;
    cursor = part.lastIndex;
  }
  return cursor === 0 ? undefined : Number(total);
}

/** Parse only known header families; absent or invalid values never imply zero. */
export function parsePassiveKeyLimits(provider: PassiveKeyProvider, headers: Headers, observedAt: number): PassiveKeyLimit[] {
  if (!PROVIDERS.includes(provider) || !timestamp(observedAt)) return [];
  const normalized = provider === "anthropic" ? anthropicRateLimitHeaders(headers) : undefined;
  const result: PassiveKeyLimit[] = [];
  const add = (dimension: PassiveKeyLimit["dimension"], limit: number | undefined, remaining: number | undefined,
    resetAt?: number, window?: PassiveKeyLimit["window"]) => {
    if (limit === undefined && remaining === undefined) return;
    result.push({ dimension, ...(window ? { window } : {}), observedAt,
      ...(limit !== undefined ? { limit } : {}), ...(remaining !== undefined ? { remaining } : {}),
      ...(resetAt !== undefined && timestamp(resetAt) ? { resetAt } : {}) });
  };
  if (provider === "anthropic") {
    for (const dimension of ["requests", "input-tokens", "output-tokens", "tokens"] as const) {
      const base = `anthropic-ratelimit-${dimension}`;
      const date = normalized?.[`${base}-reset`];
      add(dimension, count(normalized?.[`${base}-limit`]), count(normalized?.[`${base}-remaining`]), date ? Date.parse(date) : undefined);
    }
  } else if (provider === "mistral") {
    for (const [dimension, wire, window] of [["requests", "req", "minute"], ["tokens", "tokens", "minute"], ["tokens", "tokens", "month"]] as const) {
      add(dimension, count(headers.get(`x-ratelimit-limit-${wire}-${window}`)),
        count(headers.get(`x-ratelimit-remaining-${wire}-${window}`)), undefined, window);
    }
  } else {
    for (const dimension of ["requests", "tokens"] as const) {
      const reset = duration(headers.get(`x-ratelimit-reset-${dimension}`));
      add(dimension, count(headers.get(`x-ratelimit-limit-${dimension}`)),
        count(headers.get(`x-ratelimit-remaining-${dimension}`)), reset === undefined ? undefined : observedAt + reset);
    }
  }
  return result;
}

type Entry = { sequence: number; rows: PassiveKeyLimit[]; timer?: ReturnType<typeof setTimeout> };

/** In-memory only. Callers supply opaque owner IDs and globally increasing send sequences. */
export class PassiveKeyLimitCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly retentionMs: number;

  constructor(options: { maxEntries?: number; retentionMs?: number } = {}) {
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.retentionMs = options.retentionMs ?? MAX_RETENTION_MS;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > MAX_ENTRIES
      || !Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1 || this.retentionMs > MAX_RETENTION_MS) {
      throw new RangeError("Invalid passive key cache bounds");
    }
  }

  private key(identity: PassiveKeyIdentity): string | undefined {
    if (!identity || typeof identity.owner !== "string" || identity.owner.length < 1 || identity.owner.length > 256
      || !PROVIDERS.includes(identity.provider) || typeof identity.model !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(identity.model)) return undefined;
    const ownerHash = new Bun.CryptoHasher("sha256").update(identity.owner).digest("hex");
    return JSON.stringify([ownerHash, identity.provider, identity.model]);
  }

  record(identity: PassiveKeyIdentity, headers: Headers, observedAt: number, sequence: number): boolean {
    const key = this.key(identity);
    if (!key || !timestamp(observedAt) || !Number.isSafeInteger(sequence) || sequence < 0) return false;
    const current = this.entries.get(key);
    if (current && sequence <= current.sequence) return false;
    const rows = parsePassiveKeyLimits(identity.provider, headers, observedAt);
    // A later response with no usable counters still fences earlier in-flight sends.
    if (!rows.length) {
      this.entries.delete(key);
      if (current) current.sequence = sequence;
      this.entries.set(key, current ?? { sequence, rows: [] });
      this.evictOverflow();
      return false;
    }
    if (current?.timer) clearTimeout(current.timer);
    const entry: Entry = { sequence, rows };
    entry.timer = setTimeout(() => { entry.rows = []; entry.timer = undefined; }, this.retentionMs);
    entry.timer.unref();
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evictOverflow();
    return true;
  }

  private evictOverflow(): void {
    if (this.entries.size <= this.maxEntries) return;
    const oldest = this.entries.keys().next().value!;
    const timer = this.entries.get(oldest)?.timer;
    if (timer) clearTimeout(timer);
    this.entries.delete(oldest);
  }

  get(identity: PassiveKeyIdentity, now: number): PassiveKeyLimitReading[] {
    const key = this.key(identity);
    if (!key || !timestamp(now)) return [];
    const entry = this.entries.get(key);
    if (!entry) return [];
    entry.rows = entry.rows.filter(row => now < row.observedAt || now - row.observedAt < this.retentionMs);
    const rows = entry.rows.filter(row => now >= row.observedAt);
    // Keep the sequence fence until eviction; freshness applies to the returned rows.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return rows.map(row => ({ ...row, stale: row.resetAt !== undefined && now >= row.resetAt }));
  }
}

/** One process-local cache, shared by the physical response and management readers. */
export const passiveKeyLimits = new PassiveKeyLimitCache();
