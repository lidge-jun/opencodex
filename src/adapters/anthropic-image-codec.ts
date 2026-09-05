import { sniffImageDimensions } from "./anthropic-image-guard";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";

/** One ladder position: dimension cap, JPEG quality attempts, per-image base64 cap. */
export interface TierSpec {
  maxEdge: number;
  qualities: number[];
  /** Hard per-image base64-length cap at this position; Infinity = terminal (measured size accepted). */
  hardCap: number;
}

const KiB = 1024;
const MiB = 1024 * 1024;

/**
 * Ladder positions 0-5. 0-2 are the age-assigned tiers; 3-5 are demotion floor steps.
 * Terminal (last) accepts its measured output so the aggregate loop always terminates
 * (audit round 2, blocker 1).
 */
export const TIER_SPECS: TierSpec[] = [
  { maxEdge: 2000, qualities: [80, 60, 40, 30], hardCap: 2 * MiB },
  { maxEdge: 1024, qualities: [70, 50], hardCap: 512 * KiB },
  { maxEdge: 700, qualities: [60, 40], hardCap: 192 * KiB },
  { maxEdge: 500, qualities: [40], hardCap: 100 * KiB },
  { maxEdge: 400, qualities: [30], hardCap: 100 * KiB },
  { maxEdge: 320, qualities: [25], hardCap: Infinity },
];
export const TERMINAL_POS = TIER_SPECS.length - 1;

/** Newest 6 images ride tier 0, the next 14 tier 1, the rest tier 2 (020 tier table). */
export const TIER0_COUNT = 6;
export const TIER1_COUNT = 14;

/** Decode-bomb guards: refuse to decode absurd inputs (020 guards; "extreme values excluded"). */
export const MAX_INPUT_BASE64_LENGTH = 64 * MiB;

/**
 * First-pass worker-pool width. Memory-bound, not CPU-bound: each in-flight item can
 * hold a decoded bitmap, so this bounds peak memory to ~4 decoded images while still
 * overlapping I/O and native-encode threadpool work. Fixed on purpose — a config knob
 * would widen the adapter contract with no demonstrated need.
 */
export const IMAGE_NORMALIZE_CONCURRENCY = 4;
export const MAX_INPUT_PIXELS = 100_000_000;


/** Formats Anthropic accepts as-is; anything else must be transcoded or dropped. */
const PASSTHROUGH_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface NormalizeOptions {
  /** Shift every image's starting ladder position down (413 retry tightening; 030). */
  tierBias?: number;
  /** Test seam: replaces the Bun.Image encode path (audit round 1, blocker 6). */
  encode?: EncodeFn;
  /** Test seam: replaces the pass-through decode validation (C-gate round 1, blocker 1). */
  validate?: ValidateFn;
}

export type EncodeFn = (
  input: Uint8Array,
  spec: TierSpec,
  quality: number,
) => Promise<{ data: string; mediaType: string }>;

/** Proves the payload fully decodes; must throw for corrupt/truncated data. */
export type ValidateFn = (input: Uint8Array) => Promise<void>;

type ProcessResult =
  | { kind: "pass"; b64Length: number }
  | { kind: "encoded"; data: string; mediaType: string }
  | { kind: "failed" };

/**
 * Byte-weighted LRU over normalized outputs (audit round 1, blocker 2): aggregate cap,
 * not entry count. Entries are immutable snapshots — demotions write NEW tier-suffixed
 * keys, never mutate stored values.
 */
export const IMAGE_NORMALIZE_CACHE_MAX_BYTES = 64 * MiB;
const CACHE_MAX_ENTRIES = 4_096;
const CACHE_MAX_ENTRY_BYTES = 20 * MiB;
// "pass" = validated pass-through; "miss" = this position's ladder cannot meet its hard
// cap for these bytes (skip straight to the next position — C-gate round 2, blocker 1).
type CacheValue = { data: string; mediaType: string } | "pass" | "miss";
interface CacheEntry {
  value: CacheValue;
  sizeBytes: number;
  metadataBytes: number;
  storedAt: number;
}
interface NormalizeCacheLimits {
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
}
const DEFAULT_CACHE_LIMITS: NormalizeCacheLimits = {
  maxBytes: IMAGE_NORMALIZE_CACHE_MAX_BYTES,
  maxEntries: CACHE_MAX_ENTRIES,
  maxEntryBytes: CACHE_MAX_ENTRY_BYTES,
};
const cacheEncoder = new TextEncoder();
const cache = new Map<string, CacheEntry>();
let cacheLimits = { ...DEFAULT_CACHE_LIMITS };
let cacheBytes = 0;
let cacheMetadataBytes = 0;
let cacheSentinelEntries = 0;
let encodeCalls = 0;

function cacheEntry(key: string, value: CacheValue): CacheEntry {
  const keyBytes = cacheEncoder.encode(key).byteLength;
  const valueBytes = typeof value === "string"
    ? cacheEncoder.encode(value).byteLength
    : cacheEncoder.encode(value.mediaType).byteLength + cacheEncoder.encode(value.data).byteLength;
  const metadataBytes = keyBytes + (typeof value === "string"
    ? cacheEncoder.encode(value).byteLength
    : cacheEncoder.encode(value.mediaType).byteLength);
  return { value, sizeBytes: keyBytes + valueBytes, metadataBytes, storedAt: Date.now() };
}

function deleteCacheEntry(key: string): number {
  const entry = cache.get(key);
  if (!entry) return 0;
  cache.delete(key);
  cacheBytes -= entry.sizeBytes;
  cacheMetadataBytes -= entry.metadataBytes;
  if (typeof entry.value === "string") cacheSentinelEntries--;
  return entry.sizeBytes;
}

function cachePut(key: string, value: CacheValue): boolean {
  const next = cacheEntry(key, value);
  if (
    next.sizeBytes > cacheLimits.maxEntryBytes
    || next.sizeBytes > cacheLimits.maxBytes
    || cacheLimits.maxEntries <= 0
  ) return false;
  const existing = cache.get(key);
  if (existing !== undefined) {
    deleteCacheEntry(key); // re-insert refreshes recency and prevents double-count on concurrent misses
  }
  while (cache.size + 1 > cacheLimits.maxEntries || cacheBytes + next.sizeBytes > cacheLimits.maxBytes) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || deleteCacheEntry(oldest) === 0) return false;
  }
  cache.set(key, next);
  cacheBytes += next.sizeBytes;
  cacheMetadataBytes += next.metadataBytes;
  if (typeof value === "string") cacheSentinelEntries++;
  enforceAppOwnedMemoryBudget();
  return true;
}

/** Read a cache entry, refreshing its recency (true LRU, C-gate round 1 blocker 5). */
function cacheGet(key: string): CacheValue | undefined {
  const entry = cache.get(key);
  if (entry !== undefined) {
    cache.delete(key);
    entry.storedAt = Date.now();
    cache.set(key, entry);
  }
  return entry?.value;
}

/** Test hooks: encoder-invocation counter + cache reset (no production caller). */
export function getNormalizeStatsForTests(): {
  encodeCalls: number;
  cacheEntries: number;
  cacheBytes: number;
  sentinelEntries: number;
  metadataBytes: number;
  oldestAt: number | null;
} {
  return {
    encodeCalls,
    cacheEntries: cache.size,
    cacheBytes,
    sentinelEntries: cacheSentinelEntries,
    metadataBytes: cacheMetadataBytes,
    oldestAt: cache.values().next().value?.storedAt ?? null,
  };
}
export function resetNormalizeStateForTests(): void {
  cache.clear();
  cacheBytes = 0;
  cacheMetadataBytes = 0;
  cacheSentinelEntries = 0;
  encodeCalls = 0;
}

export function setNormalizeCacheLimitsForTests(limits?: Partial<NormalizeCacheLimits>): void {
  resetNormalizeStateForTests();
  cacheLimits = limits ? { ...DEFAULT_CACHE_LIMITS, ...limits } : { ...DEFAULT_CACHE_LIMITS };
}

export function anthropicImageNormalizeRetainedStoreSnapshot(): {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
} {
  return {
    count: cache.size,
    bytes: cacheBytes,
    evictableBytes: cacheBytes,
    pinnedBytes: 0,
    oldestAt: cache.values().next().value?.storedAt ?? null,
  };
}

export function evictOldestAnthropicImageNormalizeForBudget(): number {
  const oldest = cache.keys().next().value;
  return oldest === undefined ? 0 : deleteCacheEntry(oldest);
}

/** Default encoder: Bun.Image resize-to-fit + JPEG at the given quality. */
export const bunImageEncode: EncodeFn = async (input, spec, quality) => {
  const image = new Bun.Image(input);
  const meta = await image.metadata();
  const w = typeof meta.width === "number" ? meta.width : 0;
  const h = typeof meta.height === "number" ? meta.height : 0;
  let pipeline = new Bun.Image(input);
  if (w > spec.maxEdge || h > spec.maxEdge) {
    const scale = spec.maxEdge / Math.max(w, h);
    pipeline = pipeline.resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  }
  const out = await pipeline.jpeg({ quality }).toBuffer();
  return { data: Buffer.from(out).toString("base64"), mediaType: "image/jpeg" };
};

/**
 * Default pass-through validation: force a full decode (resize forces pixel decoding, a
 * header-only metadata read does not). A sniffable-but-truncated payload must throw here
 * instead of riding pass-through to an Anthropic 400 (C-gate round 1, blocker 1).
 */
export const bunImageValidate: ValidateFn = async input => {
  await new Bun.Image(input).resize(1, 1).jpeg({ quality: 1 }).toBuffer();
};

/**
 * Process one image at a ladder position: pass through when it already fits the
 * position's caps (Anthropic-native format, dims within maxEdge, size within hardCap —
 * this also exempts possibly-animated GIF/WebP from a lossy re-encode; pass-through is
 * additionally VALIDATED with a full decode once, cached), otherwise walk positions
 * downward encoding until a hard cap is met; terminal accepts measured size.
 * `mediaType` must be the ORIGINAL source media type (cache keys include it — C-gate
 * round 1, blocker 4 — and pass-through eligibility depends on it).
 */
export async function processAt(
  b64: string,
  startPos: number,
  mediaType: string,
  encode: EncodeFn,
  validate: ValidateFn,
): Promise<ProcessResult & { pos: number }> {
  const dims = sniffImageDimensions(b64);
  const hash = Bun.hash(b64).toString(36);
  let input: Uint8Array;
  try {
    input = Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return { kind: "failed", pos: startPos };
  }
  for (let pos = startPos; pos <= TERMINAL_POS; pos++) {
    const spec = TIER_SPECS[pos];
    const key = `${hash}:${mediaType}:${pos}`;
    const cached = cacheGet(key);
    if (cached === "pass") return { kind: "pass", b64Length: b64.length, pos };
    if (cached === "miss") continue; // known cap miss: skip to the next position
    if (cached) return { kind: "encoded", data: cached.data, mediaType: cached.mediaType, pos };

    const fitsDims = dims !== null && dims.width <= spec.maxEdge && dims.height <= spec.maxEdge;
    if (PASSTHROUGH_MEDIA.has(mediaType) && fitsDims && b64.length <= spec.hardCap) {
      try {
        await validate(input); // sniffable-but-truncated data must not ride pass-through
      } catch {
        return { kind: "failed", pos };
      }
      cachePut(key, "pass");
      return { kind: "pass", b64Length: b64.length, pos };
    }

    let last: { data: string; mediaType: string } | null = null;
    try {
      for (const quality of spec.qualities) {
        encodeCalls++;
        last = await encode(input, spec, quality);
        if (last.data.length <= spec.hardCap) {
          cachePut(key, last);
          return { kind: "encoded", data: last.data, mediaType: last.mediaType, pos };
        }
      }
    } catch {
      // Decode/encode failure: corrupt or unsupported payload (audit round 2, blocker 2).
      return { kind: "failed", pos };
    }
    if (pos === TERMINAL_POS && last) {
      cachePut(key, last);
      return { kind: "encoded", data: last.data, mediaType: last.mediaType, pos };
    }
    // Hard cap missed at this position — remember the miss, continue down the ladder.
    cachePut(key, "miss");
  }
  return { kind: "failed", pos: TERMINAL_POS };
}
