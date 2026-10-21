/**
 * Gemini progress-text history trimming.
 *
 * Gemini models, observed on Gemini 4 Argon over Cloud Code Assist, sometimes skip their thinking
 * channel on a tool-calling turn and plan in the visible text instead. The provider sends that
 * planning as an ordinary text part without a thought marker, for example a progress line in the
 * user's language followed by "Let's read google.ts 580-1700 first." Once one turn like that is
 * replayed as history, the model copies the pattern on the turns that follow, so the leak grows
 * through the rest of the session. Replaying the same 300K-token request with the leaked tails
 * removed from the history stopped the leak, while stronger system-prompt wording did not.
 *
 * The fix is on the history side only. Text that precedes the tool call of a replayed model turn is
 * intermediate progress, and the Google brevity instruction already asks for a single short line
 * there, so it is replayed as its lead sentence. A turn Codex marks `final_answer` and text after a
 * tool call are replayed whole. Visible output is never rewritten, final
 * answers (turns without tool calls) are replayed in full, and the split is punctuation-based so
 * it works the same in every language without matching any wording.
 */

/**
 * Sentence end: ASCII terminal punctuation followed by whitespace or the end (so "google.ts" and
 * "3.5" are not boundaries), a script's own sentence terminator (CJK 。！？, Devanagari
 * ।॥, Arabic ۔؟, Armenian ։, Ethiopic ።, Myanmar ။), or a line break. Closing quotes, brackets and
 * Markdown emphasis right after the punctuation belong to the sentence.
 */
const SENTENCE_END = /[.!?]["'\u201D\u2019)\]*_`]*(?=\s|$)|[\u3002\uFF01\uFF1F\u0964\u0965\u06D4\u061F\u0589\u1362\u104B]["'\u201D\u2019\u300D\u300F)\]*_`]*|\n/g;

/** A boundary that only closes a leading list marker ("1.", "a.") or a common abbreviation ("e.g."). */
const NOT_A_SENTENCE = /^(?:\d{1,3}|[a-z])\.$|(?:^|\s)(?:e\.g|i\.e|etc|vs)\.$/i;
const WHITESPACE = /\s/;

/** Whether replayed progress text for this model is trimmed to its lead sentence. */
export function trimsGeminiProgressHistory(modelId: string): boolean {
  return /gemini/i.test(modelId);
}

/**
 * The lead sentence of a replayed progress text, or undefined when nothing usable remains.
 * Text without a sentence boundary is already a single sentence and is returned whole.
 */
export function geminiProgressLead(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  SENTENCE_END.lastIndex = 0;
  let end = trimmed.length;
  let checked = 0;
  let contentEnd = 0;
  for (let match = SENTENCE_END.exec(trimmed); match; match = SENTENCE_END.exec(trimmed)) {
    const boundary = match.index + match[0].length;
    // Only a newline boundary can end in whitespace. Scan its new interval once; repeated
    // blank lines retain the previous content end without rescanning the preceding text.
    if (match[0] === "\n") {
      for (let index = checked; index < boundary; index++) {
        if (!WHITESPACE.test(trimmed[index])) contentEnd = index + 1;
      }
    } else {
      contentEnd = boundary;
    }
    checked = boundary;
    // The longest exception is four characters plus its preceding whitespace. The list
    // marker alternative is anchored to the whole prefix, so allow it only at the start.
    const start = Math.max(0, contentEnd - 5);
    const suffix = trimmed.slice(start, contentEnd);
    const exception = NOT_A_SENTENCE.exec(suffix);
    if (!exception || (exception.index === 0 && start > 0 && !/^\s/.test(suffix))) { end = boundary; break; }
  }
  const lead = trimmed.slice(0, end).trim();
  // A code-fence opener is not a sentence; replaying it alone would leave an unclosed fence.
  if (lead.length === 0 || lead.startsWith("```")) return undefined;
  return lead;
}
