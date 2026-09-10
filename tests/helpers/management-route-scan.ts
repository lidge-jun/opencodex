/**
 * Static route scanner for the management surface.
 *
 * This exists because a route count is only useful if it is reproducible. The wp3 plan
 * originally reconciled `rg` line hits against a registry, and that identity cannot
 * balance: one guard line can register two routes (`PUT || PATCH`), a preceding sibling
 * guard can fix the method for every route after it, and two live routes are written as
 * `pathname !== "…"` so a `===` scan never sees them at all. One module
 * (`routing-analytics-routes.ts`) has one route and zero `===` literals, so a
 * literal-keyed check omits the module entirely. Worse, for `GET /api/storage` a `===`
 * scan finds only the dead shadowed copy in `logs-usage-routes.ts` and never the live
 * negated-guard one, so it would have mistaken the corpse for the patient.
 *
 * So this resolves `(method, path)` pairs instead of counting lines, and it maintains a
 * method NARROWING CONTEXT while walking statements in order:
 *
 * - `if (req.method !== "GET") return null;` at some brace depth narrows every later
 *   statement at that depth or deeper to GET, until the depth closes.
 * - `if (req.method === "POST") {` narrows only its own block.
 * - A same-line conjunction (`pathname === "/x" && req.method === "POST"`) binds only
 *   that route.
 *
 * Both nesting orders occur in real code and neither is inferable from the other:
 * `lab-routes.ts:352` narrows method BEFORE eight path literals, while
 * `storage-log-guard-routes.ts:112` opens with the path and puts the method guard INSIDE
 * at :113. A scanner that only looked forward and outward resolved none of the lab reads.
 *
 * FAIL LOUD, never guess. When a path guard is found with no resolvable method, the
 * route is returned with `method: null` and the caller is expected to fail. Defaulting
 * to GET is how a scanner produces a number nobody can trust.
 *
 * Out of scope by construction (declared in the registry's allowlist instead): regex
 * matching, `endsWith`, `pathname.slice`, and path constants. A static text walker
 * cannot resolve those, and pretending otherwise is what made the original figures
 * unreproducible.
 */
import { readFileSync } from "node:fs";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface ScannedRoute {
  readonly path: string;
  /** null means the scanner could not resolve a method; callers must fail, not guess. */
  readonly method: HttpMethod | null;
  readonly line: number;
  /** `equality` for `pathname === "…"`, `negated` for `pathname !== "…"`. */
  readonly form: "equality" | "negated";
}

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/** A `req.method !== "X"` early return in force from `depth` downward. */
interface Narrowing {
  readonly depth: number;
  readonly method: HttpMethod;
}

function stripCommentsAndStrings(line: string): string {
  // Only line comments matter here: the guards this scanner reads are single-line, and
  // a block comment mentioning `pathname === "/api/x"` inside a doc comment would
  // otherwise register as a route. Keeps string bodies, because the paths live in them.
  const idx = line.indexOf("//");
  if (idx === -1) return line;
  // Do not cut inside a string literal (`"http://…"`).
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

function methodsOnLine(line: string): HttpMethod[] {
  const found: HttpMethod[] = [];
  for (const m of METHODS) {
    if (new RegExp(`method\\s*===\\s*"${m}"`).test(line)) found.push(m);
  }
  return found;
}

function depthDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

/**
 * Does the block opened at `start` do nothing but hand the request to another module?
 *
 * The shape is a dynamic import followed by a return of the imported handler, with no
 * method token anywhere in between. Requiring BOTH the import and the return keeps this
 * from swallowing a real route whose method the scanner simply failed to read: a guard
 * that inspects `req.method`, or that does any work of its own before returning, still
 * comes back unresolved and still fails loudly.
 */
function isDelegationBlock(lines: readonly string[], start: number): boolean {
  let sawImport = false;
  for (let j = start + 1; j <= Math.min(start + 4, lines.length - 1); j++) {
    const ahead = stripCommentsAndStrings(lines[j] ?? "");
    if (ahead.trim() === "") continue;
    if (/await\s+import\(/.test(ahead) && !/\bmethod\b/.test(ahead)) { sawImport = true; continue; }
    if (/^\s*return\s+\w/.test(ahead) && !/\bmethod\b/.test(ahead)) return sawImport;
    // Anything else is the block doing work of its own, so the method may well be
    // knowable here and a missed read must stay loud.
    return false;
  }
  return false;
}

/**
 * Scan one source file for `(method, path)` route guards.
 *
 * Deliberately text-based rather than AST-based: the assertion this feeds is about
 * catching a route someone ADDS, and a walker small enough to read in one sitting is
 * more trustworthy for that than a parser whose failure mode is silence.
 */
export function scanRoutes(file: string): ScannedRoute[] {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const routes: ScannedRoute[] = [];
  const narrowings: Narrowing[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = stripCommentsAndStrings(raw);

    // A narrowing only survives while its brace depth is still open.
    while (narrowings.length > 0 && depth < narrowings[narrowings.length - 1]!.depth) {
      narrowings.pop();
    }

      const pathMatch = /pathname\s*(===|!==)\s*"([^"]+)"/.exec(line);
    if (pathMatch) {
      const form = pathMatch[1] === "===" ? "equality" as const : "negated" as const;
      const path = pathMatch[2]!;
      // A guard can wrap across lines:
      //   if (\n  url.pathname === "/x"\n  && (req.method === "PUT" || req.method === "PATCH")\n) {
      // so the method clause is neither on the path line nor inside the opened block.
      // Read forward to the `)` that closes the condition and treat that whole span as
      // "the same line". Without this, `/api/codex-auth/pool-strategy` came back
      // unresolved -- which is the scanner behaving correctly, and is how this case was
      // found rather than assumed.
      let conditionSpan = line;
      if (!/\)\s*\{?\s*$/.test(line.trim()) || line.trim().startsWith("url.pathname")) {
        for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
          const ahead = stripCommentsAndStrings(lines[j] ?? "");
          conditionSpan += " " + ahead;
          if (/^\s*\)\s*\{/.test(ahead) || /\)\s*\{\s*$/.test(ahead)) break;
          if (/pathname\s*(===|!==)\s*"/.test(ahead)) break;
        }
      }
      const sameLine = methodsOnLine(conditionSpan);
      // A negated path guard pairs with a negated method guard on the same line:
      // `if (pathname !== "/api/storage" || method !== "GET") return null` means the
      // route IS GET /api/storage. Read the negated form directly.
      const negatedSameLine: HttpMethod[] = [];
      for (const m of METHODS) {
        if (new RegExp(`method\\s*!==\\s*"${m}"`).test(conditionSpan)) negatedSameLine.push(m);
      }
      let method: HttpMethod | null = null;
      if (sameLine.length > 0) {
        // `PUT || PATCH` on one guard is TWO routes, not one. Emit every method in the
        // disjunction; a plan that counted this line once undercounted the surface.
        for (const m of sameLine) {
          routes.push({ path, method: m, line: i + 1, form });
        }
        depth += depthDelta(line);
        continue;
      }
      else if (negatedSameLine.length === 1) method = negatedSameLine[0]!;
      else {
        // Then the block this path guard opens (`{ if (method !== "GET") return null;`).
        for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
          const ahead = stripCommentsAndStrings(lines[j] ?? "");
          if (/pathname\s*(===|!==)\s*"/.test(ahead)) break;
          const inner: HttpMethod[] = [];
          for (const m of METHODS) {
            if (new RegExp(`method\\s*!==\\s*"${m}"`).test(ahead)) inner.push(m);
          }
          if (inner.length === 1) { method = inner[0]!; break; }
          const eq = methodsOnLine(ahead);
          if (eq.length === 1) { method = eq[0]!; break; }
        }
        // Finally the narrowing context established by a preceding sibling guard.
        if (method === null && narrowings.length > 0) {
          method = narrowings[narrowings.length - 1]!.method;
        }
      }
      // A guard that only hands the path to another module defines no method here: the
      // verbs live in the handler it imports, and the registry declares them against
      // THAT module. Emitting an unresolved route for the dispatch site would report a
      // scanner gap that does not exist, and resolving it by adding a method list to the
      // guard would change behavior — the handler answers 405 for an unsupported verb,
      // while a narrowed guard would fall through to the generic dispatch and 404.
      // Prefix delegations (`pathname.startsWith(...)`) are already invisible for the
      // same reason; this is the equality-guard form of it.
      if (method === null && form === "equality" && isDelegationBlock(lines, i)) {
        depth += depthDelta(line);
        continue;
      }
      routes.push({ path, method, line: i + 1, form });
    } else {
      // `if (req.method !== "GET") return null;` narrows everything after it.
      const negated = /method\s*!==\s*"([A-Z]+)"/.exec(line);
      if (negated && /return\s+null/.test(line)) {
        const m = negated[1] as HttpMethod;
        if (METHODS.includes(m)) narrowings.push({ depth, method: m });
      } else {
        // `if (req.method === "POST") {` narrows its own block.
        const eq = methodsOnLine(line);
        if (eq.length === 1 && line.includes("{") && !line.includes("pathname")) {
          narrowings.push({ depth: depth + 1, method: eq[0]! });
        }
      }
    }

    depth += depthDelta(line);
  }

  return routes;
}

/** Distinct `(method, path)` pairs, with unresolved-method routes surfaced separately. */
export function distinctRoutes(scanned: readonly ScannedRoute[]): {
  pairs: string[];
  unresolved: ScannedRoute[];
} {
  const pairs = new Set<string>();
  const unresolved: ScannedRoute[] = [];
  for (const r of scanned) {
    if (r.method === null) { unresolved.push(r); continue; }
    pairs.add(`${r.method} ${r.path}`);
  }
  return { pairs: [...pairs].sort(), unresolved };
}
