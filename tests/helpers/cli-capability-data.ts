import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { tokenize, type Token } from "./warmup-tokens";

export const CAPABILITY_DATA_FILES = [
  "capabilities.ts", "capabilities-base.ts", "capability-types.ts",
  "capabilities-provider-models.ts",
  "capabilities-accounts.ts",
  "capabilities-agents-routing.ts",
  "capabilities-integrations.ts",
  "capabilities-observe-system.ts",
  "capabilities-access-remote.ts",
  "capabilities-lab.ts",

] as const;

type Edge = { target: string; kind: "import" | "export"; typeOnly: boolean };
const ROLES: Readonly<Record<string, readonly string[]>> = {
  "capabilities.ts": [
    "import:value:capabilities-base.ts", "export:value:capabilities-base.ts",
    "import:type:capability-types.ts", "export:type:capability-types.ts",
    "import:value:capabilities-provider-models.ts",
    "import:value:capabilities-accounts.ts",
    "import:value:capabilities-agents-routing.ts",
    "import:value:capabilities-integrations.ts",
    "import:value:capabilities-observe-system.ts",
    "import:value:capabilities-access-remote.ts",
    "import:value:capabilities-lab.ts",

  ],
  "capabilities-base.ts": ["import:type:capability-types.ts"],
  "capability-types.ts": [],
  "capabilities-provider-models.ts": ["import:type:capability-types.ts"],
  "capabilities-accounts.ts": ["import:type:capability-types.ts"],
  "capabilities-agents-routing.ts": ["import:type:capability-types.ts"],
  "capabilities-integrations.ts": ["import:type:capability-types.ts"],
  "capabilities-observe-system.ts": ["import:type:capability-types.ts"],
  "capabilities-access-remote.ts": ["import:type:capability-types.ts"],
  "capabilities-lab.ts": ["import:type:capability-types.ts"],

};

function closingBrace(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].kind === SyntaxKind.OpenBraceToken) depth++;
    if (tokens[i].kind === SyntaxKind.CloseBraceToken && --depth === 0) return i;
  }
  throw new Error("unclosed declaration");
}

/** Types owns only exported interface/type declarations, with no runtime initializer. */
function checkTypes(tokens: readonly Token[]): void {
  for (let i = 0; i < tokens.length;) {
    if (tokens[i].kind === SyntaxKind.SemicolonToken) { i++; continue; }
    if (tokens[i++].kind !== SyntaxKind.ExportKeyword) throw new Error("types role requires declarations only");
    const kind = tokens[i++]?.kind;
    if (kind === SyntaxKind.InterfaceKeyword) {
      // This owner needs no extends clauses or computed members.
      if (tokens[i++]?.kind !== SyntaxKind.Identifier || tokens[i]?.kind !== SyntaxKind.OpenBraceToken) {
        throw new Error("unsupported types interface");
      }
      i = closingBrace(tokens, i) + 1;
    } else if (kind === SyntaxKind.TypeKeyword) {
      if (tokens[i++]?.kind !== SyntaxKind.Identifier || tokens[i++]?.kind !== SyntaxKind.EqualsToken) {
        throw new Error("unsupported type alias");
      }
      while (i < tokens.length && tokens[i].kind !== SyntaxKind.SemicolonToken) i++;
      if (i === tokens.length) throw new Error("unterminated type alias");
    } else throw new Error("types role forbids runtime declarations");
  }
}

/**
 * Deliberately narrow expression grammar for metadata and the pure facade helpers.
 * No computed member access or division is needed here. This closes whole syntax
 * classes instead of decoding particular spellings of a require property. Brackets
 * admit empty array/type suffixes and array literals only in these expression-start
 * positions; other uses are unsupported, not evidence of a specific dependency.
 *
 * The shared lexer guesses regex versus division. Trust a regex token only after
 * `=`, where a value must start: a division cannot legally occur there. Else refuse
 * the ambiguous token without inspecting its swallowed body. Even benign division
 * or a regex in another position is outside this boundary's admitted grammar.
 */
function checkMetadataExpressions(tokens: readonly Token[]): void {
  const arrayStarts = new Set([
    SyntaxKind.EqualsToken, SyntaxKind.ColonToken, SyntaxKind.CommaToken,
    SyntaxKind.OpenBracketToken, SyntaxKind.OpenParenToken, SyntaxKind.ReturnKeyword,
  ]);
  for (let i = 0; i < tokens.length; i++) {
    const kind = tokens[i].kind;
    const previous = tokens[i - 1]?.kind;
    if (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken
      || (kind === SyntaxKind.RegularExpressionLiteral && previous !== SyntaxKind.EqualsToken)) {
      throw new Error("unsupported metadata expression: division or ambiguous regex position");
    }
    if (kind === SyntaxKind.OpenBracketToken
      && tokens[i + 1]?.kind !== SyntaxKind.CloseBracketToken
      && !arrayStarts.has(previous)) {
      throw new Error("unsupported metadata expression: computed member or bracket position");
    }
  }
}

/**
 * These data owners have no use for ambient host/loader bindings. Reserve their
 * names in every identifier position, so aliases, destructuring and parameter
 * bindings cannot hide where a loader came from. This intentionally also refuses
 * benign shadowing, type names and unquoted property names using this vocabulary.
 * Quoted keys, strings, template text and regex bodies remain ordinary data.
 * It is a lexical contract, not scope analysis or an arbitrary-code sandbox.
 */
function checkHostIdentifiers(tokens: readonly Token[]): void {
  const reserved = new Set([
    "require", "module", "exports", "global", "globalThis", "Bun", "process",
    "Deno", "window", "self", "this",
  ]);
  for (const token of tokens) {
    if (token.kind !== SyntaxKind.Identifier
      && !(token.kind >= SyntaxKind.FirstKeyword && token.kind <= SyntaxKind.LastKeyword)) continue;
    let name = token.text;
    if (name.includes("\\")) {
      // Use the same native scanner's cooked value for escaped identifiers; the
      // shared token helper intentionally only retains cooked string values.
      const scanner = createScanner(true, LanguageVariant.Standard, name);
      scanner.scan();
      name = scanner.getTokenValue();
    }
    if (reserved.has(name)) throw new Error(`unsupported metadata host/loader identifier: ${name}`);
  }
}

/**
 * Read only the static named import/re-export shapes used by the enumerated data owners.
 * Other load syntax fails closed, including type queries and require references.
 * The shared TS7 lexer ignores comments, strings and regex bodies, while preserving
 * code inside template substitutions. This checks dependencies, not arbitrary code.
 */
function edges(source: string, typesOnly: boolean): Edge[] {
  const { tokens, unreadable } = tokenize(source);
  if (unreadable.length) throw new Error(unreadable.join("; "));
  checkMetadataExpressions(tokens);
  checkHostIdentifiers(tokens);
  const result: Edge[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword) continue;
    const kind = token.kind === SyntaxKind.ImportKeyword ? "import" : "export";
    let cursor = i + 1;
    const wholeType = tokens[cursor]?.kind === SyntaxKind.TypeKeyword;
    if (wholeType) cursor++;
    const next = tokens[cursor];
    if (kind === "export" && next?.kind !== SyntaxKind.OpenBraceToken && next?.kind !== SyntaxKind.AsteriskToken) continue;
    if (next?.kind !== SyntaxKind.OpenBraceToken) {
      throw new Error("only static named imports/re-exports are allowed (no bare, side-effect or computed loads)");
    }
    const end = closingBrace(tokens, cursor);
    let allType = end > cursor + 1;
    for (let member = cursor + 1; member < end;) {
      const inlineType = tokens[member]?.kind === SyntaxKind.TypeKeyword;
      if (inlineType) member++;
      allType &&= inlineType;
      if (tokens[member++]?.kind !== SyntaxKind.Identifier) throw new Error("unsupported import/export member");
      if (tokens[member]?.kind === SyntaxKind.AsKeyword) {
        member++;
        if (tokens[member++]?.kind !== SyntaxKind.Identifier) throw new Error("unsupported import/export alias");
      }
      if (member < end && tokens[member++]?.kind !== SyntaxKind.CommaToken) throw new Error("unsupported import/export clause");
    }
    cursor = end + 1;
    // A local export does not load another module.
    if (kind === "export" && tokens[cursor]?.kind !== SyntaxKind.FromKeyword) { i = end; continue; }
    if (tokens[cursor++]?.kind !== SyntaxKind.FromKeyword || tokens[cursor]?.kind !== SyntaxKind.StringLiteral) {
      throw new Error("unresolved import/export specifier");
    }
    result.push({ kind, target: tokens[cursor].value, typeOnly: wholeType || allType });
    i = cursor;
  }
  if (typesOnly) checkTypes(tokens);
  return result;
}

/** Same predicate for repository files and in-memory refusal fixtures. */
export function capabilityDataBoundary(
  directory: string,
  read: (path: string) => string = path => readFileSync(path, "utf8"),
): string[] {
  const owners = new Map(CAPABILITY_DATA_FILES.map(name => [resolve(directory, name), name]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const errors: string[] = [];
  function visit(path: string): void {
    const name = owners.get(path);
    if (!name) { errors.push(`outside data graph: ${path}`); return; }
    if (visiting.has(path)) { errors.push(`cycle: ${name}`); return; }
    if (visited.has(path)) return;
    visiting.add(path);
    try {
      for (const edge of edges(read(path), name === "capability-types.ts")) {
        if (!edge.target.startsWith("./") && !edge.target.startsWith("../")) {
          errors.push(`${name}: bare dependency ${edge.target}`);
          continue;
        }
        const target = resolve(dirname(path), edge.target.endsWith(".ts") ? edge.target : `${edge.target}.ts`);
        const targetName = owners.get(target);
        const role = `${edge.kind}:${edge.typeOnly ? "type" : "value"}:${targetName}`;
        if (!ROLES[name].includes(role)) errors.push(`${name}: forbidden edge ${role} (${edge.target})`);
        visit(target);
      }
    } catch (error) {
      errors.push(`${name}: unreadable/unresolved: ${error instanceof Error ? error.message : String(error)}`);
    }
    visiting.delete(path);
    visited.add(path);
  }
  // Check every owner, even if a future facade accidentally stops referencing one.
  for (const path of owners.keys()) visit(path);
  return errors;
}
