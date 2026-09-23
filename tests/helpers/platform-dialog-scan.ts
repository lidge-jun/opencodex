/**
 * Finds calls to the three JavaScript platform dialogs the desktop app cannot draw.
 *
 * wry implements no `WKUIDelegate` JavaScript panel methods, so inside the app
 * `confirm()` returns false without drawing anything, `alert()` draws nothing, and
 * `prompt()` cannot collect input. The dashboard has replaced all three with in-page
 * dialogs; this is what stops them coming back.
 *
 * The rule is the CALL FORM, not the identifier, because the identifier is legitimate in
 * several places this repository actually uses: a `confirm()` method on a session object,
 * the `promptForAdminToken` helper, a `confirm` prop, and an executable sample string that
 * contains the word. Banning the word would reject all four; banning the call form rejects
 * only what cannot work.
 */

export interface PlatformDialogCall {
  /** 1-based, so it pastes straight into an editor. */
  line: number;
  /** The matched text with whitespace removed, e.g. `window.confirm(` or `alert(`. */
  form: string;
}

const DIALOGS = ["confirm", "alert", "prompt"] as const;

/** Receivers that reach the same undrawable platform dialog as a bare call. */
const GLOBAL_RECEIVERS = ["window", "globalThis", "self", "top", "parent"] as const;

/**
 * Keywords after which an identifier is being CALLED. Anything else immediately before the
 * name means it is being declared or named — `async confirm()` is a method declaration,
 * `await confirm()` is a call — so an unrecognised preceding word is allowed rather than
 * reported.
 */
const CALL_POSITION_KEYWORDS = new Set([
  "return", "await", "void", "typeof", "delete", "yield", "new",
  "case", "in", "of", "do", "else", "throw", "default", "export",
]);

/**
 * A `/` after one of these punctuation marks opens a regular expression rather than dividing.
 *
 * `<` and `>` are deliberately absent. A JSX closing tag is spelled `</div>`, so treating
 * `/` after `<` as a regular expression masked everything between that tag and the end of
 * the line — which in dense JSX is exactly where a handler calling a dialog would sit. The
 * one case worth keeping is the arrow function `=> /pattern/`, handled by looking at the
 * character before the `>`.
 */
const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^",
]);

/**
 * Words after which a quote opens a string literal and a slash opens a regular expression.
 *
 * The distinction matters because JSX body text is not a string: in `<div>don't</div>` the
 * apostrophe follows the word `don`, and treating it as a quote would mask the rest of the
 * line — including a platform-dialog call sitting on it. A word that is not a keyword
 * therefore means "prose", and the scanner declines to mask.
 *
 * A word missing from this set fails SAFE: the text is left unmasked, so at worst its
 * contents are reported as a call that has to be looked at, rather than a real call going
 * unreported.
 */
const VALUE_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "do", "else", "void", "await", "yield", "new",
  "delete", "throw", "instanceof", "from", "import", "export", "default", "as", "extends",
  "satisfies", "keyof", "readonly", "let", "const", "var",
]);

function isIdentifierChar(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

/**
 * Replaces comment, string, template-text and regular-expression characters with spaces,
 * keeping every newline so line numbers survive.
 *
 * Template interpolations are deliberately NOT masked: `${confirm(x)}` is executable code
 * and has to stay visible. Regular expressions are masked for the opposite reason — an
 * unmasked `/['"]/` would look like the start of a string literal and silently swallow the
 * rest of the file, which is how a scanner quietly stops reporting anything at all.
 */
export function maskNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  /** Masks template text from `start`, stopping after a hole or the closing backtick. */
  const maskTemplateText = (start: number): number => {
    let cursor = start;
    while (cursor < source.length) {
      const current = source[cursor];
      if (current === "\\") { blank(cursor, cursor + 2); cursor += 2; continue; }
      if (current === "`") { out[cursor] = " "; templates.pop(); return cursor + 1; }
      if (current === "$" && source[cursor + 1] === "{") { blank(cursor, cursor + 2); return cursor + 2; }
      if (current !== "\n") out[cursor] = " ";
      cursor += 1;
    }
    return cursor;
  };

  /**
   * The last significant token. A word carries its text so a keyword can be told from an
   * ordinary identifier; punctuation carries the character. It deliberately survives line
   * breaks — a newline says nothing about whether the next `/` divides or opens a regular
   * expression, and resetting on one made `numerator\n/ alert(x)` read as a regex and mask
   * the call.
   */
  let previousWord = "";
  let previousPunctuation = "";
  /** The punctuation before that, so `=>` can be told from a bare `>`. */
  let punctuationBefore = "";
  const opensValue = (): boolean => {
    if (previousWord) return VALUE_PRECEDING_KEYWORDS.has(previousWord);
    if (previousPunctuation === ">") return punctuationBefore === "=";
    // `count++ / x` divides. Reading that slash as a regular expression masked the rest of
    // the line, which is where the call would be.
    if (previousPunctuation === "+" || previousPunctuation === "-") {
      if (punctuationBefore === previousPunctuation) return false;
    }
    return previousPunctuation === "" || REGEX_PRECEDING_PUNCTUATION.has(previousPunctuation);
  };
  const noteValue = (): void => { previousWord = ""; punctuationBefore = ""; previousPunctuation = "x"; };
  /** Open template literals, each counting the brace depth of the hole it is inside. */
  const templates: number[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    // A quote after an ordinary word is prose, not a string opener: `don't` inside JSX.
    if ((character === "'" || character === '"') && opensValue()) {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== character) {
        // A line continuation keeps the string open, including the CRLF spelling.
        if (source[cursor] === "\\") cursor += source[cursor + 1] === "\r" && source[cursor + 2] === "\n" ? 2 : 1;
        else if (source[cursor] === "\n") break;
        cursor += 1;
      }
      blank(index, cursor + 1);
      noteValue();
      index = cursor + 1;
      continue;
    }
    if (character === "/" && opensValue()) {
      let cursor = index + 1;
      let inClass = false;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\") { cursor += 2; continue; }
        if (current === "\n") break;
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        cursor += 1;
      }
      blank(index, cursor + 1);
      noteValue();
      index = cursor + 1;
      continue;
    }
    if (character === "`") {
      templates.push(0);
      out[index] = " ";
      index = maskTemplateText(index + 1);
      noteValue();
      continue;
    }
    if (templates.length > 0 && character === "{") {
      templates[templates.length - 1] += 1;
    } else if (templates.length > 0 && character === "}") {
      if (templates[templates.length - 1] === 0) {
        out[index] = " ";
        index = maskTemplateText(index + 1);
        noteValue();
        continue;
      }
      templates[templates.length - 1] -= 1;
    }
    if (isIdentifierChar(character)) {
      previousWord += character;
      previousPunctuation = "";
      punctuationBefore = "";
    } else if (!/\s/.test(character)) {
      previousWord = "";
      punctuationBefore = previousPunctuation;
      previousPunctuation = character;
    }
    index += 1;
  }

  return out.join("");
}

/** Reads the identifier ending at `end` (exclusive), or the empty string when there is none. */
function identifierBefore(text: string, end: number): string {
  let start = end;
  while (start > 0 && isIdentifierChar(text[start - 1])) start -= 1;
  return text.slice(start, end);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/** Every global platform-dialog call in one source file, in source order. */
export function findPlatformDialogCalls(source: string): PlatformDialogCall[] {
  const code = maskNonCode(source);
  const found: PlatformDialogCall[] = [];

  // `window.confirm(`, `window?.confirm(`, `window.confirm?.(` and `(window.confirm)(`
  // all reach the same undrawable dialog.
  const receiverPattern = new RegExp(
    `(?<![A-Za-z0-9_$.])(?:${GLOBAL_RECEIVERS.join("|")})\\s*\\??\\s*\\.\\s*(?:${DIALOGS.join("|")})\\s*\\)*\\s*(?:\\?\\.)?\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(receiverPattern)) {
    found.push({ line: lineOf(code, match.index), form: match[0].replace(/\s+/g, "") });
  }

  // The bare forms, including any number of wrapping parentheses and an optional call.
  const barePattern = new RegExp(
    `(?<![A-Za-z0-9_$.])(?:${DIALOGS.join("|")})\\s*\\)*\\s*(?:\\?\\.)?\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(barePattern)) {
    // Step back over whitespace and any wrapping `(` so the preceding-token test sees the
    // real context. A line break on the way means the call starts a statement, which is a
    // call position whatever word ended the previous one.
    let before = match.index;
    let crossedLine = false;
    while (before > 0 && (/\s/.test(code[before - 1]) || code[before - 1] === "(")) {
      if (code[before - 1] === "\n") crossedLine = true;
      before -= 1;
    }
    // A member access reaches the receiver's own method, not the global.
    if (before > 0 && code[before - 1] === ".") continue;
    const preceding = identifierBefore(code, before);
    if (!crossedLine && preceding.length > 0 && !CALL_POSITION_KEYWORDS.has(preceding)) continue;
    found.push({ line: lineOf(code, match.index), form: match[0].replace(/\s+/g, "") });
  }

  /*
   * Computed access is matched against the RAW source, because the quotes that make it work
   * are exactly what the mask removes. A string that merely contains this shape is reported
   * too, which is the safe direction: a false positive is one line to look at, a false
   * negative is a guard that has quietly stopped guarding.
   */
  const computedPattern = new RegExp(
    `(?<![A-Za-z0-9_$.])(?:${GLOBAL_RECEIVERS.join("|")})\\s*\\??\\s*\\[\\s*["'](?:${DIALOGS.join("|")})["']\\s*\\]\\s*(?:\\?\\.)?\\s*\\(`,
    "g",
  );
  for (const match of source.matchAll(computedPattern)) {
    found.push({ line: lineOf(source, match.index), form: match[0].replace(/\s+/g, "") });
  }

  return found.sort((a, b) => a.line - b.line);
}
