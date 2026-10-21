import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  BASELINE_REL,
  cyclicComponents,
  cyclicModules,
  evaluate,
  loadBaseline,
  scanGraph,
  staticImports,
  updateBaseline,
  type ImportGraph,
} from "../../scripts/import-cycles";
import { repoRoot } from "../helpers/repo-root";

/**
 * INV-LAYER-01: the runtime import graph only gets less cyclic (issue #6386).
 *
 * The baseline in tests/fixtures/import-cycle-baseline.json lists every src/ module that still sits
 * on a static value-import cycle. A module outside the list joining a cycle fails here, and so does
 * a listed module that has left one: shrinking the list is what stops a later change from quietly
 * re-closing the same loop. The core entrypoints below are held to a stricter rule: they sit on no
 * cycle at all, so INV-LAB-01's boundary rests on a layered graph instead of on one component that
 * reaches everything.
 */
const CORE_OFF_CYCLE = [
  "src/config.ts",
  "src/router.ts",
  "src/server/lifecycle.ts",
  "src/server/responses/core.ts",
  "src/server/management-api.ts",
] as const;

const graphOf = (edges: Record<string, string[]>): ImportGraph => new Map(Object.entries(edges));

describe("import-cycle ratchet: scanner", () => {
  test("parses compact declarations without treating comments or erased imports as edges", () => {
    expect(staticImports([
      '#!/usr/bin/env bun',
      'import{ b }from"./b";export{ c }from"./c";',
      'import"./side";export*from"./star";',
      'import/*gap*/{ d }/*gap*/from"./d";',
      'import type{ T }from"./types";export type{ T }from"./types";',
      'import{type U}from"./erased";export{type U}from"./erased";',
      '// import{ fake }from"./comment";',
      'const text = `import{ fake }from"./text"`;',
      'const lazy = () => import("./lazy");',
    ].join("\n"))).toEqual(["./b", "./c", "./side", "./star", "./d"]);
  });

  test.each(["tsx", "mts"])("directory index.%s imports close cycles", extension => {
    const root = mkdtempSync(join(tmpdir(), "ocx-import-index-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), 'import { b } from "./nested"; export const a = b;');
    writeFileSync(join(root, "src", "nested", `index.${extension}`),
      'import { a } from "../a"; export const b = a;' + (extension === "tsx" ? " export const view = <span/>;" : ""));
    expect(cyclicModules(scanGraph(root))).toEqual(["src/a.ts", `src/nested/index.${extension}`]);
  });

  test("directory precedence agrees with Bun when multiple indexes exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-import-precedence-"));
    const src = join(root, "src");
    mkdirSync(join(src, "nested"), { recursive: true });
    writeFileSync(join(src, "a.ts"), 'import { b } from "./nested";');
    for (const ext of ["ts", "tsx", "mts"]) writeFileSync(join(src, "nested", `index.${ext}`), "export const b = 1;");
    const resolved = basename(Bun.resolveSync("./nested", src));
    expect(scanGraph(root).get("src/a.ts")).toEqual([`src/nested/${resolved}`]);
  });

  test.each(["ts", "tsx", "mts"])("symlinked roots preserve index.%s cycle identities", extension => {
    const base = mkdtempSync(join(tmpdir(), "ocx-import-symlink-"));
    const physical = join(base, "physical");
    const root = join(base, "alias");
    try {
      mkdirSync(join(physical, "src", "nested"), { recursive: true });
      writeFileSync(join(physical, "src", "a.ts"), 'import { b } from "./nested"; export const a = b;');
      writeFileSync(join(physical, "src", "nested", `index.${extension}`),
        'import { a } from "../a"; export const b = a;' + (extension === "tsx" ? " export const view = <span/>;" : ""));
      symlinkSync(physical, root, process.platform === "win32" ? "junction" : "dir");
      const graph = scanGraph(root);
      expect(graph.get("src/a.ts")).toEqual([`src/nested/index.${extension}`]);
      expect(graph.get(`src/nested/index.${extension}`)).toEqual(["src/a.ts"]);
      expect(cyclicModules(graph)).toEqual(["src/a.ts", `src/nested/index.${extension}`]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("only load-time value imports form edges", () => {
    const source = [
      'import { a } from "./a";',
      'import type { B } from "./b";',
      'import "./c";',
      'export { d } from "./d";',
      'export type { E } from "./e";',
      'const lazy = () => import("./f");',
      "import {",
      "  g,",
      '} from "./g";',
    ].join("\n");
    expect(staticImports(source)).toEqual(["./a", "./c", "./d", "./g"]);
  });

  test("components: a loop and a self-import are cycles, a chain is not", () => {
    const graph = graphOf({
      "a.ts": ["b.ts"],
      "b.ts": ["c.ts"],
      "c.ts": ["a.ts", "d.ts"],
      "d.ts": [],
      "e.ts": ["e.ts"],
      "f.ts": ["d.ts"],
    });
    expect(cyclicComponents(graph)).toEqual([["a.ts", "b.ts", "c.ts"], ["e.ts"]]);
    expect(cyclicModules(graph)).toEqual(["a.ts", "b.ts", "c.ts", "e.ts"]);
  });

  test("scanGraph resolves relative specifiers and ignores deferred and erased edges", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-import-cycles-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), 'import { b } from "./nested";\nexport const a = 1;\n');
    writeFileSync(join(root, "src", "nested", "index.ts"), 'import { a } from "../a";\nexport const b = a;\n');
    writeFileSync(join(root, "src", "lazy.ts"), 'import type { A } from "./typed";\nexport const l = () => import("./a");\n');
    writeFileSync(join(root, "src", "typed.ts"), 'import { l } from "./lazy";\nexport type A = typeof l;\n');
    writeFileSync(join(root, "src", "ambient.d.mts"), 'export const declarationOnly: number;');
    expect(cyclicModules(scanGraph(root))).toEqual(["src/a.ts", "src/nested/index.ts"]);
  });
});

describe("import-cycle ratchet: baseline rules", () => {
  test("a new cyclic module is reported as added, a fixed one as resolved", () => {
    const verdict = evaluate(["src/a.ts", "src/new.ts"], { cyclic: ["src/a.ts", "src/gone.ts"] });
    expect(verdict).toEqual({ added: ["src/new.ts"], resolved: ["src/gone.ts"] });
  });

  test("updating the baseline only removes members", () => {
    expect(updateBaseline(["src/a.ts", "src/new.ts"], { cyclic: ["src/a.ts", "src/gone.ts"] })).toEqual({
      cyclic: ["src/a.ts"],
    });
  });
});

describe("import-cycle ratchet: repository", () => {
  const root = repoRoot();
  const current = cyclicModules(scanGraph(root));
  const baseline = loadBaseline(root);

  test("the baseline is sorted and unique", () => {
    expect(baseline.cyclic).toEqual([...new Set(baseline.cyclic)].sort());
  });

  test("no module outside " + BASELINE_REL + " sits on an import cycle", () => {
    const { added } = evaluate(current, baseline);
    if (added.length > 0) {
      const components = cyclicComponents(scanGraph(root)).filter((c) => c.some((m) => added.includes(m)));
      throw new Error(
        "new import cycle(s), one strongly connected component per line; break the loop in source (import the owning module, or defer the edge with import()):\n" +
          components.map((c) => "  [" + c.join(", ") + "]").join("\n"),
      );
    }
  });

  test("modules that left every cycle are dropped from the baseline", () => {
    const { resolved } = evaluate(current, baseline);
    if (resolved.length > 0) {
      throw new Error(
        "these modules are no longer on a cycle; run \`bun scripts/import-cycles.ts --update\`:\n  " + resolved.join("\n  "),
      );
    }
  });

  test("the core entrypoints and the config facade sit on no cycle", () => {
    expect(CORE_OFF_CYCLE.filter((path) => current.includes(path))).toEqual([]);
  });
});
