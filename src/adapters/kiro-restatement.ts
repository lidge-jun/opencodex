// Near-duplicate detection for Kiro's bounded completion retry.
//
// Kiro sometimes answers as ordinary assistant text instead of calling the reserved completion
// tool. opencodex then issues one bounded continuation retry, and a noncompliant model often
// answers that retry by saying what it already said. Rendering both copies shows the user the same
// answer twice.
//
// Observed restatements rewrite freely: they swap phrases, reorder clauses, and repunctuate while
// preserving the content. Exact comparison therefore misses them. Two measured signals separate a
// restatement from a genuine answer:
//
// 1. how much of the longer text the two share as an in-order word sequence, which is high for a
//    rewording and low for unrelated text;
// 2. the largest block of consecutive new words the retry introduces, which stays at phrase length
//    for a rewording and reaches sentence length when the retry actually adds information.
//
// Requiring both keeps a retry that repeats the earlier commentary and then appends real new
// detail, which a similarity threshold alone would discard.
//
// The comparison is deliberately conservative. Suppressing a genuine answer loses information,
// while failing to suppress a duplicate is cosmetic.

/**
 * Minimum word count, required on both sides, before inexact matching applies. Individual words
 * carry the meaning of short texts, where `found` versus `fixed` inverts the message, so those must
 * match word for word.
 */
const MIN_INEXACT_MATCH_WORDS = 40;

/**
 * Percentage of the longer text that both texts must share as an in-order word sequence for the
 * retry to count as a restatement. Across 58 adjacent commentary/final-answer pairs on record,
 * observed restatements measured 74%, 76%, 81%, 84%, and 92%, while the next pair below those
 * measured 39%. The outcome over that corpus is identical for any value from 50 through 70, because
 * the inserted-run and growth bounds do the remaining separation, so this sits mid-plateau rather
 * than on a knife edge.
 */
const RESTATEMENT_MATCH_PERCENT = 65;

/**
 * Longest run of consecutive new words a restatement may introduce. Measured rewordings inserted at
 * most five consecutive words, whereas a retry that adds real information contributes at least a
 * clause.
 */
const MAX_INSERTED_WORD_RUN = 11;

/**
 * Upper bound on the words compared from each side. Reconstructing the shared sequence needs a table
 * proportional to the product of the two lengths, so this caps the work and the allocation. A
 * restatement is already evident from its opening few hundred words.
 */
const MAX_COMPARE_WORDS = 400;

/**
 * Percentage by which the retry may exceed the preceding commentary before it is treated as new
 * content rather than a rewording. A retry that is markedly longer is adding information even when
 * it opens with a repeat.
 */
const MAX_GROWTH_PERCENT = 120;

/** Reports whether `candidate` merely restates `previous` rather than adding material content. */
export function isKiroRestatement(previous: string, candidate: string): boolean {
  const previousWords = comparableWords(previous);
  const candidateWords = comparableWords(candidate);
  if (previousWords.length === candidateWords.length && previousWords.every((word, i) => word === candidateWords[i])) {
    return true;
  }
  if (previousWords.length < MIN_INEXACT_MATCH_WORDS || candidateWords.length < MIN_INEXACT_MATCH_WORDS) {
    return false;
  }
  if (candidateWords.length * 100 > previousWords.length * MAX_GROWTH_PERCENT) return false;
  const left = previousWords.slice(0, MAX_COMPARE_WORDS);
  const right = candidateWords.slice(0, MAX_COMPARE_WORDS);
  const shared = sharedWordSequence(left, right);
  const longer = Math.max(left.length, right.length);
  return shared.length * 100 >= longer * RESTATEMENT_MATCH_PERCENT
    && longestInsertedRun(right, shared) <= MAX_INSERTED_WORD_RUN;
}

/**
 * Splits `text` into lowercase words with surrounding punctuation removed so that rewrapped,
 * repunctuated, and recapitalized restatements still align.
 */
function comparableWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map(word => word.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "").toLowerCase())
    .filter(word => word.length > 0);
}

/**
 * Returns the longest common subsequence of the two word lists, which is the text they share in
 * order while tolerating insertions, substitutions, and deletions.
 */
function sharedWordSequence(previous: string[], candidate: string[]): string[] {
  const width = candidate.length + 1;
  const lengths = new Uint16Array((previous.length + 1) * width);
  for (let i = 0; i < previous.length; i++) {
    for (let j = 0; j < candidate.length; j++) {
      lengths[(i + 1) * width + j + 1] = previous[i] === candidate[j]
        ? lengths[i * width + j] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const shared: string[] = [];
  let i = previous.length;
  let j = candidate.length;
  while (i > 0 && j > 0) {
    if (previous[i - 1] === candidate[j - 1]) {
      shared.push(previous[i - 1]);
      i--;
      j--;
    } else if (lengths[(i - 1) * width + j] >= lengths[i * width + j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  shared.reverse();
  return shared;
}

/**
 * Returns the longest run of consecutive `candidate` words that are absent from `shared`, which
 * measures the largest single block of new text the candidate introduces.
 */
function longestInsertedRun(candidate: string[], shared: string[]): number {
  let sharedIndex = 0;
  let longest = 0;
  let current = 0;
  for (const word of candidate) {
    if (sharedIndex < shared.length && shared[sharedIndex] === word) {
      sharedIndex++;
      current = 0;
    } else {
      current++;
      longest = Math.max(longest, current);
    }
  }
  return longest;
}
