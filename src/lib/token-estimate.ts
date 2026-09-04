/**
 * Heuristic token-estimation sidecar.
 *
 * Some providers (notably kiro / CodeWhisperer) return no token usage in their stream, so Codex's
 * usage display and auto-compact (which read response.completed.usage) never engage. This module
 * provides a cheap, dependency-free char-based estimate to fill that gap.
 *
 * Grounding (web): 1 token ~= 4 chars for English prose; empirical model ratios are ~Claude 3.5,
 * ~GPT 3.6, ~Gemini 3.8 chars/token (within ~10%). Code / JSON / tool-args (the dominant Codex
 * traffic) pack MORE tokens per char, so a lower chars-per-token ratio is used for those models.
 * Over-counting fails safe (auto-compact fires earlier); under-counting risks context overflow.
 *
 * ## Why the estimate is segmented by script rather than a single divisor
 *
 * A single chars-per-token divisor cannot describe mixed text. Latin prose and code run near
 * 3.2 chars/token; Hangul and Han run near 1.2-1.5, because a Latin-trained BPE spends a token
 * on roughly every CJK character. That is a ~2.5x spread inside one blob, and essentially all
 * real agent traffic is mixed: English code and JSON framing with Korean prose threaded through
 * it.
 *
 * The earlier model divided the whole blob by one ratio and then clamped to a denser ratio only
 * when a SAMPLED CJK share crossed 30%. Two failures followed from that shape. The clamp was a
 * cliff: 29% CJK counted at the sparse ratio, 31% at the dense one, and the band where real
 * traffic actually sits (roughly 1-30% CJK) never triggered it at all. And the sampler read
 * every stride-th character on long blobs, so the share it measured was noisy — a payload of
 * fixed-width records could sample as 100% CJK while being 1.6% CJK, a case still documented in
 * `server/responses/input-admission.ts`.
 *
 * Counting the two scripts separately and adding them removes both problems at once. There is no
 * threshold to sit beside, no sampling error, and the result is continuous in the CJK share, so a
 * blob that gains one Korean character gains a fraction of a token instead of jumping a ratio.
 */

/** Generic English-prose fallback ratio (chars per token). */
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Kiro routes code/JSON-heavy agent traffic: diffs, file paths, tool arguments, identifiers.
 * That material tokenizes markedly denser than the "4 chars per token" English-prose rule.
 *
 * Measured two independent ways, which agree. Recorded conversations pair exact text with the
 * provider's authoritative input-token count; over 5,799 pure-Latin samples that aggregates to
 * 2.80 chars/token. Separately, recorded Kiro request bodies charge ~2.43 bytes per token, and
 * those bodies run ~1.12 bytes per counted character of JSON escaping and framing, which implies
 * ~2.17 chars/token at the wire.
 *
 * 2.8 takes the conservative end of that pair. All kiro models are text LLMs, so one Latin ratio
 * applies to the whole family.
 */
const KIRO_CHARS_PER_TOKEN = 2.8;

const KIRO_MODEL_PREFIXES = ["kiro", "claude", "deepseek", "minimax", "glm", "qwen"];

/**
 * Model-aware chars-per-token ratio for LATIN text. Unknown models fall back to the generic
 * English ratio.
 *
 * This is the sparse-script ratio only. It stays exported, and keeps returning a single number,
 * because callers and tests use it to compare model families; the CJK component is applied by
 * `estimateTokens` per character rather than by rewriting this ratio.
 */
export function charsPerToken(modelId?: string): number {
  if (!modelId) return DEFAULT_CHARS_PER_TOKEN;
  const id = modelId.toLowerCase();
  if (KIRO_MODEL_PREFIXES.some(p => id.startsWith(p))) return KIRO_CHARS_PER_TOKEN;
  return DEFAULT_CHARS_PER_TOKEN;
}

/**
 * Chars per token for CJK text, applied to the CJK characters alone.
 *
 * Solved from the same recorded ground truth: holding the Latin ratio fixed and attributing the
 * remainder of CJK-heavy samples to their Hangul/Han characters gives ~1.50 chars/token. A Korean
 * character therefore costs roughly TWICE what a Latin character does, which is precisely what a
 * single blended divisor cannot express.
 */
const CJK_CHARS_PER_TOKEN = 1.5;

/**
 * Count CJK characters exactly, in one pass, with no allocation and no regex object per char.
 *
 * Ranges: Hangul syllables and jamo, CJK unified ideographs and extension A, hiragana/katakana.
 * Surrogate pairs (rare CJK extensions beyond the BMP) are counted as their two code units,
 * which slightly over-counts them — again the safe direction.
 */
function countCjk(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0x1100 && c <= 0x11ff)
      || (c >= 0x3130 && c <= 0x318f)
      || (c >= 0x4e00 && c <= 0x9fff)
      || (c >= 0x3400 && c <= 0x4dbf)
      || (c >= 0x3040 && c <= 0x30ff)
    ) cjk++;
  }
  return cjk;
}

/**
 * Cap an estimated token count at a model's context window (codex-router PR #140).
 *
 * A request the provider answered cannot have exceeded the window, so the estimate is never
 * allowed to claim it did: the estimate only ever substitutes a reported-zero (or missing)
 * input count, and a value above the window would be provably false. Positive or missing
 * reported counts are never rewritten here — this bounds the heuristic estimate itself.
 * Non-positive or non-integer windows (unknown model) leave the estimate untouched.
 */
export function capEstimateAtContextWindow(estimate: number, contextWindow: number | undefined): number {
  return typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0
    ? Math.min(estimate, contextWindow)
    : estimate;
}

/**
 * Estimate the token count of a text blob. Pure and deterministic.
 * Returns 0 for empty/whitespace-free-empty input; otherwise ceil(length / ratio), min 1.
 * When `contextWindow` is a positive integer the estimate is capped at it: a request the
 * provider answered cannot have exceeded the window, so the estimate must not claim it did.
 */
export function estimateTokens(text: string, modelId?: string, contextWindow?: number): number {
  if (!text) return 0;
  const len = text.length;
  if (len === 0) return 0;
  const latinRatio = charsPerToken(modelId);
  const cjk = countCjk(text);
  // Continuous in the CJK share: no threshold, so one added Korean character moves the estimate
  // by a fraction of a token instead of switching the whole blob to a different divisor.
  const estimate = cjk === 0
    ? Math.ceil(len / latinRatio)
    : Math.ceil((len - cjk) / latinRatio + cjk / CJK_CHARS_PER_TOKEN);
  return capEstimateAtContextWindow(Math.max(1, estimate), contextWindow);
}
