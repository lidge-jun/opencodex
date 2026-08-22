import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
