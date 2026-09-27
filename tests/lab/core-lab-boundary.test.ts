import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

/**
 * The proxy core must not reach Compatibility Lab.
 *
 * A user who configures one provider and one model -- no routing profile, no Lab -- must
 * execute no Lab code. These files carry every such user's request path, so an optional
 * subsystem may only reach them through a core-owned slot it registers into at activation.
 *
 * `src/server/index.ts` is deliberately NOT in this set: it is the composition root, whose
 * job is to know which optional subsystems exist. It is covered by a behavioral assertion
 * instead (see below).
 *
 * Invariant binding: INV-LAB-01 (structure/overview.md#non-negotiable-invariants).
 *
 * Design and rationale: devlog/_fin/260814_lab_core_decoupling/
 */
const PROTECTED = [
  "src/router.ts",
  "src/server/lifecycle.ts",
  "src/server/responses/core.ts",
  // The management API is mounted for every dashboard request, so eagerly importing the
  // Lab and routing-profile handlers put ~70 Lab modules on that path too. Its handlers
  // now load per namespace.
  "src/server/management-api.ts",
] as const;

// `fileURLToPath`, not `URL.pathname`: on Windows the latter yields "/C:/...", and
// resolving that against the cwd produced "C:\\C:\\..." -- so every guard below threw
// ENOENT instead of reading a file. A boundary test that cannot open its own sources
// reports a broken path as a failure and would report a real Lab import the same way,
// which means it was proving nothing on this platform.
const repoRoot = resolveRepoRoot();

/**
 * Runtime imports only: `import type` is erased and costs nothing at runtime.
 *
 * Covers static imports, side-effect imports, runtime re-exports, AND dynamic `import()`.
 *
 * Known limits, stated rather than implied: a static walker cannot resolve a computed
 * specifier, so `import(someVariable)` and template-literal specifiers are out of scope,
 * and bare `require()` is unavailable because this package is ESM (`"type": "module"`).
 * None of those forms is reachable in the protected files today.
 * Dynamic import was a real hole: an earlier version of this guard matched only the first
 * three forms, and `void import("./lab/paths")` in a protected file passed cleanly while
 * loading Lab at runtime. Found by attacking the guard rather than trusting it.
 */
const IMPORT_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), `${base}.mts`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Walk the runtime import graph and return the first path that reaches `src/lab/`. */
function firstLabPath(entry: string): string[] | null {
  const start = resolve(repoRoot, entry);
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!existsSync(current)) continue;
    const source = readFileSync(current, "utf8");
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec) continue;
      // A dynamic `import()` is a deferred edge, not a load-time one: the module graph is
      // only entered if that branch actually runs. Lazy loading behind a namespace or
      // activation check is precisely the remedy this guard exists to encourage, so a
      // dynamic specifier does not propagate the walk. Guard 1 still forbids a DIRECT
      // dynamic Lab import in a protected file, which is what stops it being a loophole.
      if (match[4] !== undefined) continue;
      const next = resolveSpec(spec, current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      // Compare on a slash-normalized path: `resolve`/`join` produce backslashes on
      // Windows, so a literal "/src/lab/" test silently matched nothing there and the
      // guard reported clean for every possible violation.
      if (next.replaceAll("\\", "/").includes("/src/lab/")) {
        const chain: string[] = [];
        let node: string | null = next;
        while (node) {
          // Repository-relative and slash-spelled, so the printed chain reads the same
          // on every platform and callers can match it without knowing the separator.
          chain.push(node.slice(repoRoot.length + 1).replaceAll("\\", "/"));
          node = previous.get(node) ?? null;
        }
        return chain.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * Guard 1's predicate, defined ONCE so the test that claims to protect it actually calls it.
 *
 * It previously lived inline in the assertion while the self-test below re-declared its own
 * copy of the regex — so the self-test proved a local literal behaved, not that the guard did.
 * A copy cannot fail when the original drifts, which is the specific way a guard rots.
 *
 * The trailing-slash forms are not sufficient either: `src/lab/index.ts` exists, so
 * `import("../lab")` resolves to the Lab entrypoint while matching none of them. The
 * directory specifier is matched explicitly.
 */
export function namesLabDirectly(source: string): boolean {
  return /^\s*(?:import|export)\s+(?!type\b)[^;]*?["'][^"']*\/lab(?:\/|["'])/m.test(source)
    || /^\s*import\s+["'][^"']*\/lab(?:\/|["'])/m.test(source)
    // A protected file may lazily reach Lab through a handler it imports, but must not
    // name Lab itself -- not even dynamically, and not as a bare directory.
    || /\bimport\s*\(\s*["'][^"']*\/lab(?:\/|["'])/.test(source);
}


/**
 * Guard 3: the activation window inside `startServer` must stay synchronous.
 *
 * `AGENTS.md` states this guarantee as if it were enforced, and
 * `devlog/_fin/260814_lab_core_decoupling/080_activation_is_synchronous.md:143` recorded it
 * as a Phase-4 test — but no such scan was ever written, so the invariant was held by
 * nothing except the current code being correct.
 *
 * The failure it guards against is silent. Everything between `Bun.serve` and the return
 * of `startServer` runs in one synchronous turn, which is what guarantees a policy route
 * can never be evaluated before its evidence provider is registered. Add one `await` in
 * that window and the synchronous subagent-fallback chain observes an empty slot and
 * routes subagents to a different model than the operator configured. Nothing goes red;
 * the wrong model simply answers.
 */
// The anchor carries the spend-ledger wrapper because the listener is registered for rollback
// at the moment it is created. It is still the same statement and still the start of the same
// window; what changed is the expression the listener is assigned from. An anchor that no
// longer matches makes every scan below measure an empty string, which is why they assert on it.
const SERVE_ANCHOR = "server = spendLedgerLifecycle.track(Bun.serve<WsData>({ ...serveOptions, port: listenPort, hostname: bindHost }));";
const ACTIVATION_ANCHOR = "if (labActivationRequired(config, labConfigDir)) {";
/**
 * The window ends at the RETURN, not at the activation check.
 *
 * Stopping at the activation anchor left two blind spots: an `await` inside the
 * `if (labActivationRequired(...))` body, and one between activation and `return server`.
 * AGENTS.md and `080_activation_is_synchronous.md` both state the guarantee as covering
 * everything from `Bun.serve` to the return, so a guard that stopped earlier was narrower
 * than the invariant it claimed to hold. Found by an independent review of this guard.
 */
const RETURN_ANCHOR = "  return server;";

/**
 * Blank comments and string bodies, preserving offsets and line breaks so reported line
 * numbers stay usable.
 *
 * This is not decoration. The window contains two comments that say the word "await" —
 * `src/server/index.ts:1853` ("this rollback cannot await") and `:1950` ("nowhere to
 * await") — so a naive text scan fails on correct code, and a guard that cries wolf on
 * `dev` gets deleted rather than fixed.
 *
 * Template interpolations are kept as code rather than blanked with the rest of the
 * template: `${await x()}` in a console.log is a real body-level await, and blanking the
 * whole template would hide exactly the violation this looks for.
 */
export function blankCommentsAndStrings(source: string): string {
  const out: string[] = [];
  // A stack, because a template interpolation can contain another template.
  const modes: Array<"code" | "template"> = ["code"];
  const depths: number[] = [0];
  let i = 0;
  const keep = (ch: string) => out.push(ch === "\n" ? "\n" : " ");
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (modes[modes.length - 1] === "template") {
      if (ch === "\\") { keep(ch); keep(next ?? " "); i += 2; continue; }
      if (ch === "`") { modes.pop(); depths.pop(); keep(ch); i++; continue; }
      if (ch === "$" && next === "{") {
        modes.push("code");
        depths.push(0);
        keep(ch); keep(next); i += 2; continue;
      }
      keep(ch); i++; continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { keep(source[i]!); i++; }
      continue;
    }
    if (ch === "/" && next === "*") {
      keep(ch); keep(next); i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) { keep(source[i]!); i++; }
      if (i < source.length) { keep("*"); keep("/"); i += 2; }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      keep(ch); i++;
      while (i < source.length) {
        if (source[i] === "\\") { keep(source[i]!); keep(source[i + 1] ?? " "); i += 2; continue; }
        if (source[i] === ch) { keep(source[i]!); i++; break; }
        keep(source[i]!); i++;
      }
      continue;
    }
    if (ch === "`") { modes.push("template"); depths.push(0); keep(ch); i++; continue; }
    if (ch === "{") { depths[depths.length - 1]! += 1; out.push(ch); i++; continue; }
    if (ch === "}") {
      if (depths[depths.length - 1] === 0 && modes.length > 1) {
        // Closes a `${` interpolation, not a block.
        modes.pop(); depths.pop(); keep(ch); i++; continue;
      }
      depths[depths.length - 1]! -= 1;
      out.push(ch); i++; continue;
    }
    out.push(ch); i++;
  }
  return out.join("");
}

/**
 * True when the `{` at `braceIndex` opens a function body rather than a block or an object
 * literal. Brace depth alone cannot answer this: the window contains try/catch and an `if`,
 * and the three legitimate awaits sit inside the async arrow assigned to `server.stop`,
 * which runs at shutdown rather than during startup.
 */
function opensFunctionBody(code: string, braceIndex: number): boolean {
  let j = braceIndex - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  if (j >= 1 && code[j] === ">" && code[j - 1] === "=") return true;
  if (code[j] !== ")") return false;
  let depth = 0;
  let k = j;
  for (; k >= 0; k--) {
    if (code[k] === ")") depth++;
    else if (code[k] === "(") { depth--; if (depth === 0) break; }
  }
  if (k < 0) return false;
  let m = k - 1;
  while (m >= 0 && /\s/.test(code[m]!)) m--;
  const end = m + 1;
  while (m >= 0 && /[\w$]/.test(code[m]!)) m--;
  const token = code.slice(m + 1, end);
  return !["if", "for", "while", "switch", "catch", "do", "with"].includes(token);
}

/**
 * 1-based line numbers (relative to `region`) of every `await` that would suspend
 * `startServer` itself. An await inside a nested function is fine — that code runs later.
 *
 * Stated limits: a computed member named `await`, and a regex literal containing the word,
 * are out of scope. Neither form is reachable in this window, and both would have to be
 * written deliberately.
 */
export function bodyLevelAwaitLines(region: string): number[] {
  const code = blankCommentsAndStrings(region);
  const hits: number[] = [];
  const stack: boolean[] = [];
  let line = 1;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "\n") { line++; continue; }
    if (ch === "{") { stack.push(opensFunctionBody(code, i)); continue; }
    if (ch === "}") { stack.pop(); continue; }
    if (ch !== "a" || code.slice(i, i + 5) !== "await") continue;
    const before = i > 0 ? code[i - 1]! : " ";
    const after = code[i + 5] ?? " ";
    if (/[\w$]/.test(before) || /[\w$]/.test(after)) continue;
    // `.await` would be a property access, not the operator.
    if (before === ".") continue;
    if (!stack.some(isFunctionBody => isFunctionBody)) hits.push(line);
    i += 4;
  }
  return hits;
}

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "async", "import",
  "typeof", "return", "case", "new", "class", "interface", "else", "do",
  "with", "of", "in", "as", "from", "void", "await", "yield", "delete",
  "throw", "using",
]);

function skipWs(code: string, i: number, dir: 1 | -1): number {
  while (i >= 0 && i < code.length && /\s/.test(code[i]!)) i += dir;
  return i;
}

function readIdentBack(code: string, last: number): { name: string; start: number } | null {
  if (last < 0 || last >= code.length || !/[\w$]/.test(code[last]!)) return null;
  let start = last;
  while (start > 0 && /[\w$]/.test(code[start - 1]!)) start--;
  if (!/[A-Za-z_$]/.test(code[start]!)) return null;
  return { name: code.slice(start, last + 1), start };
}

/** Skip a trailing `<TypeArgs>` immediately before a call, walking backward from `>`. */
function skipTypeArgsBack(code: string, j: number): number {
  if (j < 0 || code[j] !== ">") return j;
  let angle = 0;
  for (let k = j; k >= 0; k--) {
    const ch = code[k]!;
    if (ch === ">" && (k === 0 || code[k - 1] !== "=")) angle++;
    else if (ch === "<") {
      angle--;
      if (angle === 0) return skipWs(code, k - 1, -1);
    }
  }
  return j;
}

/**
 * Skip the expression of a concise arrow (`=> expr` without `{`) so a body-level
 * `.then(x => helper())` cannot be misread as startServer calling `helper`.
 *
 * The window contains exactly that shape: `primeCodexPoolQuotas` sits in a
 * concise `.then` callback. That callback runs after listen, so treating it as
 * a window callee would either fail resolution (it is a destructured binding,
 * not an import) or, worse, pin the wrong function's synchrony.
 *
 * Returns the index of the terminator (`)`, `,`, `;`) without consuming it.
 */
function skipConciseArrowBody(code: string, afterArrow: number): number {
  let i = skipWs(code, afterArrow, 1);
  if (i < code.length && code[i] === "{") return afterArrow;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  while (i < code.length) {
    const ch = code[i]!;
    if (paren === 0 && brace === 0 && bracket === 0 && (ch === ")" || ch === "," || ch === ";" || ch === "]")) {
      return i;
    }
    if (ch === "(") paren++;
    else if (ch === ")") {
      if (paren === 0) return i;
      paren--;
    } else if (ch === "{") brace++;
    else if (ch === "}") {
      if (brace === 0) return i;
      brace--;
    } else if (ch === "[") bracket++;
    else if (ch === "]") {
      if (bracket === 0) return i;
      bracket--;
    }
    i++;
  }
  return i;
}

export type BodyLevelCalls = {
  free: string[];
  receiver: string[];
};

/**
 * Body-level call sites in `region`, split into free function names and
 * receiver expressions. Nested functions (including concise arrows) are
 * skipped: those run later, the same distinction `bodyLevelAwaitLines` makes
 * for `await`.
 *
 * Depth is one on purpose. Walking every function those callees invoke would
 * treat dynamic dispatch (`.then`, `.map`, registry lookups) as startup
 * callees and fail on helpers that never run during `startServer`. The actual
 * regression — `activateLab` (or any other window callee) becoming `async` —
 * is visible on the direct callee; a deeper walk would add false positives
 * without catching more of that bug.
 */
export function collectBodyLevelCalls(region: string): BodyLevelCalls {
  const code = blankCommentsAndStrings(region);
  const free = new Set<string>();
  const receiver = new Set<string>();
  const stack: boolean[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === "{") {
      stack.push(opensFunctionBody(code, i));
      i++;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i++;
      continue;
    }
    if (ch === "=" && code[i + 1] === ">") {
      const skipped = skipConciseArrowBody(code, i + 2);
      if (skipped !== i + 2) {
        i = skipped;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch !== "(") {
      i++;
      continue;
    }
    if (stack.some(isFunctionBody => isFunctionBody)) {
      i++;
      continue;
    }
    const classified = classifyBodyLevelCall(code, i);
    if (classified.kind === "free") free.add(classified.name);
    else if (classified.kind === "receiver") receiver.add(classified.expr);
    i++;
  }
  return { free: [...free], receiver: [...receiver] };
}

type ClassifiedCall =
  | { kind: "skip" }
  | { kind: "free"; name: string }
  | { kind: "receiver"; expr: string };

function classifyBodyLevelCall(code: string, parenIndex: number): ClassifiedCall {
  let j = skipWs(code, parenIndex - 1, -1);
  // `foo?.(` optional-calls the binding, not a method.
  if (j >= 1 && code[j] === "." && code[j - 1] === "?") j = skipWs(code, j - 2, -1);
  if (j >= 0 && code[j] === ">") j = skipTypeArgsBack(code, j);
  const ident = readIdentBack(code, j);
  if (!ident) return { kind: "skip" };
  j = skipWs(code, ident.start - 1, -1);
  // `...createResetCreditWhamClient(` is a spread of a call, not `obj.method(`.
  // The last `.` of `...` would otherwise classify the callee as a receiver and
  // hide it from declaration inspection — the exact way this scan goes vacuous.
  const isSpread = j >= 2 && code[j] === "." && code[j - 1] === "." && code[j - 2] === ".";
  const isMember = !isSpread && j >= 0 && (code[j] === "." || (j >= 1 && code[j] === "?" && code[j - 1] === "."));
  if (isMember) {
    return { kind: "receiver", expr: formatReceiverFromWalk(code, ident) };
  }
  const prev = readIdentBack(code, j);
  // `new Foo(` is a constructor. Class constructors cannot be async; replacing
  // this with `await Foo.create()` is already a body-level await and Guard 3's
  // existing scan would catch it. Treating the class name as a free function
  // would fail to find `function Foo` and rot into UNRESOLVED_CALLEES.
  if (prev?.name === "new" || prev?.name === "function") return { kind: "skip" };
  if (CALL_KEYWORDS.has(ident.name)) return { kind: "skip" };
  return { kind: "free", name: ident.name };
}

function formatReceiverFromWalk(code: string, rightmost: { name: string; start: number }): string {
  type Part = { name: string; optional: boolean };
  const chain: Part[] = [{ name: rightmost.name, optional: false }];
  let j = skipWs(code, rightmost.start - 1, -1);
  while (j >= 0) {
    let optional = false;
    if (j >= 1 && code[j] === "." && code[j - 1] === "?") {
      optional = true;
      j = skipWs(code, j - 2, -1);
    } else if (code[j] === ".") {
      j = skipWs(code, j - 1, -1);
    } else {
      break;
    }
    if (j >= 0 && code[j] === ">") j = skipTypeArgsBack(code, j);
    const ident = readIdentBack(code, j);
    if (!ident) {
      chain[0] = { ...chain[0], optional };
      return "(...)" + chain.map(p => (p.optional ? "?." : ".") + p.name).join("") + "()";
    }
    chain[0] = { ...chain[0], optional };
    chain.unshift({ name: ident.name, optional: false });
    j = skipWs(code, ident.start - 1, -1);
  }
  const head = chain[0]!.name;
  const tail = chain.slice(1).map(p => (p.optional ? "?." : ".") + p.name).join("");
  return head + tail + "()";
}

export type FunctionSyncInspection = {
  found: boolean;
  async: boolean;
  awaitLines: number[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchPair(code: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "=" && code[i + 1] === ">") { i++; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function skipWsFwd(code: string, i: number): number {
  return skipWs(code, i, 1);
}

/**
 * After `function name`, skip generics and the parameter list.
 * Returns the index of the first character after the closing `)`.
 */
function skipParamList(code: string, i: number): number {
  i = skipWsFwd(code, i);
  if (code[i] === "<") {
    const end = matchPair(code, i, "<", ">");
    if (end < 0) return -1;
    i = skipWsFwd(code, end);
  }
  if (code[i] !== "(") return -1;
  return matchPair(code, i, "(", ")");
}

/**
 * Skip a TypeScript return type after `:`. The function body `{` is the `{`
 * that appears at depth 0 once a primary type has already been consumed — so
 * `): void {` and `): { inspect: () => T } {` both land on the body, not the
 * object type. If we took the first `{` after `:`, `createResetCreditWhamClient`
 * would be inspected as an empty object type and its real body (and any await
 * added there) would go unseen.
 */
function skipReturnType(code: string, colonIndex: number): number {
  let i = colonIndex + 1;
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let brace = 0;
  let sawPrimary = false;
  while (i < code.length) {
    const ch = code[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "=" && code[i + 1] === ">") { i += 2; sawPrimary = true; continue; }
    const atTop = paren === 0 && bracket === 0 && angle === 0 && brace === 0;
    if (ch === "{" && atTop) {
      if (sawPrimary) return i;
      brace++;
      sawPrimary = true;
      i++;
      continue;
    }
    if (ch === "(") { paren++; sawPrimary = true; i++; continue; }
    if (ch === ")") { if (paren === 0) return -1; paren--; i++; continue; }
    if (ch === "[") { bracket++; sawPrimary = true; i++; continue; }
    if (ch === "]") { if (bracket === 0) return -1; bracket--; i++; continue; }
    if (ch === "{") { brace++; i++; continue; }
    if (ch === "}") { if (brace === 0) return -1; brace--; i++; continue; }
    if (ch === "<") { angle++; i++; continue; }
    if (ch === ">") { if (angle > 0) angle--; i++; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      sawPrimary = true;
      i++;
      while (i < code.length && /[\w$]/.test(code[i]!)) i++;
      continue;
    }
    i++;
  }
  return -1;
}

function extractFunctionBody(code: string, afterName: number): string | null {
  const afterParams = skipParamList(code, afterName);
  if (afterParams < 0) return null;
  let i = skipWsFwd(code, afterParams);
  if (code[i] === ":") {
    i = skipReturnType(code, i);
    if (i < 0) return null;
  }
  i = skipWsFwd(code, i);
  if (code[i] !== "{") return null;
  const end = matchPair(code, i, "{", "}");
  if (end < 0) return null;
  return code.slice(i, end);
}

/**
 * Text-level inspection of a named `function` declaration in `source`.
 *
 * This is deliberately not a parser. `export function f() { await p; }` is a
 * syntax error without `async`, but it is also exactly the edit a hurried
 * conversion to async forgets to finish — and the silent failure this guard
 * exists to catch. A real parser would refuse the input; a text scan reports it.
 */
export function inspectFunctionDeclaration(source: string, name: string): FunctionSyncInspection {
  const code = blankCommentsAndStrings(source);
  const ident = escapeRegExp(name);
  const fnRe = new RegExp("(export\\s+)?(async\\s+)?function\\s+" + ident + "\\b");
  const match = fnRe.exec(code);
  if (!match || match.index === undefined) return { found: false, async: false, awaitLines: [] };
  const async = Boolean(match[2]);
  const afterName = match.index + match[0].length;
  const body = extractFunctionBody(code, afterName);
  if (body === null) return { found: true, async, awaitLines: [] };
  return { found: true, async, awaitLines: bodyLevelAwaitLines(body) };
}

/** Inspect every concrete `start` implementation shape used by optional listener lifecycles. */
export function inspectStartDefinitions(source: string): FunctionSyncInspection[] {
  const code = blankCommentsAndStrings(source);
  const found: FunctionSyncInspection[] = [];
  const methodRe = /(?:^|[,{]\s*)(async\s+)?start\s*(?=\()/gm;
  let match: RegExpExecArray | null;
  while ((match = methodRe.exec(code)) !== null) {
    const nameIndex = match.index + match[0].lastIndexOf("start");
    const body = extractFunctionBody(code, nameIndex + "start".length);
    if (body !== null) found.push({ found: true, async: Boolean(match[1]), awaitLines: bodyLevelAwaitLines(body) });
  }
  const arrowRe = /\bstart\s*:\s*(async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g;
  while ((match = arrowRe.exec(code)) !== null) {
    const bodyStart = code.indexOf("{", match.index + match[0].length);
    if (bodyStart < 0) continue;
    const end = matchPair(code, bodyStart, "{", "}");
    if (end < 0) continue;
    found.push({ found: true, async: Boolean(match[1]), awaitLines: bodyLevelAwaitLines(code.slice(bodyStart, end)) });
  }
  const declaration = inspectFunctionDeclaration(code, "start");
  if (declaration.found) found.push(declaration);
  return found;
}

type SpecBinding = { local: string; exported: string };

function parseSpecList(inner: string): SpecBinding[] {
  const bindings: SpecBinding[] = [];
  for (const raw of inner.split(",")) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0] === "type") continue;
    if (tokens.length >= 3 && tokens[1] === "as") {
      bindings.push({ exported: tokens[0]!, local: tokens[2]! });
      continue;
    }
    if (tokens.length >= 1 && /^[A-Za-z_$]/.test(tokens[0]!)) {
      bindings.push({ exported: tokens[0]!, local: tokens[0]! });
    }
  }
  return bindings;
}

function namedImportsOf(source: string): Map<string, { spec: string; exported: string }> {
  // Do not blank strings first: that erases the specifier, so every import
  // looks like `from "     "` and resolveSpec returns null. A comment that
  // happens to contain `import { foo } from "./bar"` is not a form this file uses.
  const code = source;
  const out = new Map<string, { spec: string; exported: string }>();
  const re = /^\s*import\s+(?!type\b)(?:[^{;]+?,\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const spec = match[2]!;
    for (const binding of parseSpecList(match[1]!)) {
      out.set(binding.local, { spec, exported: binding.exported });
    }
  }
  return out;
}

function reexportOf(source: string, name: string): { spec: string; exported: string } | null {
  const code = source;
  const re = /^\s*export\s+\{([^}]+)\}\s*from\s*["']([^"']+)["']/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    for (const binding of parseSpecList(match[1]!)) {
      if (binding.local === name) return { spec: match[2]!, exported: binding.exported };
    }
  }
  return null;
}

export type ResolvedCallee = {
  file: string;
  inspection: FunctionSyncInspection;
};

function repoRel(file: string): string {
  return file.slice(repoRoot.length + 1).replaceAll("\\", "/");
}

/**
 * Resolve a free-function name used by `src/server/index.ts` to the module that
 * declares it. Re-export hops are followed because two of the window's callees
 * (`isCanonicalOpenAiForwardProvider`, `createResetCreditWhamClient`) and
 * `getConfigDir` are imported through a barrel that only re-exports them.
 * Stopping at the import target would report those names as missing and push
 * them onto UNRESOLVED_CALLEES, which is how this scan would go vacuous.
 *
 * This is still depth 1 on the *call* graph: we inspect that declaration, we
 * do not walk the functions it calls.
 */
export function resolveImportedCallee(
  name: string,
  fromFile: string,
  fromSource: string,
): ResolvedCallee | null {
  const imports = namedImportsOf(fromSource);
  const imported = imports.get(name);
  if (imported) {
    const file = resolveSpec(imported.spec, fromFile);
    if (!file) return null;
    return resolveDeclarationFollowingReexports(file, imported.exported);
  }
  const local = inspectFunctionDeclaration(fromSource, name);
  if (!local.found) return null;
  return { file: fromFile, inspection: local };
}

function resolveDeclarationFollowingReexports(file: string, name: string): ResolvedCallee | null {
  const visited = new Set<string>();
  let currentFile = file;
  let currentName = name;
  for (let hop = 0; hop < 8; hop++) {
    const key = `${currentFile}::${currentName}`;
    if (visited.has(key)) return null;
    visited.add(key);
    if (!existsSync(currentFile)) return null;
    const source = readFileSync(currentFile, "utf8");
    const inspection = inspectFunctionDeclaration(source, currentName);
    if (inspection.found) return { file: currentFile, inspection };
    const next = reexportOf(source, currentName);
    if (!next) return null;
    const resolved = resolveSpec(next.spec, currentFile);
    if (!resolved) return null;
    currentFile = resolved;
    currentName = next.exported;
  }
  return null;
}


/**
 * A declaration the activation walk can inspect: a named `function` OR a const arrow.
 *
 * inspectFunctionDeclaration knows only the first form, which is enough for the window's
 * direct callees but not for the chain below it: activationKey and every returned cleanup
 * receipt in the Lab activation path are const arrows, and a walk that cannot see them would
 * report the most interesting nodes as "declaration not found".
 */
export type ActivationDeclaration = {
  found: boolean;
  async: boolean;
  awaitLines: number[];
  body: string | null;
};

export function inspectActivationDeclaration(source: string, name: string): ActivationDeclaration {
  const code = blankCommentsAndStrings(source);
  const ident = escapeRegExp(name);
  const fn = new RegExp("(export\\s+)?(async\\s+)?function\\s+" + ident + "\\b").exec(code);
  if (fn && fn.index !== undefined) {
    const body = extractFunctionBody(code, fn.index + fn[0].length);
    return { found: true, async: Boolean(fn[2]), awaitLines: body === null ? [] : bodyLevelAwaitLines(body), body };
  }
  const arrow = new RegExp("(?:export\\s+)?(?:const|let|var)\\s+" + ident + "\\s*(?::[^=\\n]+)?=\\s*(async\\s+)?").exec(code);
  if (!arrow || arrow.index === undefined) return { found: false, async: false, awaitLines: [], body: null };
  const body = extractArrowBody(code, arrow.index + arrow[0].length);
  if (body === null) return { found: false, async: false, awaitLines: [], body: null };
  return { found: true, async: Boolean(arrow[1]), awaitLines: bodyLevelAwaitLines(body), body };
}

/** The body of an arrow at `afterEquals`, brace form or concise form. */
function extractArrowBody(code: string, afterEquals: number): string | null {
  let i = skipWsFwd(code, afterEquals);
  if (code[i] === "(") {
    const afterParams = skipParamList(code, i);
    if (afterParams < 0) return null;
    i = skipWsFwd(code, afterParams);
    if (code[i] === ":") {
      i = skipArrowReturnType(code, i);
      if (i < 0) return null;
      i = skipWsFwd(code, i);
    }
  } else {
    while (i < code.length && /[\w$]/.test(code[i]!)) i += 1;
    i = skipWsFwd(code, i);
  }
  if (code[i] !== "=" || code[i + 1] !== ">") return null;
  const afterArrow = i + 2;
  const concise = skipConciseArrowBody(code, afterArrow);
  if (concise !== afterArrow) return code.slice(afterArrow, concise);
  const brace = skipWsFwd(code, afterArrow);
  if (code[brace] !== "{") return null;
  const end = matchPair(code, brace, "{", "}");
  return end < 0 ? null : code.slice(brace, end);
}

/**
 * Skip an arrow's return-type annotation, stopping at the arrow itself.
 *
 * skipReturnType cannot be reused: it treats a top-level `=>` as part of a function-TYPE
 * annotation and keeps scanning for the body brace, which a concise arrow never has. Feeding
 * it `activationKey` returned -1, and the most interesting nodes in the chain are const arrows.
 */
function skipArrowReturnType(code: string, colonIndex: number): number {
  let i = colonIndex + 1;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  while (i < code.length) {
    const ch = code[i]!;
    const atTop = paren === 0 && bracket === 0 && brace === 0 && angle === 0;
    if (atTop && ch === "=" && code[i + 1] === ">") return i;
    if (ch === "(") paren++;
    else if (ch === ")") { if (paren === 0) return -1; paren--; }
    else if (ch === "[") bracket++;
    else if (ch === "]") { if (bracket === 0) return -1; bracket--; }
    else if (ch === "{") brace++;
    else if (ch === "}") { if (brace === 0) return -1; brace--; }
    else if (ch === "<") angle++;
    else if (ch === ">") { if (angle > 0) angle--; }
    i++;
  }
  return -1;
}

export type ActivationNode = {
  name: string;
  file: string;
  async: boolean;
  awaitLines: number[];
  callees: string[];
};

export type ActivationWalk = {
  nodes: Map<string, ActivationNode>;
  failures: string[];
  /** Free names deliberately not followed, as actually encountered. */
  skipped: Set<string>;
  /** Free names resolved to a module outside this repository. */
  external: Set<string>;
};

type ActivationResolution =
  | { kind: "declared"; file: string; source: string; declaration: ActivationDeclaration }
  | { kind: "external"; spec: string }
  | { kind: "missing" };

function resolveActivationCallee(
  name: string,
  fromFile: string,
  fromSource: string,
  load: (file: string) => string,
): ActivationResolution {
  const imported = namedImportsOf(fromSource).get(name);
  if (!imported) {
    const local = inspectActivationDeclaration(fromSource, name);
    return local.found ? { kind: "declared", file: fromFile, source: fromSource, declaration: local } : { kind: "missing" };
  }
  // A non-relative specifier leaves this repository: node: builtins and packages. Their
  // synchrony is not ours to assert, and pinning every join/readFileSync by hand would turn
  // the classification list into noise that hides the two or three names worth reviewing.
  if (!imported.spec.startsWith(".")) return { kind: "external", spec: imported.spec };
  let file = resolveSpec(imported.spec, fromFile);
  if (!file) return { kind: "missing" };
  let exported = imported.exported;
  for (let hop = 0; hop < 8; hop++) {
    if (!existsSync(file)) return { kind: "missing" };
    const source = load(file);
    const declaration = inspectActivationDeclaration(source, exported);
    if (declaration.found) return { kind: "declared", file, source, declaration };
    const next = reexportOf(source, exported);
    if (!next) return { kind: "missing" };
    const resolved = resolveSpec(next.spec, file);
    if (!resolved) return { kind: "missing" };
    file = resolved;
    exported = next.exported;
  }
  return { kind: "missing" };
}

/**
 * Walk the activation call graph from `activateLab` and report every node that could suspend it.
 *
 * Depth one was the defect. `activateLab` calls installLabAutomationRuntime and
 * startAutomationIfEnabled without awaiting them, so making either async with an await before
 * its registration call left `activateLab` parsing as synchronous and the guard green while the
 * window it protects was already broken.
 *
 * Two things make a recursive walk usable here rather than a source of false positives.
 * Nested functions are skipped by collectBodyLevelCalls, so a timer callback, a shutdown hook,
 * a promise continuation and the deferred route executor are not treated as activation edges —
 * they run later by construction. And receiver calls are not followed: a method that becomes
 * async cannot suspend its caller unless the caller awaits it, and an await is exactly what
 * bodyLevelAwaitLines reports on the caller's own body.
 */
export function walkActivationChain(options: {
  root: string;
  entryFile: string;
  entrySource: string;
  notWalked: ReadonlySet<string>;
  loadSource?: (file: string) => string;
  maxNodes?: number;
}): ActivationWalk {
  const load = options.loadSource ?? ((file: string) => readFileSync(file, "utf8"));
  const maxNodes = options.maxNodes ?? 200;
  const nodes = new Map<string, ActivationNode>();
  const failures: string[] = [];
  const skipped = new Set<string>();
  const external = new Set<string>();
  const queue: Array<{ name: string; fromFile: string; fromSource: string }> = [
    { name: options.root, fromFile: options.entryFile, fromSource: options.entrySource },
  ];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (nodes.has(item.name)) continue;
    if (nodes.size >= maxNodes) {
      failures.push("activation chain exceeded " + maxNodes + " nodes; the walk is no longer bounded");
      break;
    }
    const resolved = resolveActivationCallee(item.name, item.fromFile, item.fromSource, load);
    if (resolved.kind === "external") { external.add(item.name); continue; }
    if (resolved.kind === "missing") {
      failures.push(item.name + ": declaration not found from " + repoRel(item.fromFile));
      continue;
    }
    const { declaration } = resolved;
    const where = item.name + " in " + repoRel(resolved.file);
    if (declaration.async) failures.push(where + ": declared async");
    if (declaration.awaitLines.length > 0) {
      failures.push(where + ": body-level await at relative line " + declaration.awaitLines.join(","));
    }
    const callees = declaration.body === null ? [] : collectBodyLevelCalls(declaration.body).free;
    nodes.set(item.name, {
      name: item.name,
      file: repoRel(resolved.file),
      async: declaration.async,
      awaitLines: declaration.awaitLines,
      callees: [...callees].sort(),
    });
    for (const callee of callees) {
      if (options.notWalked.has(callee)) { skipped.add(callee); continue; }
      if (nodes.has(callee)) continue;
      queue.push({ name: callee, fromFile: resolved.file, fromSource: resolved.source });
    }
  }
  return { nodes, failures, skipped, external };
}

describe("core / Compatibility Lab boundary", () => {
  // Guard 1: the obvious case, a direct import.
  test.each(PROTECTED)("%s has no direct src/lab import", file => {
    expect(namesLabDirectly(readFileSync(resolve(repoRoot, file), "utf8"))).toBe(false);
  });

  // Guard 2: the case that actually caused this work. The original defect reached Lab
  // through assemble -> quota -> auth-api -> native-main-admission -> lifecycle -> Lab,
  // where no single file looked wrong. Text matching alone would have missed it.
  test.each(PROTECTED)("%s reaches no src/lab module transitively", file => {
    const chain = firstLabPath(file);
    // Print the full chain on failure: a bare verdict would send the next maintainer on
    // the same multi-hour hunt this unit required.
    expect(chain === null ? "clean" : chain.join(" -> ")).toBe("clean");
  });
});

/**
 * A guard nobody attacks is a guard nobody can trust. These synthesize each import form
 * against a temporary file and assert the walker sees it, so the walker cannot silently
 * regress into matching only the shapes that happen to exist today.
 *
 * The dynamic-import case is here because it was a REAL hole: `void import("./lab/paths")`
 * in a protected file passed the original guard while loading Lab at runtime.
 */
describe("boundary guard cannot be defeated", () => {
  // Load-time edges: the graph walk must follow these.
  const attacks: Array<[string, string]> = [
    ["static import", 'import { labRoot } from "../lab/paths";'],
    ["side-effect import", 'import "../lab/paths";'],
    ["runtime re-export", 'export { labRoot } from "../lab/paths";'],
  ];

  test.each(attacks)("detects a %s", (_label, line) => {
    const probe = join(repoRoot, "src", "server", `__boundary_probe_${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(probe, line + '\nexport const probe = 1;\n');
    try {
      const chain = firstLabPath(probe.slice(repoRoot.length + 1));
      expect(chain).not.toBeNull();
      expect(chain!.join(" -> ")).toContain("lab/paths.ts");
    } finally {
      rmSync(probe, { force: true });
    }
  });


  // A dynamic import is a DEFERRED edge, so the graph walk deliberately does not follow it
  // -- lazy loading is the remedy, not the defect. Guard 1 is what stops a protected file
  // from naming Lab dynamically, so the coverage moves there rather than disappearing.
  test("guard 1 forbids a direct dynamic Lab import in a protected file", () => {
    // Calls the SAME predicate the guard uses, so a drift in one cannot pass in the other.
    expect(namesLabDirectly('void import("../lab/paths");')).toBe(true);
    // A bare directory specifier resolves to src/lab/index.ts and must be caught too --
    // matching only `/lab/` left this shape as a silent way through.
    expect(namesLabDirectly('void import("../lab");')).toBe(true);
    expect(namesLabDirectly('import "../lab";')).toBe(true);
    expect(namesLabDirectly('import { x } from "../lab";')).toBe(true);
    // A module whose NAME merely contains "lab" is not Lab.
    expect(namesLabDirectly('const m = await import("./management/lab-routes");')).toBe(false);
    expect(namesLabDirectly('import { x } from "./collaboration";')).toBe(false);
    for (const file of PROTECTED) {
      expect(namesLabDirectly(readFileSync(resolve(repoRoot, file), "utf8"))).toBe(false);
    }
  });

  // `import type` is erased at build time, so it must NOT be treated as a runtime edge.
  test("ignores type-only imports", () => {
    const probe = join(repoRoot, "src", "server", `__boundary_probe_type_${Math.random().toString(36).slice(2)}.ts`);
    const line = 'import type { CompatibilityVerdict } from "../lab/constants";';
    writeFileSync(probe, line + '\nexport type P = CompatibilityVerdict;\n');
    try {
      expect(firstLabPath(probe.slice(repoRoot.length + 1))).toBeNull();
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

describe("activation window stays synchronous", () => {
  const indexPath = resolve(repoRoot, "src/server/index.ts");
  const source = readFileSync(indexPath, "utf8");


  /**
   * Receiver method calls in the activation window cannot be resolved to a
   * `function` declaration from the call site: the receiver is an object, a
   * builtin, or a call result. Pinning the exact set forces a review when a
   * new `obj.method()` appears in the window — the alternative is silently
   * skipping it, which is how `activateLab` becoming async would have a twin
   * that this scan never sees.
   */
  const SYNC_WINDOW_RECEIVER_CALLS: Record<string, string> = {
    "Bun.serve()": "Bun runtime API. serve() returns a Server synchronously; an async serve would be a Bun change, not ours. The existing body-level await scan would still catch `await Bun.serve()`.",
    "server.stop()": "Server.stop on the just-created listener, invoked as `void server.stop(true)` in the loopback-bind rollback. The Promise is discarded, so even an async stop does not suspend startServer; `await server.stop()` is already a Guard-3 failure.",
    "bound.stop()": "The same Server.stop on the loop variable of the management-ingress bind rollback. Same fire-and-forget shape as server.stop().",
    "userCostOverlayReconciler?.stop()": "Instance method on the overlay reconciler. The local binding is typed `{ stop(): void } | null`; the call site cannot see the implementation in user-cost-overlay-reconciler.ts.",
    "backgroundLifecycle?.releaseAfterFailedStart()": "Instance method from acquireServerBackgroundLifecycle in src/server/background-lifecycle.ts. Optional because the catch path can run before the lifecycle is assigned. That module owns the method's synchrony.",
    "nativeMainLifecycle.release()": "Instance method on NativeMainStartupLifecycle. Called as `void nativeMainLifecycle.release()` so a Promise return would not suspend startServer; `await nativeMainLifecycle.release()` would already fail Guard 3.",
    "server.stop.bind()": "Function.prototype.bind snapshotting the original stop before Object.defineProperty replaces it. bind itself is synchronous.",
    "Object.defineProperty()": "Language builtin used to install the async stop wrapper. The wrapper's awaits run at shutdown, not during startServer. An `await Object.defineProperty(...)` would already fail Guard 3.",
    "console.log()": "stdout. Cannot suspend startServer.",
    "console.warn()": "stderr. Cannot suspend startServer.",
    "(...).then()": "Promise.then on the fire-and-forget `import('../codex/plan-from-token')` chain. then() registers a callback and returns immediately; the callback is a nested function this scan skips. Awaiting the import would already fail Guard 3.",
    "(...).catch()": "Promise.catch on that same dynamic-import chain. Same fire-and-forget: it cannot suspend startServer.",
    "backgroundLifecycle.scheduleStartupRun()": "src/server/background-lifecycle.ts owns this object method. The call site cannot resolve the declaration statically; scheduleStartupRun is declared `(): void` and is documented as never blocking listen.",
    "optionalListeners.start()": "Instance method on OptionalListenerSet. Declared `(ctx): void`; it binds the optional link listener synchronously and starts the existing Claude intercept fire-and-forget lifecycle. Its stop() runs inside the async stop wrapper, which this scan skips.",
    "spendLedgerLifecycle.track()": "Instance method on the lifecycle from acquireSpendLedgerServerLifecycle in src/server/index/spend-ledger-lifecycle.ts, called on each listener as it is created. It binds the listener's stop, records a rollback closure and returns the same server; it is declared `<T>(server: T): T` and contains no await. An `await spendLedgerLifecycle.track(...)` would already fail Guard 3. The lifecycle's release() is not here because it is called inside the async stop wrapper, which this scan skips as a nested function.",
  };

  /**
   * Free identifiers the window calls whose declaration is not a named `function`
   * this scan can inspect. Quietly skipping them would make the scan vacuous:
   * a later edit that turns the binding into `const foo = async () => ...` and
   * then `await foo()` is Guard 3, but `foo()` without await of an async
   * function is the hole this list exists to keep visible.
   */
  const UNRESOLVED_CALLEES: Record<string, string> = {
    unregisterQuotaAutoRefresh: "let-binding holding the return of registerCodexQuotaAutoRefreshWorker, optional-called on the bind-failure path. There is no `function unregisterQuotaAutoRefresh` to inspect; following the assignment would be depth 2.",
  };


  test("startServer is not async", () => {
    // An async startServer returns a Promise, so every caller treating the return value as a
    // live Server would break. The subtler cost is that it makes a body-level await legal,
    // which is the ordering this describe block exists to protect.
    // Assert on a boolean, not on `source`: a raw `expect(source)` failure prints the whole
    // 5000-line file and buries the finding it just made.
    const declaration = /export\s+(async\s+)?function\s+startServer\s*\(/.exec(source);
    expect(declaration?.[0] ?? "startServer declaration not found").toBe(
      "export function startServer(",
    );
  });

  test("no body-level await sits between Bun.serve and Lab activation", () => {
    const start = source.indexOf(SERVE_ANCHOR);
    const end = source.indexOf(RETURN_ANCHOR, start);
    const activation = source.indexOf(ACTIVATION_ANCHOR);

    // Fail loudly if any anchor moves. A window that silently collapses to nothing is the
    // way this guard would rot into a test that passes by measuring an empty string.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // The activation check must sit INSIDE the window. If it drifted out, the scan would
    // still be green while no longer covering the ordering it exists to protect.
    expect(activation).toBeGreaterThan(start);
    expect(activation).toBeLessThan(end);

    const region = source.slice(start, end);
    const offsetLine = source.slice(0, start).split("\n").length;
    const absolute = bodyLevelAwaitLines(region).map(relative => offsetLine + relative - 1);

    expect(absolute).toEqual([]);
  });

  test("the scan ignores comments, strings, and nested functions but catches a real await", () => {
    // Guard-on-the-guard. The window really does contain the word "await" twice in prose
    // (src/server/index.ts:1853 and :1950) and three real awaits inside the server.stop
    // closure, so a scan that cannot tell those apart either fails on correct code or
    // passes on broken code. Both directions are pinned here.
    expect(bodyLevelAwaitLines("// cannot await here\nvoid 0;\n")).toEqual([]);
    expect(bodyLevelAwaitLines("/* nowhere to await */\nvoid 0;\n")).toEqual([]);
    expect(bodyLevelAwaitLines("const s = \"await x\";\n")).toEqual([]);
    expect(bodyLevelAwaitLines("const t = `await ${y}`;\n")).toEqual([]);

    // Inside a later-running function: allowed, exactly like the server.stop closure.
    expect(bodyLevelAwaitLines("value: async () => {\n  await stop();\n},\n")).toEqual([]);
    expect(bodyLevelAwaitLines("f(async () => {\n  await g();\n});\n")).toEqual([]);

    // Blocks are not function bodies, so an await inside if/try/for still suspends the
    // enclosing function and must be reported.
    expect(bodyLevelAwaitLines("await first();\n")).toEqual([1]);
    expect(bodyLevelAwaitLines("if (flag) {\n  await gate();\n}\n")).toEqual([2]);
    const emptyCatch = `catch ${"{"}${"}"}`;
    expect(bodyLevelAwaitLines(`try {\n  await risky();\n} ${emptyCatch}\n`)).toEqual([2]);
    expect(bodyLevelAwaitLines("for (const x of xs) {\n  await x;\n}\n")).toEqual([2]);
    expect(bodyLevelAwaitLines("for await (const x of xs) {\n  void x;\n}\n")).toEqual([1]);

    // A template interpolation is code, not string body.
    expect(bodyLevelAwaitLines("console.log(`${await port()}`);\n")).toEqual([1]);

    // Identifiers that merely contain the word are not the operator.
    expect(bodyLevelAwaitLines("const awaited = 1;\nvoid awaited;\n")).toEqual([]);
    expect(bodyLevelAwaitLines("thing.await();\n")).toEqual([]);
  });

  test("the real window contains the awaits it is supposed to tolerate", () => {
    // If the server.stop closure were ever moved out of the window, the tolerance branch
    // above would stop being exercised by real code and this suite would quietly narrow to
    // synthetic strings only.
    const start = source.indexOf(SERVE_ANCHOR);
    const end = source.indexOf(RETURN_ANCHOR, start);
    const region = source.slice(start, end);

    expect(region.includes("await runListenerShutdown(")).toBe(true);
    expect(region.includes("await backgroundLifecycle.release();")).toBe(true);
    expect(bodyLevelAwaitLines(region)).toEqual([]);
  });

  test("functions the window calls are synchronous", () => {
    // Guard 3's text scan of the window cannot see `activateLab` becoming
    // `async`: the call site has no `await`, so the existing four tests stay
    // green while startServer proceeds past a now-thenable activation and a
    // policy route can evaluate before its evidence provider is registered.
    // This test follows each body-level free call to its declaration (one hop,
    // plus re-export aliases) and fails if that declaration is async or has a
    // body-level await. Receiver methods go on SYNC_WINDOW_RECEIVER_CALLS
    // instead of being skipped: a new `obj.method()` in the window must be
    // reviewed rather than silently ignored.
    const start = source.indexOf(SERVE_ANCHOR);
    const end = source.indexOf(RETURN_ANCHOR, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = source.slice(start, end);
    const calls = collectBodyLevelCalls(region);

    expect([...calls.receiver].sort()).toEqual(Object.keys(SYNC_WINDOW_RECEIVER_CALLS).sort());

    const unresolvedAllow = new Set(Object.keys(UNRESOLVED_CALLEES));
    const unresolvedFound: string[] = [];
    const failures: string[] = [];

    for (const name of calls.free) {
      if (unresolvedAllow.has(name)) {
        unresolvedFound.push(name);
        continue;
      }
      const got = resolveImportedCallee(name, indexPath, source);
      if (!got) {
        failures.push(`${name}: declaration not found`);
        continue;
      }
      const rel = repoRel(got.file);
      if (!got.inspection.found) failures.push(`${name} in ${rel}: declaration not found`);
      if (got.inspection.async) failures.push(`${name} in ${rel}: declared async`);
      if (got.inspection.awaitLines.length > 0) {
        failures.push(`${name} in ${rel}: body-level await at relative ${got.inspection.awaitLines.join(",")}`);
      }
    }

    expect(unresolvedFound.sort()).toEqual([...unresolvedAllow].sort());
    expect(failures).toEqual([]);
  });

  test("optional listener start implementations stay synchronous", () => {
    for (const relative of [
      "src/server/index/optional-listeners.ts",
      "src/server/index/link-listener.ts",
    ]) {
      const definitions = inspectStartDefinitions(readFileSync(resolve(repoRoot, relative), "utf8"));
      expect(definitions.length, `${relative}: start definition not found`).toBeGreaterThan(0);
      expect(definitions.every(definition => !definition.async && definition.awaitLines.length === 0), relative).toBe(true);
    }
  });

  test("the callee scan is not vacuous", () => {
    // Same helpers the window test uses, on synthetic input, so a drift in the
    // inspector cannot pass here and fail to catch `export async function` there.
    expect(inspectFunctionDeclaration("export function f() { return 1; }", "f")).toEqual({
      found: true,
      async: false,
      awaitLines: [],
    });
    expect(inspectFunctionDeclaration("export async function f() { return 1; }", "f")).toEqual({
      found: true,
      async: true,
      awaitLines: [],
    });

    // Illegal without `async`, but the helper is a text scan: this is the
    // half-finished conversion (`function` left sync, `await` already added)
    // that a parser would refuse and this guard still has to report.
    const bodyAwait = "export function f() {\n  const p = g();\n  await p;\n}\n";
    expect(inspectFunctionDeclaration(bodyAwait, "f")).toEqual({
      found: true,
      async: false,
      awaitLines: [3],
    });

    const nested = "export function f() { void (async () => { await g(); }); }\n";
    expect(inspectFunctionDeclaration(nested, "f")).toEqual({
      found: true,
      async: false,
      awaitLines: [],
    });

    // Collector: a nested call is not a window callee, and a receiver is not a free function.
    const collected = collectBodyLevelCalls("foo();\nobj.bar();\nvoid (async () => { nested(); });\n({ ...spreadCallee() });\n");
    expect(collected.free.sort()).toEqual(["foo", "spreadCallee"]);
    expect(collected.receiver.sort()).toEqual(["obj.bar()"]);

    const start = source.indexOf(SERVE_ANCHOR);
    const end = source.indexOf(RETURN_ANCHOR, start);
    const region = source.slice(start, end);
    const windowCalls = collectBodyLevelCalls(region);
    // If the window collapsed to an empty string, or the collector stopped
    // seeing calls, this test would still pass every sync assertion vacuously.
    expect(windowCalls.free.length).toBeGreaterThan(0);
    expect(windowCalls.free).toContain("activateLab");
  });

});

/**
 * Depth one was the whole defect, and #4704 is the report of it.
 *
 * The guard above follows the direct callees of `startServer`. That catches `activateLab` becoming
 * async, but `activateLab` calls installLabAutomationRuntime and startAutomationIfEnabled
 * without awaiting them. Making either of those async with an await before its registration
 * call leaves `activateLab` parsing as perfectly synchronous, so every assertion above stays
 * green while `startServer` returns before Lab is registered — and a policy route can then be
 * evaluated before its evidence provider exists, which is the one thing the window exists to
 * prevent.
 *
 * So this block walks the chain instead of sampling its first hop. What keeps a recursive walk
 * from becoming the false-positive machine the depth-one comment warned about is what it
 * refuses to follow: nested functions are already skipped by collectBodyLevelCalls, so timer
 * callbacks, shutdown hooks, promise continuations and the deferred route executor are not
 * treated as activation edges; receiver calls are not followed, because a method that turns
 * async cannot suspend its caller unless the caller awaits it, and that await is reported on
 * the caller's own body; and names imported from outside this repository are classified
 * automatically rather than hand-listed.
 */
describe("Lab activation stays synchronous past the first hop", () => {
  const indexPath = resolve(repoRoot, "src/server/index.ts");
  const indexSource = readFileSync(indexPath, "utf8");
  const labActivationPath = resolve(repoRoot, "src/lib/lab-activation.ts");
  const orchestratorPath = resolve(repoRoot, "src/lab/automation/orchestrator.ts");

  /**
   * Free identifiers in the chain that are not repository functions. Each one is listed with
   * why following it is meaningless rather than skipped silently, which is the same contract
   * UNRESOLVED_CALLEES holds for the window: a name that disappears from this list without
   * disappearing from the chain fails the equality assertion below.
   */
  const ACTIVATION_NOT_WALKED: Record<string, string> = {
    String: "Language builtin. Not a repository function and not suspendable.",
    Symbol: "Language builtin, used for the automation runtime owner token.",
    setInterval: "Host timer. Registers the scheduler tick and returns immediately; the callback is a nested function this walk does not treat as an activation edge.",
    action: "The callback parameter of withConfigLock. It is invoked synchronously, but its body is the arrow written at the call site, which is a nested function inspected there rather than here.",
    mutate: "The callback parameter of mutateLabAutomationState. Same shape as action.",
    release: "A lock receipt returned by acquireConfigLock/acquireStateLock. A returned closure has no declaration to resolve from the call site.",
  };

  /**
   * Nodes the walk must reach. Without this the whole block could pass by walking nothing:
   * a resolver regression that stopped finding `activateLab` would produce an empty graph, zero
   * failures and a green suite, which is precisely the failure mode being fixed.
   */
  const REQUIRED_NODES = [
    "activateLab",
    "installLabAutomationRuntime",
    "startAutomationIfEnabled",
    "registerLabPassiveRouteLinker",
    "setCompatibilityEvidenceProvider",
    "createProductionLabRouteExecutor",
    "setLabAutomationDispatchDeps",
    "labAutomationEnabledOnDisk",
    "startLabAutomationScheduler",
    "loadLabAutomationConfig",
    "mutateLabAutomationState",
  ];

  function walk(loadSource?: (file: string) => string, entrySource = indexSource): ActivationWalk {
    return walkActivationChain({
      root: "activateLab",
      entryFile: indexPath,
      entrySource,
      notWalked: new Set(Object.keys(ACTIVATION_NOT_WALKED)),
      loadSource,
    });
  }

  test("every function the activation chain calls is synchronous", () => {
    const result = walk();

    expect(result.failures).toEqual([]);
    for (const name of REQUIRED_NODES) expect([...result.nodes.keys()]).toContain(name);
    // A floor, not an exact count: the chain is allowed to grow, and pinning its size would
    // turn an ordinary Lab refactor into a failure of this guard.
    expect(result.nodes.size).toBeGreaterThan(20);
    // Every classified name must still be reachable, so the list cannot accumulate entries
    // that no longer describe anything.
    expect([...result.skipped].sort()).toEqual(Object.keys(ACTIVATION_NOT_WALKED).sort());
    // And the chain must actually leave this repository somewhere, which is the evidence that
    // the external-import classification is doing work rather than matching nothing.
    expect(result.external.size).toBeGreaterThan(0);
  });

  test("a nested callee turning async is reported, and depth one cannot see it", () => {
    const mutated = readFileSync(labActivationPath, "utf8")
      .replace("function installLabAutomationRuntime(", "async function installLabAutomationRuntime(");
    expect(mutated).toContain("async function installLabAutomationRuntime(");

    const result = walk(file => (file === labActivationPath ? mutated : readFileSync(file, "utf8")));
    expect(result.failures).toContain("installLabAutomationRuntime in src/lib/lab-activation.ts: declared async");

    // The same mutated source, read the way the depth-one scan reads it: activateLab is still
    // a plain synchronous function with no body-level await. That is the green the guard used
    // to report while the window was already broken.
    expect(inspectFunctionDeclaration(mutated, "activateLab")).toEqual({
      found: true,
      async: false,
      awaitLines: [],
    });
  });

  test("an await added inside a nested callee is reported", () => {
    const mutated = readFileSync(labActivationPath, "utf8")
      .replace("const previous = record.runtime;", "const previous = await record.runtime;");
    expect(mutated).toContain("await record.runtime;");

    const result = walk(file => (file === labActivationPath ? mutated : readFileSync(file, "utf8")));
    expect(result.failures.some(failure =>
      failure.startsWith("installLabAutomationRuntime in src/lib/lab-activation.ts: body-level await"),
    )).toBe(true);
  });

  test("a suspension three hops down is reported", () => {
    // startLabAutomationScheduler sits under startAutomationIfEnabled, which sits under
    // activateLab. Nothing between them awaits, so this is the shape the previous guard was
    // furthest from seeing.
    const mutated = readFileSync(orchestratorPath, "utf8")
      .replace("export function startLabAutomationScheduler(", "export async function startLabAutomationScheduler(");
    expect(mutated).toContain("export async function startLabAutomationScheduler(");

    const result = walk(file => (file === orchestratorPath ? mutated : readFileSync(file, "utf8")));
    expect(result.failures).toContain(
      "startLabAutomationScheduler in src/lab/automation/orchestrator.ts: declared async",
    );
  });

  test("the arrow inspector sees what the function-only inspector cannot", () => {
    // activationKey is a const arrow with a return-type annotation. The function-only
    // inspector reports it missing, and a walk that treated "missing" as "fine" would skip
    // every const-arrow node in the chain.
    expect(inspectFunctionDeclaration("const f = (a: string): string => a;", "f").found).toBe(false);
    expect(inspectActivationDeclaration("const f = (a: string): string => a;", "f")).toEqual({
      found: true,
      async: false,
      awaitLines: [],
      body: " a",
    });
    expect(inspectActivationDeclaration("const f = async (): Promise<void> => { await g(); };", "f")).toMatchObject({
      found: true,
      async: true,
    });
    expect(inspectActivationDeclaration("const f = (): void => { const x = 1; };", "f")).toMatchObject({
      found: true,
      async: false,
      awaitLines: [],
    });
  });
});
