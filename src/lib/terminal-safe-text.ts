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
export function terminalSafeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, character => {
    const code = character.charCodeAt(0);
    return code <= 0x7f
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
