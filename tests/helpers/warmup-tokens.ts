import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

/**
 * A balanced token stream for one TypeScript file, and the positional helpers a structural check
 * needs on top of it.
 *
 * ## Why tokens and not a parsed tree
 *
 * TypeScript here is 7.0.2, the native port, and it publishes no in-process parser. The
 * "typescript/unstable/ast" entry point is a node factory, type guards, a visitor, navigation and
 * this scanner: the createSourceFile it exports is the FACTORY, whose first parameter is an array
 * of already-parsed statements. Parsed trees come from Program.getSourceFile on the
 * "typescript/unstable/sync" client, which spawns the Go tsgo executable and loads a whole project
 * over JSON-RPC. Reading one test file that way would start a compiler process on every shard of
 * every platform.
 *
 * So the judge built on this module recognises an exact, small set of shapes and refuses everything
 * else, rather than reconstructing the grammar by hand. Tokens are enough for that, and being
 * wrong about a shape costs a refusal rather than a false pass.
 *
 * ## What the driver has to get right
 *
 * Two rescans, without which the stream does not balance. A template substitution closes on an
 * ordinary brace, so every template in the file would otherwise leak one unmatched brace: the brace
 * depth each substitution opened at is remembered, and the closing token is rescanned as the
 * template middle or tail it is. A slash either opens a regular expression or divides, decided by
 * the token before it, and a wrong guess swallows whichever delimiters sit between it and the next
 * slash; an unterminated rescan is rewound and the slash stays a division.
 *
 * Whatever is left has to balance. A file that does not is reported unreadable, and unreadable is a
 * failure rather than an absence of evidence.
 */

export type Token = Readonly<{
  kind: SyntaxKind;
  /** Source text of the token, which for an identifier is its name. */
  text: string;
  /** Cooked value, filled for string literals so a module specifier can be read without its quotes. */
  value: string;
  /** Offset of the token in the source, for line numbers in diagnostics. */
  start: number;
}>;

/**
 * A slash opens a regular expression unless the token before it ends a value. The one genuinely
 * ambiguous case, a closing brace, is read as the end of a statement: a regular expression after a
 * block is real code, and dividing by an object literal is not.
 */
const REGEX_CANNOT_FOLLOW: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

export const OPENERS: ReadonlyMap<SyntaxKind, SyntaxKind> = new Map([
  [SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken],
  [SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken],
  [SyntaxKind.OpenBracketToken, SyntaxKind.CloseBracketToken],
]);

export const CLOSERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.CloseBraceToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
]);

/** The file as a balanced token stream, or the reason it could not be read as one. */
export function tokenize(source: string): { tokens: Token[]; unreadable: string[] } {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: Token[] = [];
  const unreadable: string[] = [];
  const templates: number[] = [];
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (;;) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) break;
    let start = scanner.getTokenStart();
    let text = scanner.getTokenText();
    if (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) {
      const afterSlash = scanner.getTokenEnd();
      const previous = tokens[tokens.length - 1];
      if (previous === undefined || !REGEX_CANNOT_FOLLOW.has(previous.kind)) {
        const rescanned = scanner.reScanSlashToken();
        if (rescanned === SyntaxKind.RegularExpressionLiteral && !scanner.isUnterminated()) {
          kind = rescanned;
          start = scanner.getTokenStart();
          text = scanner.getTokenText();
        } else {
          scanner.resetTokenState(afterSlash);
        }
      }
    }
    if (kind === SyntaxKind.CloseBraceToken && templates[templates.length - 1] === braces) {
      templates.pop();
      kind = scanner.reScanTemplateToken(false);
      start = scanner.getTokenStart();
      text = scanner.getTokenText();
    }
    const value = kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : "";
    if (scanner.isUnterminated()) {
      unreadable.push(at(source, start) + "an unterminated literal, so this judge is reading the file wrong");
      return { tokens, unreadable };
    }
    if (kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle) templates.push(braces);
    else if (kind === SyntaxKind.OpenBraceToken) braces += 1;
    else if (kind === SyntaxKind.CloseBraceToken) braces -= 1;
    else if (kind === SyntaxKind.OpenParenToken) parens += 1;
    else if (kind === SyntaxKind.CloseParenToken) parens -= 1;
    else if (kind === SyntaxKind.OpenBracketToken) brackets += 1;
    else if (kind === SyntaxKind.CloseBracketToken) brackets -= 1;
    if (braces < 0 || parens < 0 || brackets < 0) {
      unreadable.push(at(source, start) + "a closing delimiter with nothing open, so this judge is reading the file wrong");
      return { tokens, unreadable };
    }
    tokens.push({ kind, text, value: value ?? "", start });
  }
  if (braces !== 0 || parens !== 0 || brackets !== 0 || templates.length > 0) {
    unreadable.push("the file does not close every delimiter this judge opened (braces " + braces
      + ", parens " + parens + ", brackets " + brackets + ", open template substitutions "
      + templates.length + ")");
  }
  return { tokens, unreadable };
}

/**
 * Where the expression beginning at start ends: its comma, the closing delimiter around it, or its
 * semicolon. The semicolon matters for a concise arrow body written outside a call, which would
 * otherwise read as running to the end of the file and swallow every scope after it.
 */
export function argumentEnd(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const kind = tokens[i].kind;
    if (OPENERS.has(kind)) depth += 1;
    else if (CLOSERS.has(kind)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0
      && (kind === SyntaxKind.CommaToken || kind === SyntaxKind.SemicolonToken)) return i;
  }
  return tokens.length;
}

/** 1-based line of an offset. */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  const bound = Math.min(offset, source.length);
  for (let i = 0; i < bound; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** "line N: ", the prefix every diagnostic carries so a failure points at a place. */
export function at(source: string, offset: number): string {
  return "line " + lineOf(source, offset) + ": ";
}
