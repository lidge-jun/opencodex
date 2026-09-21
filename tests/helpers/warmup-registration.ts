import { dirname, isAbsolute, resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { helperPath } from "./repo-root";
import { argumentEnd, at, CLOSERS, lineOf, OPENERS, tokenize, type Token } from "./warmup-tokens";

/**
 * Decide, from a test file's source alone, whether it registers a cold-spawn warm-up and waits for
 * it: by recognising a small set of exact shapes and refusing everything else.
 *
 * ## The defect this exists for
 *
 * The coverage guard in tests/ci-workflows/cold-spawn-warmup.test.ts recorded a file as warmed when
 * its text contained the substring "helpers/cold-spawn-warmup" (#5060). A comment, a string literal,
 * or an import left behind after the beforeAll call was deleted all satisfied it, and the measured
 * child went back to paying its cold module-graph load with a green guard standing in front of it.
 *
 * ## The shapes this judge accepts
 *
 * W is a name bound by a DIRECT named import of tests/helpers/cold-spawn-warmup, aliases followed;
 * the call may be W(...) or W?.(...). describe and beforeAll must be direct named imports of
 * bun:test, and neither may be rebound anywhere in the file.
 *
 *   hook-statement    describe(...)* > beforeAll(async () => { ... await W(...); ... }, ...)
 *   hook-return       describe(...)* > beforeAll(() => { return W(...); }, ...)
 *   hook-expression   describe(...)* > beforeAll(() => W(...), ...) and its awaited form
 *   module-top-level  await W(...); as a whole statement at the top level of the file
 *
* In the two statement shapes the call is the whole statement: it begins right after a brace or a
* semicolon and ends on its own semicolon or on the closing brace of the hook. A function
* expression stands in for the arrow in any of them. Nesting is exact - every block between the
* file and the hook must be a describe callback, and the open calls must be exactly the calls that
* own those blocks, so an extra paren or an extra block is not the same shape.
 *
 * A describe callback counts only when the describe is a plain statement call of the bare imported
 * name. describe.skip registers a suite that never runs and a describe behind a condition is never
 * called, so a hook inside either one is a registration in shape only.
 *
 * ## What it refuses, by design
 *
 * Every other occurrence of W is a refusal naming its line, and one refusal anywhere on the binding
 * path means the file is not proven. Shapes that do warm at run time are refused too:
 *
 *   a namespace import of the helper, and any call made through it;
 *   a barrel or re-export path, because the specifier does not resolve to the helper module;
 *   an alias through a variable, const warm = W, and a callback the hook reaches by name;
*   a call in a scope this judge does not model - a nested function, an uncalled helper, a bare
*     block, a conditional branch, even when every branch warms;
 *   a hook inside a suite that is not a plain describe statement, such as describe.skip or
 *     describe.each;
*   fire-and-forget, void, and a call that is one operand of a larger expression.
 *
 * That list is the design rather than a backlog. TypeScript 7.0.2 publishes no in-process parser
 * (see tests/helpers/warmup-tokens.ts), so the alternative to an exact accept-set is reconstructing
 * scoping and expression grammar from tokens, where every wrong guess is a FALSE PASS - the one
 * failure this file exists to remove. A refusal is the opposite: loud, located, and cheap to answer.
 * A legitimate file that needs a refused shape records it once in its disposition, which keeps the
 * refusal itself under test; see WarmupDisposition.
 *
 * ## What no structural check can decide
 *
 * It reads the shape of a file, not the run. It does not prove the process reached the describe that
 * holds the registration, and it does not prove the warm-up child loaded anything. That oracle is
 * separate and unchanged: the helper prints one completion line per warmed graph on every hosted
 * run, and a warm-up that throws fails its file as a setup failure.
 */

/** The entry points in tests/helpers/cold-spawn-warmup.ts that pay a cold module graph. */
const WARMUP_ENTRY_POINTS: ReadonlySet<string> = new Set(["warmColdSpawn", "warmModuleGraph"]);

/** The bun:test hook a warm-up belongs in, and the only call its scopes may be nested inside. */
const REGISTRATION_HOOK = "beforeAll";
const SUITE_CALL = "describe";

/** What a modelled statement may begin after. Anything else means it is part of something larger. */
const STATEMENT_START: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.SemicolonToken,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.CloseBraceToken,
]);

/** Keywords that introduce a new binding for the name that follows them. */
const DECLARATION_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ConstKeyword,
  SyntaxKind.LetKeyword,
  SyntaxKind.VarKeyword,
  SyntaxKind.FunctionKeyword,
  SyntaxKind.ClassKeyword,
]);

export type WarmupShape = "hook-statement" | "hook-return" | "hook-expression" | "module-top-level";

export type WarmupRegistration = Readonly<{
  /** The helper entry point the file waits for. */
  helper: string;
  /** The local name it was called through, which is the alias when the import renames it. */
  local: string;
  /** Which of the accepted shapes matched. */
  shape: WarmupShape;
  /** 1-based line of the call, so a failure points at a place rather than a file. */
  line: number;
}>;

export type WarmupRegistrationReport = Readonly<{
  /** Local names a direct named import bound to a warm-up entry point. */
  bindings: readonly string[];
  /** Whether any import specifier resolves to the helper module. */
  importsHelperModule: boolean;
  /**
   * Whether either entry-point name appears as an identifier at all, however it got here. A barrel
   * import and a namespace call both bind nothing this judge follows, so bindings alone would read
   * a real warm-up as an absence.
   */
  mentionsEntryPoint: boolean;
  /** Occurrences that matched an accepted shape. */
  registrations: readonly WarmupRegistration[];
  /** One channel for everything fatal: unreadable source, and every construct not modelled. */
  refusals: readonly string[];
}>;

export type WarmupDisposition = Readonly<{
  /** Whether the file is claimed to pay its cold module-graph load in setup. */
  warmed: boolean;
  /** Why, in enough detail to survive review. */
  why: string;
  /**
   * For a file that really does warm in a shape this judge refuses: the text its refusal has to
   * contain. The judge still has to see the warm-up and still has to refuse it for that stated
   * reason, so deleting the call, or degrading it to fire-and-forget, changes the refusal and fails.
   */
  unmodeled?: string;
}>;

/** True only when an accepted shape matched and nothing on the binding path was refused. */
export function warmupIsRegistered(report: WarmupRegistrationReport): boolean {
  return report.refusals.length === 0 && report.registrations.length > 0;
}

/** Everything the judge refused, for a failure message that names the construct and the line. */
export function warmupRegistrationComplaints(report: WarmupRegistrationReport): string[] {
  return [...report.refusals];
}

/**
 * Where a file disagrees with the disposition recorded for it, empty when they agree.
 *
 * Three states rather than two. A file recorded as warmed has to show an accepted shape and nothing
 * refused; a file recorded as unwarmed must not reach the helper at all; and a file recorded as
 * warmed through an unmodelled shape has to still reach the helper and still be refused for the
 * stated reason. That third state is what keeps a refusal from blocking a legitimate test file
 * while keeping the refusal itself honest.
 */
export function dispositionComplaints(
  path: string,
  disposition: WarmupDisposition,
  report: WarmupRegistrationReport,
): string[] {
  const complaints: string[] = [];
  const say = (what: string): number => complaints.push(path + ": " + what);
  const refused = report.refusals.join("; ");
  if (!disposition.warmed) {
    if (report.mentionsEntryPoint || report.importsHelperModule) say("recorded unwarmed, but it reaches the warm-up helper");
    if (report.registrations.length > 0) say("recorded unwarmed, but it registers a warm-up");
    if (report.refusals.length > 0) say("recorded unwarmed, and " + refused);
    return complaints;
  }
  const unmodeled = disposition.unmodeled;
  if (unmodeled === undefined) {
    if (report.registrations.length === 0) {
      say("recorded warmed, but no accepted shape is here: " + (refused || "nothing reaches the warm-up helper"));
    } else if (report.refusals.length > 0) {
      say("recorded warmed, and " + refused);
    }
    return complaints;
  }
  if (!report.mentionsEntryPoint) say("recorded warmed through " + unmodeled + ", but nothing here reaches the warm-up helper");
  else if (report.registrations.length > 0) say("recorded warmed through " + unmodeled + ", but this judge accepts what it found; drop the note");
  else if (!report.refusals.some(refusal => refusal.includes(unmodeled))) {
    say("recorded warmed through " + unmodeled + ", which is not what was refused: " + (refused || "nothing was refused"));
  }
  return complaints;
}

export function analyzeWarmupRegistration(fileName: string, source: string): WarmupRegistrationReport {
  const scan = tokenize(source);
  if (scan.unreadable.length > 0) {
    return {
      bindings: [], importsHelperModule: false, mentionsEntryPoint: false,
      registrations: [], refusals: scan.unreadable,
    };
  }
  const tokens = scan.tokens;
  const refusals: string[] = [];
  const clauses = importClauses(tokens);

  const bindings = new Map<string, string>();
  let importsHelperModule = false;
  for (const clause of clauses) {
    if (!importsTheWarmupHelper(fileName, clause.specifier)) continue;
    importsHelperModule = true;
    if (clause.namespace !== undefined) {
      refusals.push(at(source, clause.start) + "the warm-up helper is imported as a namespace (* as "
        + clause.namespace + "), which this judge does not model");
    }
    for (const name of clause.names) {
      if (!WARMUP_ENTRY_POINTS.has(name.imported)) continue;
      if (name.typeOnly) {
        refusals.push(at(source, clause.start) + name.imported
          + " is imported for its type only, which loads nothing at run time");
        continue;
      }
      bindings.set(name.local, name.imported);
    }
  }
  const mentionsEntryPoint = importsHelperModule || tokens.some(token =>
    token.kind === SyntaxKind.Identifier && WARMUP_ENTRY_POINTS.has(token.text));

  if (bindings.size === 0) {
    if (mentionsEntryPoint && refusals.length === 0) {
      refusals.push("the warm-up helper is reached without a direct named import of "
        + "tests/helpers/cold-spawn-warmup, which this judge does not model");
    }
    return { bindings: [], importsHelperModule, mentionsEntryPoint, registrations: [], refusals };
  }

  const hooks = importedLocals(clauses, "bun:test", REGISTRATION_HOOK);
  const suites = importedLocals(clauses, "bun:test", SUITE_CALL);
  const rebound = new Map<string, Token>();
  for (const name of [...hooks, ...suites]) {
    const rebinding = rebindingOf(tokens, name);
    if (rebinding !== undefined) rebound.set(name, rebinding);
  }

  const registrations = judgeOccurrences({ tokens, source, bindings, hooks, suites, rebound, refusals,
    imported: importedTokenRanges(clauses) });
  if (registrations.length === 0 && refusals.length === 0) {
    refusals.push("the warm-up helper is imported here and never called");
  }
  return { bindings: [...bindings.keys()], importsHelperModule, mentionsEntryPoint, registrations, refusals };
}

type CallFrame = Readonly<{
  /** The bare identifier being called, or empty when the call is anything more elaborate. */
  callee: string;
  /** Token index of the paren that opened the call. */
  open: number;
  /** Whether the callee itself starts a statement, which is what makes its callback run. */
  statement: boolean;
}>;

/** How a scope reads in a refusal, so the message says where the call actually sits. */
const LAYER_LABELS: Readonly<Record<string, string>> = {
  suite: "a describe callback",
  hook: "a beforeAll callback",
  "hook-expression": "a beforeAll expression body",
  other: "a scope this judge does not model",
};

/**
 * A scope the judge tracks. Only two kinds are part of an accepted shape; everything else is
 * "other" and refuses whatever sits inside it. A concise arrow body is a scope with no braces, and
 * missing it is how a hook registered inside an uncalled callback reads as top-level work.
 */
type Layer = Readonly<{
  kind: "suite" | "hook" | "hook-expression" | "other";
  /** Token index where the scope ends: its closing brace, or the end of the arrow expression. */
  end: number;
  /** Token index of the first token inside it. */
  bodyStart: number;
  /** Why a scope that looks like one of the accepted kinds is not, for the refusal message. */
  reason?: string;
}>;

type Judgement = Readonly<{
  tokens: readonly Token[];
  source: string;
  bindings: ReadonlyMap<string, string>;
  hooks: ReadonlySet<string>;
  suites: ReadonlySet<string>;
  rebound: ReadonlyMap<string, Token>;
  refusals: string[];
  imported: readonly { from: number; to: number }[];
}>;

/**
 * One pass over the file, carrying the two stacks an accepted shape is defined in terms of: the
 * calls that are open, and the scopes that are open. Every occurrence of a warm-up binding is
 * classified against them, and an occurrence that matches no accepted shape is refused by name.
 */
function judgeOccurrences(j: Judgement): WarmupRegistration[] {
  const { tokens } = j;
  const matches = delimiterMatches(tokens);
  const registrations: WarmupRegistration[] = [];
  const layers: Layer[] = [];
  const calls: CallFrame[] = [];
  const acceptedHookCalls = new Set<number>();
  for (let i = 0; i < tokens.length; i += 1) {
    while (layers.length > 0 && layers[layers.length - 1].end <= i) layers.pop();
    const token = tokens[i];
    if (token.kind === SyntaxKind.CloseParenToken) {
      calls.pop();
      continue;
    }
    if (token.kind === SyntaxKind.OpenParenToken) {
      calls.push(callFrame(tokens, i));
      continue;
    }
    if (token.kind === SyntaxKind.OpenBraceToken) {
      layers.push(braceLayer(j, i, calls, acceptedHookCalls, matches));
      continue;
    }
    if (token.kind === SyntaxKind.EqualsGreaterThanToken
      && (tokens[i + 1] === undefined || tokens[i + 1].kind !== SyntaxKind.OpenBraceToken)) {
      layers.push(conciseArrowLayer(j, i, calls, acceptedHookCalls, matches));
      continue;
    }
    if (token.kind !== SyntaxKind.Identifier) continue;
    if (j.hooks.has(token.text) && !isMemberName(tokens, i)) {
      const open = opensCall(tokens, i);
      if (open !== undefined && hookCallIsVisible(j, i, layers, calls)) acceptedHookCalls.add(open);
      continue;
    }
    if (!isBindingOccurrence(j, i)) continue;
    const verdict = classifyOccurrence(j, i, layers, calls, matches);
    if (typeof verdict === "string") j.refusals.push(verdict);
    else registrations.push(verdict);
  }
  return registrations;
}

/** Index of the delimiter each delimiter pairs with, computed once rather than scanned per call. */
function delimiterMatches(tokens: readonly Token[]): number[] {
  const matches = new Array<number>(tokens.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (OPENERS.has(tokens[i].kind)) open.push(i);
    else if (CLOSERS.has(tokens[i].kind)) {
      const start = open.pop();
      if (start !== undefined) {
        matches[start] = i;
        matches[i] = start;
      }
    }
  }
  return matches;
}

function braceLayer(
  j: Judgement,
  brace: number,
  calls: readonly CallFrame[],
  accepted: ReadonlySet<number>,
  matches: readonly number[],
): Layer {
  const end = matches[brace] < 0 ? j.tokens.length : matches[brace];
  const bodyStart = brace + 1;
  const owner = calls[calls.length - 1];
  if (!opensArgumentCallback(j.tokens, brace, matches)) return { kind: "other", end, bodyStart };
  if (owner !== undefined && accepted.has(owner.open)) return { kind: "hook", end, bodyStart };
  if (owner !== undefined && owner.statement && j.suites.has(owner.callee) && !j.rebound.has(owner.callee)) {
    return { kind: "suite", end, bodyStart };
  }
  const reason = braceLayerReason(j, owner);
  return { kind: "other", end, bodyStart, reason };
}

/**
 * Why a block that looks like a describe body is not one. A rebound name is not bun:test, and a
 * describe that is not itself a plain statement - behind a condition, through a member such as
 * describe.skip, or inside another callback - registers hooks that never run.
 */
function braceLayerReason(j: Judgement, owner: CallFrame | undefined): string | undefined {
  if (owner === undefined) return undefined;
  const rebinding = j.rebound.get(owner.callee);
  if (rebinding !== undefined) {
    return owner.callee + " is rebound at line " + lineOf(j.source, rebinding.start) + ", so this is not bun:test";
  }
  if (j.suites.has(owner.callee) && !owner.statement) {
    return owner.callee + " is not called as a plain statement here, so its callback is not known to run";
  }
  return undefined;
}

function conciseArrowLayer(
  j: Judgement,
  arrow: number,
  calls: readonly CallFrame[],
  accepted: ReadonlySet<number>,
  matches: readonly number[],
): Layer {
  const owner = calls[calls.length - 1];
  const ownsHookBody = owner !== undefined && accepted.has(owner.open)
    && arrowIsArgument(j.tokens, arrow, matches);
  return {
    kind: ownsHookBody ? "hook-expression" : "other",
    end: argumentEnd(j.tokens, arrow + 1),
    bodyStart: arrow + 1,
  };
}

/**
 * Whether a beforeAll call is one this judge can see running: the bun:test import itself, at the
 * start of a statement, with describe callbacks and nothing else between it and the file.
 */
function hookCallIsVisible(
  j: Judgement,
  hook: number,
  layers: readonly Layer[],
  calls: readonly CallFrame[],
): boolean {
  if (j.rebound.has(j.tokens[hook].text)) return false;
  if (calls.length !== layers.length) return false;
  if (!layers.every(layer => layer.kind === "suite")) return false;
  const before = j.tokens[hook - 1];
  return before === undefined || STATEMENT_START.has(before.kind);
}

function classifyOccurrence(
  j: Judgement,
  w: number,
  layers: readonly Layer[],
  calls: readonly CallFrame[],
  matches: readonly number[],
): WarmupRegistration | string {
  const token = j.tokens[w];
  const helper = j.bindings.get(token.text) ?? token.text;
  const made = (shape: WarmupShape): WarmupRegistration =>
    ({ helper, local: token.text, shape, line: lineOf(j.source, token.start) });
  const refuse = (why: string): string => at(j.source, token.start) + token.text + " " + why;
  const open = opensCall(j.tokens, w);
  if (open === undefined) return refuse("is used without being called, which this judge does not model");
  const close = matches[open];
  if (close < 0) return refuse("opens a call this judge cannot close");
  if (calls.length !== layers.length) {
    return chainRefusal(j, w, layers, " (the open calls do not match the open scopes)");
  }
  if (layers.length === 0) {
    const statement = wholeStatement(j.tokens, w, close, undefined);
    if (statement === undefined || statement.keyword !== "await") {
      return refuse("is not a whole awaited statement at the top level of the file");
    }
    return made("module-top-level");
  }
  const inner = layers[layers.length - 1];
  if (!layers.slice(0, layers.length - 1).every(layer => layer.kind === "suite")) return chainRefusal(j, w, layers);
  if (inner.kind === "hook") {
    const statement = wholeStatement(j.tokens, w, close, inner.end);
    if (statement === undefined) {
      return refuse("is not a whole awaited or returned statement of the hook callback");
    }
    return made(statement.keyword === "return" ? "hook-return" : "hook-statement");
  }
  if (inner.kind === "hook-expression") {
    const head = inner.bodyStart;
    const awaited = j.tokens[head] !== undefined && j.tokens[head].kind === SyntaxKind.AwaitKeyword;
    if (w !== head && !(awaited && w === head + 1)) {
      return refuse("is not the whole body of the hook callback");
    }
    if (close + 1 !== inner.end) return refuse("is one part of a larger returned expression");
    return made("hook-expression");
  }
  return chainRefusal(j, w, layers);
}

function chainRefusal(j: Judgement, w: number, layers: readonly Layer[], extra = ""): string {
  const chain = layers
    .map(layer => LAYER_LABELS[layer.kind] + (layer.reason === undefined ? "" : " (" + layer.reason + ")"))
    .join(" > ");
  return at(j.source, j.tokens[w].start) + j.tokens[w].text
    + " is not in a shape this judge models; enclosing scopes: "
    + (chain === "" ? "the top level of the file" : chain) + extra;
}

/**
 * The call as a whole statement introduced by await or return, or undefined when it is part of
 * something larger. A statement begins right after a brace or a semicolon and ends on its own
 * semicolon or on the brace that closes the scope, which is what rules out fire-and-forget, void,
 * a conditional consequent, and an operand of a larger expression without modelling any of them.
 */
function wholeStatement(
  tokens: readonly Token[],
  w: number,
  close: number,
  scopeEnd: number | undefined,
): { start: number; keyword: "await" | "return" } | undefined {
  const pre = tokens[w - 1];
  if (pre === undefined) return undefined;
  let start = w - 1;
  let keyword: "await" | "return";
  if (pre.kind === SyntaxKind.AwaitKeyword) keyword = "await";
  else if (pre.kind === SyntaxKind.ReturnKeyword) keyword = "return";
  else return undefined;
  const beforeKeyword = tokens[start - 1];
  if (keyword === "await" && beforeKeyword !== undefined && beforeKeyword.kind === SyntaxKind.ReturnKeyword) {
    start -= 1;
    keyword = "return";
  }
  const before = tokens[start - 1];
  if (before !== undefined && !STATEMENT_START.has(before.kind)) return undefined;
  const after = tokens[close + 1];
  const ends = after === undefined || after.kind === SyntaxKind.SemicolonToken
    || (scopeEnd !== undefined && close + 1 === scopeEnd);
  return ends ? { start, keyword } : undefined;
}

/** Index of the paren that opens a call on the identifier at i, for W(...) and W?.(...). */
function opensCall(tokens: readonly Token[], i: number): number | undefined {
  const next = tokens[i + 1];
  if (next === undefined) return undefined;
  if (next.kind === SyntaxKind.OpenParenToken) return i + 1;
  if (next.kind === SyntaxKind.QuestionDotToken && tokens[i + 2] !== undefined
    && tokens[i + 2].kind === SyntaxKind.OpenParenToken) return i + 2;
  return undefined;
}

function isMemberName(tokens: readonly Token[], i: number): boolean {
  const before = tokens[i - 1];
  return before !== undefined
    && (before.kind === SyntaxKind.DotToken || before.kind === SyntaxKind.QuestionDotToken);
}

/** An identifier that IS the imported binding: not a property name, and not the import clause. */
function isBindingOccurrence(j: Judgement, i: number): boolean {
  const token = j.tokens[i];
  if (token.kind !== SyntaxKind.Identifier || !j.bindings.has(token.text)) return false;
  if (isMemberName(j.tokens, i)) return false;
  return !j.imported.some(range => i >= range.from && i <= range.to);
}

type ImportedName = Readonly<{ imported: string; local: string; typeOnly: boolean }>;

type ImportClause = Readonly<{
  specifier: string;
  names: readonly ImportedName[];
  namespace: string | undefined;
  /** Token index of the import keyword and of its specifier, so occurrences inside are not calls. */
  from: number;
  to: number;
  start: number;
}>;

/**
 * Every import DECLARATION and what it binds. A dynamic import(...) and import.meta are skipped:
 * neither creates the top-level binding an accepted shape is written in terms of.
 */
function importClauses(tokens: readonly Token[]): ImportClause[] {
  const clauses: ImportClause[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].kind !== SyntaxKind.ImportKeyword) continue;
    const next = tokens[i + 1];
    if (next === undefined) break;
    if (next.kind === SyntaxKind.OpenParenToken || next.kind === SyntaxKind.DotToken) continue;
    if (next.kind === SyntaxKind.StringLiteral) {
      clauses.push({ specifier: next.value, names: [], namespace: undefined, from: i, to: i + 1, start: tokens[i].start });
      i += 1;
      continue;
    }
    let cursor = i + 1;
    while (cursor < tokens.length
      && tokens[cursor].kind !== SyntaxKind.FromKeyword
      && tokens[cursor].kind !== SyntaxKind.SemicolonToken
      && tokens[cursor].kind !== SyntaxKind.ImportKeyword) cursor += 1;
    const specifier = tokens[cursor + 1];
    if (cursor >= tokens.length || tokens[cursor].kind !== SyntaxKind.FromKeyword) continue;
    if (specifier === undefined || specifier.kind !== SyntaxKind.StringLiteral) continue;
    const clauseIsTypeOnly = next.kind === SyntaxKind.TypeKeyword;
    const names: ImportedName[] = [];
    let namespace: string | undefined;
    for (let k = i + 1; k < cursor; k += 1) {
      if (tokens[k].kind === SyntaxKind.AsteriskToken && tokens[k + 1] !== undefined
        && tokens[k + 1].kind === SyntaxKind.AsKeyword && tokens[k + 2] !== undefined) {
        namespace = tokens[k + 2].text;
        k += 2;
        continue;
      }
      if (tokens[k].kind !== SyntaxKind.OpenBraceToken) continue;
      let entry = k + 1;
      while (entry < cursor && tokens[entry].kind !== SyntaxKind.CloseBraceToken) {
        let entryIsTypeOnly = false;
        const after = tokens[entry + 1];
        if (tokens[entry].kind === SyntaxKind.TypeKeyword && after !== undefined
          && after.kind !== SyntaxKind.CommaToken && after.kind !== SyntaxKind.CloseBraceToken
          && after.kind !== SyntaxKind.AsKeyword) {
          entryIsTypeOnly = true;
          entry += 1;
        }
        const imported = tokens[entry];
        if (imported === undefined) break;
        let local = imported;
        if (tokens[entry + 1] !== undefined && tokens[entry + 1].kind === SyntaxKind.AsKeyword
          && tokens[entry + 2] !== undefined) {
          local = tokens[entry + 2];
          entry += 2;
        }
        names.push({ imported: imported.text, local: local.text, typeOnly: entryIsTypeOnly || clauseIsTypeOnly });
        entry += 1;
        if (tokens[entry] !== undefined && tokens[entry].kind === SyntaxKind.CommaToken) entry += 1;
      }
      k = entry;
    }
    clauses.push({ specifier: specifier.value, names, namespace, from: i, to: cursor + 1, start: tokens[i].start });
    i = cursor + 1;
  }
  return clauses;
}

function importedLocals(
  clauses: readonly ImportClause[],
  specifier: string,
  imported: string,
): Set<string> {
  const locals = new Set<string>();
  for (const clause of clauses) {
    if (clause.specifier !== specifier) continue;
    for (const name of clause.names) if (name.imported === imported && !name.typeOnly) locals.add(name.local);
  }
  return locals;
}

function importedTokenRanges(clauses: readonly ImportClause[]): { from: number; to: number }[] {
  return clauses.map(clause => ({ from: clause.from, to: clause.to }));
}

/** The module a binding has to come from. A same-named export of another file is not this one. */
function warmupHelperModule(): string {
  return withoutTsExtension(helperPath("cold-spawn-warmup.ts"));
}

function withoutTsExtension(path: string): string {
  return path.endsWith(".ts") ? path.slice(0, -3) : path;
}

function importsTheWarmupHelper(fileName: string, specifier: string): boolean {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) return false;
  const resolved = isAbsolute(specifier) ? specifier : resolve(dirname(fileName), specifier);
  return withoutTsExtension(resolved) === warmupHelperModule();
}

/**
 * Where a name is bound to something other than its import: a declaration, an assignment, or a
 * parameter. A shadowed beforeAll takes a correct callback and runs nothing, so the hook name has
 * to be as provably the import as the warm-up name is.
 */
function rebindingOf(tokens: readonly Token[], name: string): Token | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== SyntaxKind.Identifier || token.text !== name) continue;
    if (isMemberName(tokens, i)) continue;
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    if (before !== undefined && DECLARATION_KEYWORDS.has(before.kind)) return token;
    if (after === undefined) continue;
    if (after.kind === SyntaxKind.EqualsToken) return token;
    if (after.kind === SyntaxKind.EqualsGreaterThanToken) return token;
    if (before !== undefined && before.kind === SyntaxKind.OpenParenToken
      && after.kind === SyntaxKind.CloseParenToken && tokens[i + 2] !== undefined
      && tokens[i + 2].kind === SyntaxKind.EqualsGreaterThanToken) return token;
  }
  return undefined;
}

/**
 * The call an open paren belongs to. Only a BARE identifier counts as the callee: describe.skip
 * and describe.each reach a suite this judge cannot claim runs, and reading them as describe is
 * how a hook inside a skipped suite would be recorded as a registration.
 */
function callFrame(tokens: readonly Token[], open: number): CallFrame {
  const name = tokens[open - 1];
  if (name === undefined || name.kind !== SyntaxKind.Identifier || isMemberName(tokens, open - 1)) {
    return { callee: "", open, statement: false };
  }
  const before = tokens[open - 2];
  return { callee: name.text, open, statement: before === undefined || STATEMENT_START.has(before.kind) };
}

/**
 * Whether an arrow is written directly as an argument of the call it sits in. A describe body and
 * a hook body are arguments; a helper assigned to a name is not, and that difference is the whole
 * distance between a hook that registers and one that never runs.
 */
function arrowIsArgument(tokens: readonly Token[], arrow: number, matches: readonly number[]): boolean {
  let k = arrow - 1;
  if (tokens[k] === undefined) return false;
  if (tokens[k].kind === SyntaxKind.CloseParenToken) {
    const open = matches[k];
    if (open < 0) return false;
    k = open - 1;
  } else if (tokens[k].kind === SyntaxKind.Identifier) {
    k -= 1;
  } else {
    return false;
  }
  if (tokens[k] !== undefined && tokens[k].kind === SyntaxKind.AsyncKeyword) k -= 1;
  const before = tokens[k];
  return before !== undefined
    && (before.kind === SyntaxKind.OpenParenToken || before.kind === SyntaxKind.CommaToken);
}

/** Whether a block brace opens a callback written directly as an argument, arrow or function. */
function opensArgumentCallback(tokens: readonly Token[], brace: number, matches: readonly number[]): boolean {
  const pre = tokens[brace - 1];
  if (pre === undefined) return false;
  if (pre.kind === SyntaxKind.EqualsGreaterThanToken) return arrowIsArgument(tokens, brace - 1, matches);
  if (pre.kind !== SyntaxKind.CloseParenToken) return false;
  const open = matches[brace - 1];
  if (open < 0) return false;
  let k = open - 1;
  if (tokens[k] !== undefined && tokens[k].kind === SyntaxKind.Identifier) k -= 1;
  if (tokens[k] === undefined || tokens[k].kind !== SyntaxKind.FunctionKeyword) return false;
  k -= 1;
  if (tokens[k] !== undefined && tokens[k].kind === SyntaxKind.AsyncKeyword) k -= 1;
  const before = tokens[k];
  return before !== undefined
    && (before.kind === SyntaxKind.OpenParenToken || before.kind === SyntaxKind.CommaToken);
}
