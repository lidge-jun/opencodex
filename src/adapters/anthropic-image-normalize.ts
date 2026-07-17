/**
 * Anthropic image normalization: resize/re-encode images to fit Anthropic's request
 * limits instead of dropping them (devlog/260714_image_normalization_pipeline/020).
 *
 * Age-tier pyramid: newest images keep near-full fidelity, older images become
 * progressively smaller JPEG thumbnails, so a whole session's screenshots stay visible
 * under the request byte budget. An aggregate demotion loop re-encodes the OLDEST
 * not-yet-terminal image one ladder position at a time until the total fits; only when
 * every image is terminal-floored does the guard's Rule 4 (textify) fire as backstop.
 *
 * Runs inside the anthropic adapter's buildRequest BEFORE enforceAnthropicImageLimits,
 * on freshly-built wire messages (in-place mutation is safe: messagesToAnthropicFormat
 * creates new arrays/blocks). Encoding uses Bun.Image (bun >= 1.3.14, probe-verified:
 * decodes JPEG/PNG/WebP/GIF/BMP/TIFF/HEIC/AVIF; corrupt input throws).
 */

import {
  collectImageRefs,
  sniffImageDimensions,
  TOTAL_IMAGE_BASE64_BUDGET,
  type ImageBlockRef,
} from "./anthropic-image-guard";

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
const TERMINAL_POS = TIER_SPECS.length - 1;

/** Newest 6 images ride tier 0, the next 14 tier 1, the rest tier 2 (020 tier table). */
const TIER0_COUNT = 6;
const TIER1_COUNT = 14;

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

const UNDECODABLE_TEXT = "[image omitted: undecodable or corrupt image data]";
const BOMB_TEXT = "[image omitted: image too large to process safely]";
const OVERFLOW_DROP_TEXT = "[image omitted: total image payload exceeded the provider request budget; older images were dropped]";

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
const CACHE_BYTE_CAP = 64 * MiB;
// "pass" = validated pass-through; "miss" = this position's ladder cannot meet its hard
// cap for these bytes (skip straight to the next position — C-gate round 2, blocker 1).
const cache = new Map<string, { data: string; mediaType: string } | "pass" | "miss">();
let cacheBytes = 0;
let encodeCalls = 0;

function cachePut(key: string, value: { data: string; mediaType: string } | "pass" | "miss"): void {
  const size = typeof value === "string" ? 0 : value.data.length;
  const existing = cache.get(key);
  if (existing !== undefined) {
    cacheBytes -= typeof existing === "string" ? 0 : existing.data.length;
    cache.delete(key); // re-insert refreshes recency and prevents double-count on concurrent misses
  }
  while (cacheBytes + size > CACHE_BYTE_CAP && cache.size > 0) {
    const oldest = cache.keys().next().value as string;
    const evicted = cache.get(oldest);
    cacheBytes -= typeof evicted === "string" || evicted === undefined ? 0 : evicted.data.length;
    cache.delete(oldest);
  }
  cache.set(key, value);
  cacheBytes += size;
}

/** Read a cache entry, refreshing its recency (true LRU, C-gate round 1 blocker 5). */
function cacheGet(key: string): { data: string; mediaType: string } | "pass" | "miss" | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** Test hooks: encoder-invocation counter + cache reset (no production caller). */
export function getNormalizeStatsForTests(): { encodeCalls: number; cacheEntries: number; cacheBytes: number } {
  return { encodeCalls, cacheEntries: cache.size, cacheBytes };
}
export function resetNormalizeStateForTests(): void {
  cache.clear();
  cacheBytes = 0;
  encodeCalls = 0;
}

/** Default encoder: Bun.Image resize-to-fit + JPEG at the given quality. */
const bunImageEncode: EncodeFn = async (input, spec, quality) => {
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
const bunImageValidate: ValidateFn = async input => {
  await new Bun.Image(input).resize(1, 1).jpeg({ quality: 1 }).toBuffer();
};

function mediaTypeOf(ref: ImageBlockRef): string {
  const block = ref.container[ref.index] as { source?: { media_type?: unknown } } | undefined;
  const mt = block?.source?.media_type;
  return typeof mt === "string" ? mt.toLowerCase() : "";
}

function textify(ref: ImageBlockRef, text: string): void {
  ref.container[ref.index] = { type: "text", text };
}

function replaceImage(ref: ImageBlockRef, data: string, mediaType: string): void {
  ref.container[ref.index] = { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

function initialPosition(newestFirstIndex: number, bias: number): number {
  const base = newestFirstIndex < TIER0_COUNT ? 0 : newestFirstIndex < TIER0_COUNT + TIER1_COUNT ? 1 : 2;
  return Math.min(base + Math.max(0, bias), TERMINAL_POS);
}

/**
 * Process one image at a ladder position: pass through when it already fits the
 * position's caps (Anthropic-native format, dims within maxEdge, size within hardCap —
 * this also exempts possibly-animated GIF/WebP from a lossy re-encode; pass-through is
 * additionally VALIDATED with a full decode once, cached), otherwise walk positions
 * downward encoding until a hard cap is met; terminal accepts measured size.
 * `mediaType` must be the ORIGINAL source media type (cache keys include it — C-gate
 * round 1, blocker 4 — and pass-through eligibility depends on it).
 */
async function processAt(
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

/**
 * Wire-neutral image handle (devlog/260714_image_normalization_pipeline/050): the core
 * algorithm below normalizes THROUGH this interface so non-Anthropic wire shapes (kiro
 * CodeWhisperer) reuse the exact same tier/cache/demotion machinery. `mediaType` is the
 * canonical lowercased MIME ("image/<format>") — cache identity and pass-through
 * decisions depend on it; wire-specific conversions live inside `replace`.
 */
export interface NormalizeTarget {
  base64: string | null;
  mediaType: string;
  replace(data: string, mediaType: string): void;
  drop(note: string): void;
}

export interface NormalizeTargetsOptions extends NormalizeOptions {
  /** Total base64 budget across all targets. Default: TOTAL_IMAGE_BASE64_BUDGET. */
  budget?: number;
  /**
   * What to do when every image is terminal-floored and the sum still exceeds budget:
   * "none" (anthropic — the guard's Rule 4 backstop textifies downstream) or "drop"
   * (kiro — no downstream guard exists, so drop OLDEST targets here until it fits).
   */
  overflowAction?: "none" | "drop";
  /** Only the newest N images are processed (older ones skipped). Default: unlimited. */
  processLimit?: number;
}

/**
 * Core normalization over wire-neutral targets (mutates via target callbacks).
 * Null-base64 targets (URL/file sources) pass through untouched.
 */
export async function normalizeImageTargets(targets: NormalizeTarget[], options: NormalizeTargetsOptions = {}): Promise<void> {
  if (targets.length === 0) return;
  const encode = options.encode ?? bunImageEncode;
  const validate = options.validate ?? bunImageValidate;
  const bias = options.tierBias ?? 0;
  const budget = options.budget ?? TOTAL_IMAGE_BASE64_BUDGET;
  const overflowAction = options.overflowAction ?? "none";
  const processLimit = options.processLimit ?? Number.POSITIVE_INFINITY;
  const n = targets.length;

  // sourceB64/sourceMedia are the ORIGINAL input (encode source + cache identity);
  // size always reflects the bytes currently ON the wire for this target (the core is
  // the only mutator, so tracked size cannot drift from reality).
  interface Entry { target: NormalizeTarget; sourceB64: string; sourceMedia: string; pos: number; size: number; done: boolean }
  const entries: (Entry | null)[] = new Array(n).fill(null);

  // Bounded parallel first pass: a shared index queue with a small fixed worker pool.
  // Unbounded Promise.all across up to `processLimit` (anthropic passes 100) large
  // images would hold that many decoded bitmaps in flight at once — the limit bounds
  // peak memory, not throughput (native encode parallelism lives below this layer).
  // entries[] stays index-addressed, so completion order never affects output order
  // or the sequential demotion loop below.
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const workerCount = Math.min(IMAGE_NORMALIZE_CONCURRENCY, n);
  const worker = async (): Promise<void> => {
    // A fatal error stops workers from pulling NEW indices; in-flight items settle.
    while (!failed) {
      const i = nextIndex++;
      if (i >= n) return;
      const target = targets[i];
      const b64 = target.base64;
      if (!b64) continue; // URL source: no base64 weight, never touched here.
      const newestFirstIndex = n - 1 - i;
      // Images beyond the processing limit are left untouched (anthropic passes 100:
      // its guard textifies the surplus anyway, so decode/encode work there is waste).
      if (newestFirstIndex >= processLimit) continue;
      if (b64.length > MAX_INPUT_BASE64_LENGTH) {
        target.drop(BOMB_TEXT);
        continue;
      }
      const dims = sniffImageDimensions(b64);
      if (dims && dims.width * dims.height > MAX_INPUT_PIXELS) {
        target.drop(BOMB_TEXT);
        continue;
      }
      const sourceMedia = target.mediaType.toLowerCase();
      const pos = initialPosition(newestFirstIndex, bias);
      const result = await processAt(b64, pos, sourceMedia, encode, validate);
      if (result.kind === "failed") {
        target.drop(UNDECODABLE_TEXT);
        continue;
      }
      let size = b64.length;
      if (result.kind === "encoded") {
        // Set the failure flag SYNCHRONOUSLY when the wire callback throws: other
        // parked worker continuations may resume before our .catch() runs, and they
        // must not pull new indices after a fatal error (C-gate round 1, blocker 1).
        try {
          target.replace(result.data, result.mediaType);
        } catch (err) {
          if (!failed) {
            failed = true;
            firstError = err;
          }
          throw err;
        }
        size = result.data.length;
      }
      entries[i] = { target, sourceB64: b64, sourceMedia, pos: result.pos, size, done: result.pos >= TERMINAL_POS };
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker().catch(err => {
    if (!failed) {
      failed = true;
      firstError = err;
    }
  })));
  if (failed) throw firstError;

  // Aggregate demotion loop (audit rounds 1+3): while the measured total exceeds the
  // budget, demote the OLDEST not-yet-terminal image one position and re-encode.
  let sum = 0;
  for (const e of entries) if (e) sum += e.size;
  while (sum > budget) {
    const entry = entries.find((e): e is Entry => e !== null && !e.done);
    if (!entry) break; // all terminal — overflowAction below decides
    const result = await processAt(entry.sourceB64, entry.pos + 1, entry.sourceMedia, encode, validate);
    if (result.kind === "failed") {
      entry.target.drop(UNDECODABLE_TEXT);
      sum -= entry.size;
      entries[entries.indexOf(entry)] = null;
      continue;
    }
    let newSize = entry.size;
    if (result.kind === "encoded") {
      entry.target.replace(result.data, result.mediaType);
      newSize = result.data.length;
    } else {
      newSize = result.b64Length; // pass leaves current bytes (only reachable for never-encoded entries)
    }
    sum += newSize - entry.size;
    entry.size = newSize;
    entry.pos = result.pos;
    entry.done = result.pos >= TERMINAL_POS;
  }

  // Terminal overflow (050 audit round 1, blocker 3): with no downstream guard, drop
  // OLDEST targets until the sum fits.
  if (overflowAction === "drop") {
    for (let i = 0; i < entries.length && sum > budget; i++) {
      const e = entries[i];
      if (!e) continue;
      e.target.drop(OVERFLOW_DROP_TEXT);
      sum -= e.size;
      entries[i] = null;
    }
  }
}

/**
 * Normalize every base64 image in already-built Anthropic wire messages (mutates in
 * place). URL-source images pass through untouched. See module header for the contract.
 */
export async function normalizeAnthropicImages(messages: unknown[], options: NormalizeOptions = {}): Promise<void> {
  const refs = collectImageRefs(messages);
  if (refs.length === 0) return;
  const targets: NormalizeTarget[] = refs.map(ref => ({
    base64: ref.base64,
    mediaType: mediaTypeOf(ref),
    replace: (data: string, mediaType: string) => replaceImage(ref, data, mediaType),
    drop: (note: string) => textify(ref, note),
  }));
  // Anthropic hard-caps 100 images/request and its guard textifies the surplus, so
  // processing beyond the newest 100 is pure waste; terminal overflow stays with the
  // guard's Rule 4 backstop (overflowAction "none").
  await normalizeImageTargets(targets, { ...options, processLimit: 100, overflowAction: "none" });
}
