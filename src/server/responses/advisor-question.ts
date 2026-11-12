/** Shared, core-owned question bounds; no optional Advisor runtime dependency. */
export const MAX_ADVISOR_QUESTION_CHARACTERS = 2_000;

/**
 * Bound a trimmed question by Unicode code points without splitting surrogate pairs.
 * The fixed notice makes clipping idempotent across interception and prompt construction.
 * Stop after the first excess code point instead of materializing the whole input as an array.
 */
export function clipAdvisorQuestion(value: string): string {
  const text = value.trim();
  let characters = 0;
  let end = 0;
  for (const character of text) {
    if (characters === MAX_ADVISOR_QUESTION_CHARACTERS) {
      return `${text.slice(0, end)}… [truncated]`;
    }
    characters += 1;
    end += character.length;
  }
  return text;
}
