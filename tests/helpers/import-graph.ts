/**
 * Static import-graph walker shared by the repository's boundary guards.
 *
 * Two subsystems now need the same question answered -- "can this entrypoint reach that
 * directory without anyone choosing to load it?" -- and the answer must be computed the
 * same way for both. tests/core-lab-boundary.test.ts already records what happens when a
 * guard's predicate is duplicated instead of shared: its self-test re-declared its own copy
 * of the matcher, so it proved a local literal behaved rather than that the guard did. A
 * copy cannot fail when the original drifts, which is the specific way a guard rots. This
 * module exists so the second guard is not a third copy.
 *
 * Callers own the policy (which entrypoints are protected, which directory is off-limits);
 * this module owns only the mechanics.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/...", and resolving
 * that against the cwd produced "C:\\C:\\..." -- so every guard built on it threw ENOENT
 * instead of reading a file. A boundary test that cannot open its own sources reports a
 * broken path as a failure and would report a real violation the same way, which means it
 * was proving nothing on that platform.
 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** An import edge as written in source, before resolution. */
export interface ImportEdge {
  /** The specifier exactly as spelled. */
  readonly spec: string;
  /** True for import(...) -- a deferred edge, entered only if that branch runs. */
  readonly dynamic: boolean;
}

/** An import edge with its specifier resolved to a file on disk, when it resolves at all. */
export interface ResolvedImportEdge extends ImportEdge {
  /** Absolute path, or null for a bare/unresolvable specifier. */
  readonly resolved: string | null;
}

/**
 * Runtime imports only: "import type" is erased and costs nothing at runtime.
 *
 * Covers static imports, side-effect imports, runtime re-exports, AND dynamic import().
 * Dynamic import was a real hole once: an earlier guard matched only the first three forms,
 * and a void import("./lab/paths") in a protected file passed cleanly while loading Lab at
 * runtime. Found by attacking the guard rather than trusting it.
 *
 * Known limits, stated rather than implied: a static walker cannot resolve a computed
 * specifier, so import(someVariable) and template-literal specifiers are out of scope, and
 * bare require() is unavailable because this package is ESM ("type": "module").
 *
 * Returned fresh on every call: a shared /g regex carries lastIndex between callers, and a
 * guard that skips the first edges of every other file it reads is worse than no guard.
 */
/** Kept as one string so both guards match on byte-identical mechanics. */
const IMPORT_PATTERN_SOURCE = "^\\s*import\\s+(?!type\\b)[^;]*?from\\s+[\"']([^\"']+)[\"']|^\\s*import\\s+[\"']([^\"']+)[\"']|^\\s*export\\s+(?!type\\b)[^;]*?from\\s+[\"']([^\"']+)[\"']|\\bimport\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)";
function importPattern(): RegExp {
  return new RegExp(IMPORT_PATTERN_SOURCE, "gm");
}

/** Every runtime import edge in one source text, in source order. */
export function runtimeImportEdges(source: string): ImportEdge[] {
  const pattern = importPattern();
  const edges: ImportEdge[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!spec) continue;
    edges.push({ spec, dynamic: match[4] !== undefined });
  }
  return edges;
}

/** Resolve a relative specifier the way the runtime would. Bare specifiers yield null. */
export function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base + ".ts", join(base, "index.ts"), base + ".mts", base + ".mjs"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Slash-normalized path.
 *
 * resolve/join produce backslashes on Windows, so a literal "/src/lab/" test silently
 * matched nothing there and the guard reported clean for every possible violation.
 */
export function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

/** Every runtime import edge of one repository file, with specifiers resolved. */
export function resolvedImportEdges(repoRelativeFile: string): ResolvedImportEdge[] {
  const absolute = resolve(repoRoot, repoRelativeFile);
  const source = readFileSync(absolute, "utf8");
  return runtimeImportEdges(source).map(edge => ({
    ...edge,
    resolved: resolveSpec(edge.spec, absolute),
  }));
}

/**
 * Walk the load-time import graph from one entrypoint and return the first chain that
 * reaches a file the caller recognizes, or null.
 *
 * isTarget receives an absolute, slash-normalized path. The returned chain is
 * repository-relative and slash-spelled, so it reads the same on every platform and callers
 * can assert on it without knowing the separator.
 *
 * A dynamic import() is a deferred edge, not a load-time one: the module graph is only
 * entered if that branch actually runs. Lazy loading behind an activation check is precisely
 * the remedy these guards exist to encourage, so a dynamic specifier does not propagate the
 * walk. Forbidding a DIRECT dynamic import in a protected file is the caller's job, and is
 * what stops the deferral being a loophole.
 *
 * The entrypoint itself is never matched -- only what it reaches. A guard that wants to
 * reject the entrypoint naming the target directly checks its edges instead.
 */
export function firstLoadTimePathTo(
  entry: string,
  isTarget: (absoluteSlashedPath: string) => boolean,
): string[] | null {
  const start = resolve(repoRoot, entry);
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!existsSync(current)) continue;
    for (const edge of runtimeImportEdges(readFileSync(current, "utf8"))) {
      if (edge.dynamic) continue;
      const next = resolveSpec(edge.spec, current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      if (isTarget(slashed(next))) {
        const chain: string[] = [];
        let node: string | null = next;
        while (node) {
          chain.push(slashed(node.slice(repoRoot.length + 1)));
          node = previous.get(node) ?? null;
        }
        return chain.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

