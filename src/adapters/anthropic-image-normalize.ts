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
import { recordedEmittedPosition, recordEmittedPosition } from "./anthropic-image-codec";
import { IMAGE_NORMALIZE_CONCURRENCY, MAX_INPUT_BASE64_LENGTH, MAX_INPUT_PIXELS } from "./anthropic-image-codec";
import type { NormalizeOptions } from "./anthropic-image-codec";

const IMAGE_DECODE_PROCESS_CONCURRENCY = IMAGE_NORMALIZE_CONCURRENCY;
let activeImageDecodes = 0;
const imageDecodeWaiters: Array<() => void> = [];

async function enterImageDecode(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  let transferred = false;
  if (activeImageDecodes >= IMAGE_DECODE_PROCESS_CONCURRENCY) {
    await new Promise<void>((resolve, reject) => {
      const admit = (): void => {
        transferred = true;
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = (): void => {
        const index = imageDecodeWaiters.indexOf(admit);
        if (index >= 0) imageDecodeWaiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      imageDecodeWaiters.push(admit);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  if (!transferred) activeImageDecodes++;
  return () => {
    const next = imageDecodeWaiters.shift();
    if (next) next();
    else activeImageDecodes--;
  };
}

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
  /**
   * True when `drop` leaves the original bytes on the wire instead of removing or
   * textifying them (openai-chat, which has no downstream guard that could re-attach a
   * dropped image). The core normally stops counting a dropped target, which is correct
   * only when the bytes actually leave. Here they do not, so those bytes keep counting
   * toward the budget and the demotion loop keeps shrinking the images it still can.
   */
  retainsBytesOnDrop?: boolean;
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
  const abortSignal = options.abortSignal;
  const n = targets.length;

  const process = async (b64: string, pos: number, mediaType: string) => {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Aborted", "AbortError");
    const leave = await enterImageDecode(abortSignal);
    try {
      // Re-check after admission: an abort landing between dequeue and decode-start
      // must not begin decoding (an in-flight native decode cannot be interrupted).
      if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Aborted", "AbortError");
      const result = await processAt(b64, pos, mediaType, encode, validate);
      if (abortSignal?.aborted) throw abortSignal.reason ?? new DOMException("Aborted", "AbortError");
      return result;
    } finally {
      leave();
    }
  };

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
        if (target.retainsBytesOnDrop) {
          entries[i] = { target, sourceB64: b64, sourceMedia: target.mediaType.toLowerCase(), pos: TERMINAL_POS, size: b64.length, done: true };
        }
        continue;
      }
      const dims = sniffImageDimensions(b64);
      if (dims && dims.width * dims.height > MAX_INPUT_PIXELS) {
        target.drop(BOMB_TEXT);
        if (target.retainsBytesOnDrop) {
          entries[i] = { target, sourceB64: b64, sourceMedia: target.mediaType.toLowerCase(), pos: TERMINAL_POS, size: b64.length, done: true };
        }
        continue;
      }
      const sourceMedia = target.mediaType.toLowerCase();
      // #4532: pin the start position to the image's own identity. A never-seen
      // image still gets the age-derived tier; a seen image resumes where it last
      // EMITTED, so appending a newer image cannot re-encode history and bust
      // Anthropic's prompt prefix cache. tierBias (413 retry) applies on top of
      // either base and still clamps to TERMINAL_POS.
      //
      // Every read in this pass sees the store as it was BEFORE this request,
      // because nothing is written until the whole request settles (see the
      // record loop at the end). That is load-bearing, not incidental: an image
      // can appear more than once in one history, and identity keying collapses
      // those occurrences onto one entry. Writing during the pass let the OLDEST
      // occurrence's tier win a race against the newest one and drag it down —
      // 30 copies of a screenshot all landed on the oldest copy's tier instead of
      // the age pyramid. Reading a fixed snapshot gives each occurrence its own
      // age tier on a cold store, which is the pre-#4532 behaviour.
      const recorded = recordedEmittedPosition(b64, sourceMedia);
      const pos = Math.min((recorded ?? initialPosition(newestFirstIndex, 0)) + Math.max(0, bias), TERMINAL_POS);
      const result = await process(b64, pos, sourceMedia);
      if (result.kind === "failed") {
        target.drop(UNDECODABLE_TEXT);
        if (target.retainsBytesOnDrop) {
          entries[i] = { target, sourceB64: b64, sourceMedia, pos: TERMINAL_POS, size: b64.length, done: true };
        }
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
    const result = await process(entry.sourceB64, entry.pos + 1, entry.sourceMedia);
    if (result.kind === "failed") {
      entry.target.drop(UNDECODABLE_TEXT);
      if (entry.target.retainsBytesOnDrop) {
        // Bytes stay on the wire, so they stay in the total; mark it terminal so the
        // loop moves on to a target it can still shrink instead of retrying this one.
        entry.done = true;
      } else {
        sum -= entry.size;
        entries[entries.indexOf(entry)] = null;
      }
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

  // #4532: commit the positions these images actually went out at, now that the
  // first pass and the aggregate demotion loop have both settled. Written here
  // rather than inline so every read above saw one consistent pre-request
  // snapshot. `recordEmittedPosition` keeps the deeper of the stored and the new
  // position, so a repeated image converges on the most-demoted tier it was ever
  // emitted at and never moves back up.
  for (const entry of entries) {
    if (entry) recordEmittedPosition(entry.sourceB64, entry.sourceMedia, entry.pos);
  }

  // Terminal overflow (050 audit round 1, blocker 3): with no downstream guard, drop
  // OLDEST targets until the sum fits.
  if (overflowAction === "drop") {
    for (let i = 0; i < entries.length && sum > budget; i++) {
      const e = entries[i];
      if (!e) continue;
      e.target.drop(OVERFLOW_DROP_TEXT);
      if (e.target.retainsBytesOnDrop) {
        // The drop left the bytes in place, so they still count and dropping another
        // copy of this target would not help. Move on to one that can actually leave.
        continue;
      }
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
