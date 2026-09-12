import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Every relative import specifier under src/ must resolve to a file that exists.
 *
 * This is not hypothetical. Two consecutive facade-extraction rounds shipped a leaf one
 * directory deeper than the file it was cut from and carried the original specifier with
 * it. In the first, src/codex/routing/active-account.ts kept "../config", which resolves
 * to src/codex/config -- a path that does not exist -- and every test shard that loaded
 * the routing graph died at import time. In the second, an inline import("./types") inside
 * src/config/schema/config-schema.ts pointed at src/config/schema/types for the same
 * reason. Neither was visible to a parser, to an export-surface comparison, or to a
 * reviewer reading the diff, because the specifier is well-formed; only resolution fails.
 *
 * Resolution mechanics are borrowed from tests/helpers/import-graph.ts rather than
 * restated. That module exists so a second guard is not a third copy of the matcher, and a
 * copy cannot fail when the original drifts.
 */
import { repoRoot, resolveSpec, runtimeImportEdges, slashed } from "../helpers/import-graph";

/**
 * Type-only edges are invisible to runtimeImportEdges by design: it answers "what does
 * loading this file pull in", and a type import pulls in nothing. A broken one is still a
 * defect -- it fails typecheck rather than the runtime -- and it is the same authoring
 * mistake, so this guard covers both and keeps the two patterns separate rather than
 * loosening the shared one.
 */
const TYPE_EDGE_PATTERN =
  "^\\s*import\\s+type\\s+[^;]*?from\\s+[\"']([^\"']+)[\"']|^\\s*export\\s+type\\s+[^;]*?from\\s+[\"']([^\"']+)[\"']";

function typeImportSpecs(source: string): string[] {
  const pattern = new RegExp(TYPE_EDGE_PATTERN, "gm");
  const specs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const spec = match[1] ?? match[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * resolveSpec answers the runtime question and tries .ts, index.ts, .mts and .mjs. A
 * specifier that already carries its extension -- the .json data snapshots under
 * src/codex/catalog, the .mjs launch policy under src/update -- is resolved by existence
 * instead. Both are real edges; only the spelling differs.
 *
 * TypeScript's ESM convention spells a sibling .ts module as "./wire.js": the specifier
 * names the emitted file, not the source. src/adapters/devin and src/oauth/devin are
 * written that way, so the .js -> .ts rewrite is part of resolution here rather than a
 * tolerated exception. Without it this guard would report 23 healthy edges as broken,
 * which is the way a guard gets disabled.
 *
 * resolveSpec answers for the proxy runtime, which has no JSX, so it never tries .tsx. The
 * dashboard is half .tsx and every one of its component specifiers looked broken until
 * that candidate was added -- 346 of them. The extension list belongs to the caller for
 * exactly this reason: the shared helper states the runtime rule and each guard states the
 * surface it is scanning.
 */
function resolvesFrom(spec: string, absoluteFile: string): boolean {
  if (resolveSpec(spec, absoluteFile) !== null) return true;
  const literal = resolve(dirname(absoluteFile), spec);
  if (existsSync(literal)) return true;
  if (existsSync(literal + ".tsx")) return true;
  if (existsSync(resolve(literal, "index.tsx"))) return true;
  const asSource = literal.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts");
  return asSource !== literal && existsSync(asSource);
}

/**
 * src/ and gui/src, and that boundary was measured rather than assumed.
 *
 * Extending the scan to tests/ and scripts/ produced 59 offenders, all false. A source
 * oracle spells a production path inside a string it hands to a spawned child -- the
 * literal "./src/config.ts" appears three times in one test that never imports it -- and a
 * seam declaration lists "../quota/reset-observer" as data for a boundary check. A static
 * matcher cannot tell those from an import, and a guard that cries wolf 59 times is a
 * guard somebody deletes. Under src/ and gui/src a relative specifier in import position
 * is an import, and the dashboard is production code that moves for the same reasons.
 */
const SCANNED_ROOTS = ["src", "gui/src"] as const;

function trackedSourceFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", ...SCANNED_ROOTS], { cwd: repoRoot });
  if (listed.exitCode !== 0) {
    throw new Error("git ls-files failed: " + new TextDecoder().decode(listed.stderr));
  }
  return new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.endsWith(".ts") || line.endsWith(".tsx"));
}

describe("relative import resolution", () => {
  test("the resolver reports a specifier that points at nothing", () => {
    // Driven red on purpose: the offender list is only trustworthy if a miss is a miss.
    // src/config.ts exists, src/codex/config.ts does not -- exactly the round-one defect.
    const from = resolve(repoRoot, "src/codex/routing/active-account.ts");
    expect(resolvesFrom("../../config", from)).toBe(true);
    expect(resolvesFrom("../config", from)).toBe(false);
  });

  test("every relative specifier under the scanned production roots resolves", () => {
    const offenders: string[] = [];
    const files = trackedSourceFiles();
    for (const file of files) {
      const absolute = resolve(repoRoot, file);
      const source = readFileSync(absolute, "utf8");
      const specs = [
        ...runtimeImportEdges(source).map(edge => edge.spec),
        ...typeImportSpecs(source),
      ];
      for (const spec of specs) {
        if (!spec.startsWith(".")) continue;
        if (resolvesFrom(spec, absolute)) continue;
        offenders.push(slashed(file) + " -> " + spec);
      }
    }
    // An empty tree would also produce an empty offender list, so the scan is proven
    // non-vacuous before its result is trusted.
    expect(files.length).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});
