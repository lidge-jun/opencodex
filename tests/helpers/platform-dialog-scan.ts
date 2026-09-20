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
  "case", "in", "of", "do", "else", "throw",
]);

/** A `/` following one of these opens a regular expression rather than dividing. */
const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">", "\n",
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

  /** Last significant character, used to tell a regular expression from a division. */
  let previousSignificant = "\n";
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
    if (character === "'" || character === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== character) {
        if (source[cursor] === "\\") cursor += 1;
        else if (source[cursor] === "\n") break;
        cursor += 1;
      }
      blank(index, cursor + 1);
      previousSignificant = "x";
      index = cursor + 1;
      continue;
    }
    if (character === "/" && REGEX_PRECEDING_PUNCTUATION.has(previousSignificant)) {
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
      previousSignificant = "x";
      index = cursor + 1;
      continue;
    }
    if (character === "`") {
      templates.push(0);
      out[index] = " ";
      index = maskTemplateText(index + 1);
      previousSignificant = "x";
      continue;
    }
    if (templates.length > 0 && character === "{") {
      templates[templates.length - 1] += 1;
    } else if (templates.length > 0 && character === "}") {
      if (templates[templates.length - 1] === 0) {
        out[index] = " ";
        index = maskTemplateText(index + 1);
        previousSignificant = "x";
        continue;
      }
      templates[templates.length - 1] -= 1;
    }
    if (character === "\n") previousSignificant = "\n";
    else if (!/\s/.test(character)) previousSignificant = character;
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

  const receiverPattern = new RegExp(
    `\\b(?:${GLOBAL_RECEIVERS.join("|")})\\s*\\??\\s*\\.\\s*(?:${DIALOGS.join("|")})\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(receiverPattern)) {
    found.push({ line: lineOf(code, match.index), form: match[0].replace(/\s+/g, "") });
  }

  const barePattern = new RegExp(`(?<![A-Za-z0-9_$.])(?:${DIALOGS.join("|")})\\s*\\(`, "g");
  for (const match of code.matchAll(barePattern)) {
    let before = match.index;
    while (before > 0 && /\s/.test(code[before - 1])) before -= 1;
    // A member access reaches the receiver's own method, not the global.
    if (before > 0 && code[before - 1] === ".") continue;
    const preceding = identifierBefore(code, before);
    if (preceding.length > 0 && !CALL_POSITION_KEYWORDS.has(preceding)) continue;
    found.push({ line: lineOf(code, match.index), form: match[0].replace(/\s+/g, "") });
  }

  return found.sort((a, b) => a.line - b.line);
}
