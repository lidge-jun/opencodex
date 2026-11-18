import { anthropicRateLimitHeaders } from "../../server/anthropic-rate-limit-headers";

export type PassiveKeyProvider = "openai" | "xai" | "groq" | "anthropic" | "mistral";
export type PassiveKeyLimit = {
  dimension: "requests" | "tokens" | "input-tokens" | "output-tokens";
  window?: "minute" | "day" | "month";
  observedAt: number;
  limit?: number;
  remaining?: number;
  resetAt?: number;
};
export type PassiveKeyLimitReading = PassiveKeyLimit & { stale: boolean };
/**
 * `home` is the config home that observed the send. Two installations can hold the same
 * provider and API key, so the credential alone does not identify a counter: without this
 * dimension home B would read, replace, or retire home A's rows.
 */
export type PassiveKeyIdentity = {
  owner: string; provider: PassiveKeyProvider; model: string; home: string;
  namespace?: string; account?: string;
};

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
        count(headers.get(`x-ratelimit-remaining-${dimension}`)), reset === undefined ? undefined : observedAt + reset,
        provider === "groq" ? (dimension === "requests" ? "day" : "minute") : undefined);
    }
  }
  return result;
}

type Entry = {
  sequence: number; rows: PassiveKeyLimit[]; pending: number; home: string;
  namespace?: string; account?: string; timer?: ReturnType<typeof setTimeout>;
};
export type PassiveKeyLimitReservation = {
  /** `status` is the physical response status: a redirect is not a quota reading. */
  record(headers: Headers, observedAt: number, status: number): boolean;
  cancel(): void;
};

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

  clear(home: string, namespace?: string, account?: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.home !== home) continue;
      if (namespace !== undefined && entry.namespace !== namespace) continue;
      if (account !== undefined && entry.account !== account) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(key);
    }
  }

  private key(identity: PassiveKeyIdentity): string | undefined {
    if (!identity || typeof identity.owner !== "string" || identity.owner.length < 1 || identity.owner.length > 256
      || typeof identity.home !== "string" || identity.home.length < 1 || identity.home.length > 1024
      || !PROVIDERS.includes(identity.provider) || (identity.namespace !== undefined && (typeof identity.namespace !== "string" || identity.namespace.length > 128)) || typeof identity.model !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(identity.model)) return undefined;
    const ownerHash = new Bun.CryptoHasher("sha256").update(identity.owner).digest("hex");
    const homeHash = new Bun.CryptoHasher("sha256").update(identity.home).digest("hex");
    return JSON.stringify([homeHash, ownerHash, identity.provider, identity.model]);
  }

  /**
   * Reserve immediately before the physical send. Record once on an eligible response;
   * cancel in finally on failures, cancellation, or an ineligible response. Eviction
   * or clear invalidates the reservation even if the same identity is later recreated.
   * Reservations live with the caller, not in an unbounded cache-side collection.
   */
  reserve(identity: PassiveKeyIdentity, sequence: number): PassiveKeyLimitReservation | undefined {
    const key = this.key(identity);
    if (!key || !Number.isSafeInteger(sequence) || sequence < 0) return undefined;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { sequence: -1, rows: [], pending: 0, home: identity.home, namespace: identity.namespace, account: identity.account };
      this.entries.set(key, entry);
      this.evictOverflow();
    }
    const reservedEntry = entry;
    const reservedIdentity = { ...identity };
    reservedEntry.pending++;
    let active = true;
    const release = () => {
      if (!active) return false;
      active = false;
      reservedEntry.pending--;
      if (reservedEntry.pending === 0 && reservedEntry.sequence === -1 && reservedEntry.rows.length === 0 && this.entries.get(key) === reservedEntry) {
        this.entries.delete(key);
      }
      return true;
    };
    return {
      record: (headers, observedAt, status) => {
        if (!active) return false;
        try {
          return this.entries.get(key) === reservedEntry && this.record(reservedIdentity, headers, observedAt, sequence, status);
        } finally { release(); }
      },
      cancel: () => { release(); },
    };
  }

  /** Legacy response-only API; use reserve at send time to fence eviction races. */
  record(identity: PassiveKeyIdentity, headers: Headers, observedAt: number, sequence: number, status: number): boolean {
    const key = this.key(identity);
    if (!key || !timestamp(observedAt) || !Number.isSafeInteger(sequence) || sequence < 0) return false;
    // A redirect is never a reading: its headers belong to the intermediary, and counting one
    // would let a headerless manual 302 advance the fence over a real response that is still in
    // flight. Refusals stay eligible — a 429's cells are the most useful observation there is.
    if (!Number.isInteger(status) || status < 100 || status > 599 || (status >= 300 && status < 400)) return false;
    const parsed = parsePassiveKeyLimits(identity.provider, headers, observedAt);
    // A parsed response with no count, remaining value or reset in any family proves nothing.
    // It must not advance the sequence fence or replace a retained numeric measurement.
    const current = this.entries.get(key);
    if (!parsed.some(row => row.limit !== undefined || row.remaining !== undefined || row.resetAt !== undefined)) {
      if (current?.rows.length) return false;
      const entry: Entry = current ?? { sequence: -1, rows: [], pending: 0, home: identity.home, namespace: identity.namespace, account: identity.account };
      entry.rows = parsed;
      entry.timer = setTimeout(() => { entry.rows = []; entry.timer = undefined; }, this.retentionMs);
      entry.timer.unref();
      this.entries.set(key, entry);
      this.evictOverflow();
      return true;
    }
    if (current && sequence <= current.sequence) return false;
    const rows = parsed.flatMap(row => {
      if (row.limit !== undefined || row.remaining !== undefined || row.resetAt !== undefined) return [row];
      const previous = current?.rows.find(item => item.dimension === row.dimension && item.window === row.window
        && (item.limit !== undefined || item.remaining !== undefined || item.resetAt !== undefined)
        && observedAt >= item.observedAt && observedAt - item.observedAt < this.retentionMs);
      // Keep the new unknown observation as a fallback after the older measurement expires.
      return previous ? [previous, row] : [row];
    });
    if (current?.timer) clearTimeout(current.timer);
    const entry: Entry = current ?? { sequence, rows, pending: 0, home: identity.home, namespace: identity.namespace, account: identity.account };
    entry.sequence = sequence;
    entry.rows = rows;
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
    const seen = new Set<string>();
    const rows = entry.rows.filter(row => {
      if (now < row.observedAt) return false;
      const kind = `${row.dimension}:${row.window ?? ""}`;
      if (seen.has(kind)) return false;
      seen.add(kind);
      return true;
    });
    // Keep the sequence fence until eviction; freshness applies to the returned rows.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return rows.map(row => ({ ...row, stale: row.resetAt !== undefined && now >= row.resetAt }));
  }

  list(home: string, owner: string, provider: PassiveKeyProvider, now: number): { model: string; windows: PassiveKeyLimitReading[] }[] {
    if (typeof home !== "string" || !home || home.length > 1024
      || typeof owner !== "string" || !owner || owner.length > 256 || !PROVIDERS.includes(provider) || !timestamp(now)) return [];
    const homeHash = new Bun.CryptoHasher("sha256").update(home).digest("hex");
    const ownerHash = new Bun.CryptoHasher("sha256").update(owner).digest("hex");
    const models = Array.from(this.entries.keys()).flatMap(key => {
      const [storedHome, storedOwner, storedProvider, model] = JSON.parse(key) as [string, string, string, string];
      return storedHome === homeHash && storedOwner === ownerHash && storedProvider === provider ? [model] : [];
    });
    return models.flatMap(model => {
      const windows = this.get({ home, owner, provider, model }, now);
      return windows.length ? [{ model, windows }] : [];
    });
  }
}

/** One process-local cache, shared by the physical response and management readers. */
export const passiveKeyLimits = new PassiveKeyLimitCache();
