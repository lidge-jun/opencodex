/**
 * Anthropic images use an image-local encoding policy: later messages never change an
 * earlier image's starting tier or output. Request admission rejects overflow instead
 * of degrading history. Kiro and Chat retain their adaptive age/budget policy through
 * normalizeImageTargets; both policies share the bounded codec worker pool.
 *
 * Runs on freshly-built wire blocks; only those blocks are mutated. Bun.Image performs
 * full decode validation and bounded resize/re-encoding.
 */

import {
  collectImageRefs,
  sniffImageDimensions,
  TOTAL_IMAGE_BASE64_BUDGET,
  MAX_IMAGES_PER_REQUEST,
  AnthropicImageLimitError,
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
   * "none" (Chat retains the payload) or "drop" (Kiro drops oldest targets).
   */
  overflowAction?: "none" | "drop";
  /** Only the newest N images are processed (older ones skipped). Default: unlimited. */
  processLimit?: number;
}

/**
 * Core normalization over wire-neutral targets (mutates via target callbacks).
 * Null-base64 targets (URL/file sources) pass through untouched.
 */
export function normalizeImageTargets(targets: NormalizeTarget[], options: NormalizeTargetsOptions = {}): Promise<void> {
  return normalizeTargets(targets, options, false);
}

async function normalizeTargets(targets: NormalizeTarget[], options: NormalizeTargetsOptions, imageLocal: boolean): Promise<void> {
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
  const entries: (Entry | null)[] = imageLocal ? [] : new Array(n).fill(null);

  // Bounded parallel first pass: a shared index queue with a small fixed worker pool.
  // Unbounded Promise.all across a large image history would hold that many
  // decoded bitmaps in flight at once — the limit bounds
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
      // Adaptive callers can skip images outside their processing limit.
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
      const pos = imageLocal ? 0 : initialPosition(newestFirstIndex, bias);
      const result = await processAt(b64, pos, sourceMedia, encode, validate);
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
      if (!imageLocal) entries[i] = { target, sourceB64: b64, sourceMedia, pos: result.pos, size, done: result.pos >= TERMINAL_POS };
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker().catch(err => {
    if (!failed) {
      failed = true;
      firstError = err;
    }
  })));
  if (failed) throw firstError;
  if (imageLocal) return;

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
export async function normalizeAnthropicImages(messages: unknown[], options: Pick<NormalizeOptions, "encode" | "validate"> = {}): Promise<void> {
  const refs = collectImageRefs(messages);
  if (refs.length === 0) return;
  if (refs.length > MAX_IMAGES_PER_REQUEST) {
    throw new AnthropicImageLimitError("anthropic_image_count_exceeded", `Anthropic accepts at most ${MAX_IMAGES_PER_REQUEST} images per request.`);
  }
  const targets: NormalizeTarget[] = refs.map(ref => ({
    base64: ref.base64,
    mediaType: mediaTypeOf(ref),
    replace: (data: string, mediaType: string) => replaceImage(ref, data, mediaType),
    drop: (note: string) => textify(ref, note),
  }));
  await normalizeTargets(targets, options, true);
}
