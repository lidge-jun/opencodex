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
const SERVE_ANCHOR = "server = Bun.serve<WsData>({ ...serveOptions, port: listenPort, hostname: bindHost });";
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
});

