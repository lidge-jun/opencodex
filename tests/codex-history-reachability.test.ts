import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Who may reach a history writer, checked by walking imports rather than counting
 * strings.
 *
 * The previous guard in this unit was a regex over a handful of files. It could
 * not see a wrapper, an alias, a re-export, or a dynamic import, so a new bypass
 * would have landed green — and this phase exists precisely because a lock one
 * caller can skip is not a lock.
 *
 * The inventory is deliberately small and named. `internal/history-writer.ts`
 * mutates the database, the manifest and the rollouts; only `history-worker.ts`
 * runs inside H, so only it may reach those symbols.
 */
const SRC = resolve(import.meta.dir, "..", "src");

/** Modules whose exports mutate Codex history. */
const HISTORY_WRITER = "codex/internal/history-writer.ts";

/** The only production module allowed to import them. */
const PERMITTED_ROOTS = new Set(["codex/history-worker.ts"]);

/**
 * Modules that legitimately still contain inline history calls.
 *
 * `history-provider.ts` owns the implementations. `inject.ts` keeps a
 * synchronous body for the process-shutdown path, where awaiting a Worker the
 * process may not outlive trades a correct restore for a faster one; it is gated
 * on `skipHistory` so the async wrapper is the one that runs under H.
 */
const INLINE_ALLOWED = new Set([
  "codex/history-provider.ts",
  "codex/inject.ts",
  "codex/internal/history-writer.ts",
]);

/** Direct mutators — reaching these outside the inventory is the bypass. */
const MUTATORS = [
  "syncCodexHistoryProvider",
  "restoreLegacyOpenaiHistory",
  "migrateHistoryToOpenai",
];

function sourceRelative(file: string): string {
  // node:path uses backslashes on Windows; normalize once so the named
  // inventory cannot reject its own permitted modules on that platform.
  return relative(SRC, file).replaceAll("\\", "/");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Every import specifier in a file: static, `export ... from`, and dynamic.
 *
 * Dynamic imports matter most — they are how a caller reaches a module without
 * appearing in the import block, and the old regex guard was blind to them.
 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s[^;]*?from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(join(fromFile, ".."), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return sourceRelative(candidate);
    } catch { /* not this shape */ }
  }
  return null;
}

test("only the history Worker can reach a history writer", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = sourceRelative(file);
    if (rel === HISTORY_WRITER) continue;
    const resolved = importSpecifiers(readFileSync(file, "utf8"))
      .map(specifier => resolveSpecifier(file, specifier));
    if (resolved.includes(HISTORY_WRITER) && !PERMITTED_ROOTS.has(rel)) {
      offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});

test("no production module outside the inventory calls a history mutator inline", () => {
  const offenders: Array<{ file: string; symbol: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const rel = sourceRelative(file);
    if (INLINE_ALLOWED.has(rel)) continue;
    const source = readFileSync(file, "utf8");
    for (const symbol of MUTATORS) {
      // A call, not a type reference or a re-export of the name.
      if (new RegExp(`\\b${symbol}\\s*\\(`).test(source)) {
        offenders.push({ file: rel, symbol });
      }
    }
  }
  expect(offenders).toEqual([]);
});

/**
 * The inventory is only meaningful if it is currently satisfied by real modules.
 * A guard whose permitted root does not exist would pass forever by vacuity.
 */
test("the permitted root exists and does import the writer", () => {
  const worker = readFileSync(join(SRC, "codex", "history-worker.ts"), "utf8");
  const resolved = importSpecifiers(worker)
    .map(specifier => resolveSpecifier(join(SRC, "codex", "history-worker.ts"), specifier));
  expect(resolved).toContain(HISTORY_WRITER);
});
