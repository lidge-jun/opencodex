/**
 * Render untrusted provider- or hub-supplied text without letting it control the operator's
 * terminal.
 *
 * The value is data. Escaping is a rendering decision at the moment a human reads it, so it
 * happens here rather than at the point the value is stored or validated: structured output keeps
 * the exact bytes, and only the printed line is neutralized.
 *
 * It lives in `src/lib/` because more than one surface prints an untrusted value: the CLI's
 * diagnostic boundaries (`src/cli/runtime-api.ts`, which re-exports this) and the OAuth device
 * login (`src/oauth/xai.ts`), whose provider-supplied user code and instructions reach the same
 * tty. Importing the CLI module from the OAuth module would close an import cycle, so the
 * primitive is shared from the leaf instead.
 */

/**
 * Code points that can drive a terminal or hide what it shows, written as escapes so none of them
 * sits literally in this source.
 *
 * The block is the terminal-safety set `src/link/ssh-runner.ts` and `src/link/ssh-capture-redact.ts`
 * already strip from hint text — C0, DEL, C1, the zero-width/bidi formatting area, the BOM — plus
 * the two line separators that end a printed line. C0/C1 alone leaves the rest of it reachable: a
 * bidi override (`U+202E`), its terminator (`U+202C`), an isolate (`U+2066`–`U+2069`), a directional
 * mark (`U+061C`, `U+200E`, `U+200F`) or a zero-width/BOM character can reorder or conceal the
 * line around it while reading as nothing at all. Provider-supplied instructions and user codes
 * are exactly that class of value, so the whole block is escaped rather than only the C0/C1 part.
 *
 * Two members of that area are deliberately left alone because they are text shaping, not
 * disguise: ZWNJ (`U+200C`) and ZWJ (`U+200D`) join the glyphs of Indic and Persian words and the
 * members of an emoji sequence, so escaping them would corrupt legitimate script and display the
 * escape in its place. Variation selectors are legitimate emoji presentation for the same reason.
 *
 * The tag block (`U+E0000`–`U+E007F`) is included for a different reason: those characters render
 * as nothing anywhere, so they carry text the operator cannot see. It is also how a subdivision
 * flag is drawn, and escaping a flag's tags loses that flag's shape — accepted, because an
 * unreadable channel through a security boundary costs more than one glyph. The range is outside
 * the BMP, which is why the expression needs the `u` flag: without it `\u{e0000}` is a syntax
 * error and a surrogate-pair spelling would match half a character at a time.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2028\u2029\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/gu;

/**
 * Escape one character as the `\xNN` / `\uNNNN` / `\u{...}` literal a reader can see.
 *
 * `codePointAt` rather than `charCodeAt`: the tag block has no BMP spelling, so its characters are
 * a surrogate pair in a JavaScript string, and reading one unit would print half of it as a lone
 * surrogate. Escaping the code point keeps the pair whole and the escape recognizable.
 */
function escapeCharacter(character: string): string {
  const code = character.codePointAt(0)!;
  if (code <= 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
  return `\\u{${code.toString(16)}}`;
}

export function terminalSafeText(value: string): string {
  return value.replace(UNSAFE, escapeCharacter);
}
