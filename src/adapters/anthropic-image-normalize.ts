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

export type { TierSpec, NormalizeOptions, EncodeFn, ValidateFn } from "./anthropic-image-codec";
export { TIER_SPECS, MAX_INPUT_BASE64_LENGTH, IMAGE_NORMALIZE_CONCURRENCY, MAX_INPUT_PIXELS } from "./anthropic-image-codec";
export { IMAGE_NORMALIZE_CACHE_MAX_BYTES } from "./anthropic-image-codec";
export { getNormalizeStatsForTests, resetNormalizeStateForTests, setNormalizeCacheLimitsForTests } from "./anthropic-image-codec";
export { anthropicImageNormalizeRetainedStoreSnapshot, evictOldestAnthropicImageNormalizeForBudget } from "./anthropic-image-codec";

import { bunImageEncode, bunImageValidate, processAt, TERMINAL_POS, TIER0_COUNT, TIER1_COUNT } from "./anthropic-image-codec";
import { IMAGE_NORMALIZE_CONCURRENCY, MAX_INPUT_BASE64_LENGTH, MAX_INPUT_PIXELS } from "./anthropic-image-codec";
import type { NormalizeOptions } from "./anthropic-image-codec";

const UNDECODABLE_TEXT = "[image omitted: undecodable or corrupt image data]";
const BOMB_TEXT = "[image omitted: image too large to process safely]";
const OVERFLOW_DROP_TEXT = "[image omitted: total image payload exceeded the provider request budget; older images were dropped]";


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
