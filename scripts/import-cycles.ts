import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Import-cycle ratchet for the proxy runtime (issue #6386, INV-LAYER-01).
 *
 * The runtime import graph once held one strongly connected component of 222 modules, so an edit
 * in nearly any domain could reach nearly any other, and the three files INV-LAB-01 protects sat
 * inside it. Breaking that component is incremental work. This scanner keeps the progress: the
 * baseline lists every module that is still on a cycle, and the test beside it fails when a module
 * outside that list joins one, or when a listed module leaves without the list shrinking with it.
 *
 * Edges are load-time value imports parsed by Bun: static imports, side-effect imports,
 * and runtime re-exports. Resolution follows Bun's local module precedence.
 * \`import type\` is erased and a dynamic \`import()\` is a deferred edge that only loads when its
 * branch runs, which is the sanctioned way to break a cycle, so neither forms an edge here.
 *
 * Importing this module scans nothing. \`bun scripts/import-cycles.ts\` prints the current count and
 * \`--update\` rewrites the baseline, which only ever removes members.
 */

export const BASELINE_REL = "tests/fixtures/import-cycle-baseline.json";
export const SOURCE_ROOT = "src";

const importScanner = new Bun.Transpiler({ loader: "ts" });
const tsxImportScanner = new Bun.Transpiler({ loader: "tsx" });

export type ImportGraph = Map<string, string[]>;

export interface CycleBaseline {
  /** Modules (repo-relative, forward slashes) that sit on a static value-import cycle. */
  cyclic: string[];
}

export interface CycleVerdict {
  /** Modules on a cycle that the baseline does not list: a regression. */
  added: string[];
  /** Listed modules that are no longer on a cycle: the baseline must shrink. */
  resolved: string[];
}

function toRepoPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(abs));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.d\.(ts|mts)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  try {
    const candidate = Bun.resolveSync(spec, dirname(fromFile));
    return /\.(ts|tsx|mts)$/.test(candidate) ? candidate : null;
  } catch {
    // Unresolved edges and non-TypeScript modules are outside this source graph.
    return null;
  }
}

/** Static value-import edges between source files in \`importer -> imported\` form. */
export function staticImports(source: string, tsx = false): string[] {
  // scanImports does not accept executable entrypoint hashbangs; they are not module syntax.
  const moduleSource = source.replace(/^#![^\r\n]*/, "");
  return (tsx ? tsxImportScanner : importScanner).scanImports(moduleSource)
    .filter(edge => edge.kind === "import-statement")
    .map(edge => edge.path);
}

export function scanGraph(root: string, sourceRoot = SOURCE_ROOT): ImportGraph {
  // Bun resolves imports to physical paths; graph keys must use the same root (e.g. /var on macOS).
  root = realpathSync(root);
  const graph: ImportGraph = new Map();
  for (const abs of listSources(join(root, sourceRoot)).sort()) {
    const targets = new Set<string>();
    for (const spec of staticImports(readFileSync(abs, "utf8"), abs.endsWith(".tsx"))) {
      const hit = resolveSpecifier(spec, abs);
      if (hit) targets.add(toRepoPath(root, hit));
    }
    graph.set(toRepoPath(root, abs), [...targets].sort());
  }
  return graph;
}

/** Strongly connected components with more than one member, or a module importing itself. */
export function cyclicComponents(graph: ImportGraph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let next = 0;
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    // Iterative Tarjan: a recursive walk over a deep chain would exhaust the call stack.
    const frames: { node: string; edge: number }[] = [{ node: start, edge: 0 }];
    index.set(start, next);
    low.set(start, next++);
    stack.push(start);
    onStack.add(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = graph.get(frame.node) ?? [];
      if (frame.edge < edges.length) {
        const target = edges[frame.edge++]!;
        if (!graph.has(target)) continue;
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next++);
          stack.push(target);
          onStack.add(target);
          frames.push({ node: target, edge: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.node);
      const selfLoop = component.length === 1 && (graph.get(member) ?? []).includes(member);
      if (component.length > 1 || selfLoop) components.push(component.sort());
    }
  }
  return components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

export function cyclicModules(graph: ImportGraph): string[] {
  return cyclicComponents(graph).flat().sort();
}

export function evaluate(current: readonly string[], baseline: CycleBaseline): CycleVerdict {
  const listed = new Set(baseline.cyclic);
  const now = new Set(current);
  return {
    added: current.filter((path) => !listed.has(path)).sort(),
    resolved: baseline.cyclic.filter((path) => !now.has(path)).sort(),
  };
}

/** Never adds a member: a new cycle is fixed in the source, not admitted into the list. */
export function updateBaseline(current: readonly string[], baseline: CycleBaseline): CycleBaseline {
  const now = new Set(current);
  return { cyclic: baseline.cyclic.filter((path) => now.has(path)).sort() };
}

export function loadBaseline(root: string): CycleBaseline {
  return JSON.parse(readFileSync(join(root, BASELINE_REL), "utf8")) as CycleBaseline;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const components = cyclicComponents(scanGraph(root));
  const current = components.flat().sort();
  const sizes = components.map((component) => component.length).join(", ");
  console.log(current.length + " modules on static import cycles in " + components.length + " components (" + sizes + ")");
  if (process.argv.includes("--seed")) {
    writeFileSync(join(root, BASELINE_REL), JSON.stringify({ cyclic: current }, null, 2) + "\n");
  } else if (process.argv.includes("--update")) {
    const next = updateBaseline(current, loadBaseline(root));
    writeFileSync(join(root, BASELINE_REL), JSON.stringify(next, null, 2) + "\n");
    console.log("baseline now lists " + next.cyclic.length + " modules");
  } else if (process.argv.includes("--components")) {
    for (const component of components) console.log(component.length + ": " + component.join(" "));
  }
}
