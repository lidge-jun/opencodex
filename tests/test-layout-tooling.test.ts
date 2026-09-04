import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { repoPath, repoRoot } from "./helpers/repo-root";
import { listTestFiles, planMoves } from "../scripts/test-layout/plan";
import { runMove } from "../scripts/test-layout/move";
import {
  anchors,
  currentPath,
  loadLayout,
  resolveTarget,
  rewriteSource,
  rewriteSpecifier,
  REWRITE_PREFIXES,
  scanEscapes,
  type Layout,
} from "../scripts/test-layout/schema";

// Independent oracle: the basename -> directory table from devlog 001 §2.D, committed as a
// fixture. The layout guard shares the resolver with the mover, so a resolver defect could move
// a file to the wrong place and bless it; this fixture is the second opinion that catches it.
const EXPECTED = JSON.parse(readFileSync(repoPath("tests", "fixtures", "test-layout-expected.json"), "utf8")) as Record<string, string>;

describe("rewriteSpecifier", () => {
  const forms = [
    (s: string) => `import { x } from "${s}";`,
    (s: string) => `import "${s}";`,
    (s: string) => `export { y } from "${s}";`,
    (s: string) => `const m = await import("${s}");`,
    (s: string) => `const p = import("${s}");`,
    (s: string) => `type T = typeof import("${s}");`,
    (s: string) => `const r = require("${s}");`,
    (s: string) => `const u = import.meta.resolve("${s}");`,
    (s: string) => `const f = new URL("${s}", import.meta.url);`,
  ];

  test("every declared prefix is rewritten for depth 1 and 2 in every syntax form", () => {
    for (const depth of [1, 2]) {
      const { toTests, toRepo } = anchors(depth);
      for (const { prefix, anchor } of REWRITE_PREFIXES) {
        const spec = `${prefix}thing`;
        const stripped = prefix.startsWith("./") ? prefix.slice(2) : prefix.slice(3);
        const expected = `${anchor === "tests" ? toTests : toRepo}/${stripped}thing`;
        expect(rewriteSpecifier(spec, depth)).toBe(expected);
        for (const form of forms) {
          expect(rewriteSource(form(spec), depth)).toBe(form(expected));
        }
      }
    }
  });

  test("the bare ../ rule does not swallow longer prefixes", () => {
    expect(rewriteSpecifier("../helpers/remove-tree", 1)).toBe("../helpers/remove-tree");
    expect(rewriteSpecifier("../helpers/remove-tree", 2)).toBe("../../helpers/remove-tree");
    expect(rewriteSpecifier("../src/config", 1)).toBe("../../src/config");
    expect(rewriteSpecifier("../", 2)).toBe("../../../");
  });

  test("non-relative and depth-0 specifiers are untouched", () => {
    for (const spec of ["bun:test", "node:fs", "react", "@bufbuild/protobuf", "./sibling"]) {
      expect(rewriteSpecifier(spec, 1)).toBe(spec);
    }
    expect(rewriteSpecifier("../src/x", 0)).toBe("../src/x");
    expect(rewriteSource('import { a } from "bun:test";\nimport { b } from "./sibling";', 2))
      .toBe('import { a } from "bun:test";\nimport { b } from "./sibling";');
  });
});

describe("scanEscapes", () => {
  test("file-local uses pass, escapes fail, the marker suppresses and is reported", () => {
    const local = 'const dir = join(import.meta.dir, ".tmp-x");';
    const escape = 'const src = join(import.meta.dir, "..", "src");';
    const marked = `const src = readFileSync(join(import.meta.dir, "../src/a.ts")); // layout: local`;
    expect(scanEscapes(local)).toEqual([]);
    expect(scanEscapes(escape)).toEqual([{ line: 1, text: escape, suppressed: false }]);
    expect(scanEscapes(marked)).toEqual([{ line: 1, text: marked, suppressed: true }]);
    // A rewritten URL specifier is what a correct move looks like; a bare "../" root URL is not.
    expect(scanEscapes('const u = new URL("../../package.json", import.meta.url);')).toEqual([]);
    expect(scanEscapes('const root = fileURLToPath(new URL("../", import.meta.url));')).toHaveLength(1);
    expect(scanEscapes('const c = join(import.meta.dir, "helpers", "child.ts");')).toHaveLength(1);
    expect(scanEscapes("const self = import.meta.path;")).toEqual([]);
  });
});

describe("resolver", () => {
  const layout: Layout = {
    version: 1,
    root: "tests",
    keepAtRoot: ["preload.ts"],
    domains: {
      providers: { match: ["^provider-"], children: { cursor: ["^cursor-"] } },
      server: { match: ["^server-"] },
    },
    explicit: { "cursor-odd.test.ts": "server" },
    migrated: ["server"],
  };

  test("explicit beats child regex beats domain regex; unknown is null", () => {
    expect(resolveTarget(layout, "cursor-odd.test.ts")).toBe("server");
    expect(resolveTarget(layout, "cursor-adapter.test.ts")).toBe("providers/cursor");
    expect(resolveTarget(layout, "provider-x.test.ts")).toBe("providers");
    expect(resolveTarget(layout, "nothing.test.ts")).toBeNull();
  });

  test("currentPath is the root before migration and the target after", () => {
    expect(currentPath(layout, "server-a.test.ts")).toBe("server/server-a.test.ts");
    expect(currentPath(layout, "provider-x.test.ts")).toBe("provider-x.test.ts");
  });
});

describe("membership oracle", () => {
  const layout = loadLayout();

  test("the live tree and the fixture agree entry by entry", () => {
    const live = listTestFiles(repoRoot()).map(rel => basename(rel)).filter(name => !layout.keepAtRoot.includes(name));
    const missingFromFixture = live.filter(name => !(name in EXPECTED)).sort();
    const liveSet = new Set(live);
    const missingFromTree = Object.keys(EXPECTED).filter(name => !liveSet.has(name)).sort();
    const wrongTarget = live.filter(name => resolveTarget(layout, name) !== EXPECTED[name]).map(name => `${name}: ${resolveTarget(layout, name)} != ${EXPECTED[name]}`).sort();
    expect({ missingFromFixture, missingFromTree, wrongTarget }).toEqual({ missingFromFixture: [], missingFromTree: [], wrongTarget: [] });
  });

  test("the fixture histogram matches the inventory in devlog 001 §2.B", () => {
    const histogram: Record<string, number> = {};
    for (const target of Object.values(EXPECTED)) histogram[target] = (histogram[target] ?? 0) + 1;
    const doc = readFileSync(repoPath("devlog", "_plan", "260905_test_modularization_and_windows", "001_test_inventory.md"), "utf8");
    const expected: Record<string, number> = {};
    for (const m of doc.matchAll(/^#### `tests\/([a-z0-9/-]+)\/` \((\d+)\)$/gm)) expected[m[1]!] = Number(m[2]);
    expect(Object.keys(expected).length).toBeGreaterThan(20);
    expect(histogram).toEqual(expected);
  });
});

describe("move end to end", () => {
  function scratchRepo(): { root: string; cleanup(): void } {
    const root = mkdtempSync(join(tmpdir(), "ocx-test-layout-"));
    const git = (...args: string[]) => {
      const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
      return proc.stdout.toString();
    };
    git("init", "-q");
    git("config", "user.email", ["a", "b.com"].join("@"));
    git("config", "user.name", "t");
    mkdirSync(join(root, "tests", "helpers"), { recursive: true });
    mkdirSync(join(root, "tests", "providers"), { recursive: true });
    mkdirSync(join(root, "scripts", "test-layout"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex" }));
    writeFileSync(join(root, "src", "thing.ts"), "export const thing = 1;\n");
    writeFileSync(join(root, "tests", "helpers", "remove-tree.ts"), "export const removeTree = 1;\n");
    writeFileSync(join(root, "tests", "helpers", "child.ts"), "console.log(1);\n");
    writeFileSync(join(root, "tests", "server-a.test.ts"), 'import { thing } from "../src/thing";\nimport { removeTree } from "./helpers/remove-tree";\nconst c = join(import.meta.dir, "helpers", "child.ts");\n');
    writeFileSync(join(root, "tests", "cursor-b.test.ts"), 'import { thing } from "../src/thing";\nconst r = new URL("../package.json", import.meta.url);\n');
    writeFileSync(join(root, "tests", "provider-c.test.ts"), 'import { thing } from "../src/thing"; // names tests/cursor-b.test.ts\n');
    writeFileSync(join(root, "scripts", "test.ts"), 'export const SERIAL_FULL_SUITE_FILES = [\n  "cursor-b.test.ts",\n] as const;\n');
    const layout: Layout = {
      version: 1,
      root: "tests",
      keepAtRoot: [],
      domains: { server: { match: ["^server-"] }, providers: { match: ["^provider-"], children: { cursor: ["^cursor-"] } } },
      explicit: {},
      migrated: [],
    };
    writeFileSync(join(root, "scripts", "test-layout", "layout.json"), JSON.stringify(layout, null, 2));
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    return { root, cleanup: () => removeTreeWithRetry(root) };
  }

  test("moves, rewrites, appends migrated, and refuses a dirty write set", () => {
    const { root, cleanup } = scratchRepo();
    try {
      const layoutPath = join(root, "scripts", "test-layout", "layout.json");
      const logs: string[] = [];
      const plan = planMoves(loadLayout(layoutPath), root, ["server", "providers"]);
      expect(plan.moves.map(m => m.to).sort()).toEqual([
        "tests/providers/cursor/cursor-b.test.ts",
        "tests/providers/provider-c.test.ts",
        "tests/server/server-a.test.ts",
      ]);

      // Dirty rewrite target (scripts/test.ts names a serial-lane file in the slice) aborts.
      writeFileSync(join(root, "scripts", "test.ts"), 'export const SERIAL_FULL_SUITE_FILES = [\n  "cursor-b.test.ts", // dirty\n] as const;\n');
      expect(() => runMove({ root, domains: ["server", "providers"], dryRun: false, layoutPath, log: l => logs.push(l) })).toThrow(/dirty files in the write set/);
      expect(readFileSync(join(root, "tests", "server-a.test.ts"), "utf8")).toContain("./helpers/remove-tree");
      Bun.spawnSync(["git", "checkout", "--", "scripts/test.ts"], { cwd: root });

      // Dirt outside the write set does not abort.
      writeFileSync(join(root, "src", "thing.ts"), "export const thing = 2;\n");
      const report = runMove({ root, domains: ["server", "providers"], dryRun: false, layoutPath, log: l => logs.push(l) });
      expect(report.exitCode).toBe(2); // the child-helper join survives as MANUAL
      expect(report.manual.map(m => m.file)).toEqual(["tests/server/server-a.test.ts"]);

      const serverA = readFileSync(join(root, "tests", "server", "server-a.test.ts"), "utf8");
      expect(serverA).toContain('from "../../src/thing"');
      expect(serverA).toContain('from "../helpers/remove-tree"');
      const cursorB = readFileSync(join(root, "tests", "providers", "cursor", "cursor-b.test.ts"), "utf8");
      expect(cursorB).toContain('from "../../../src/thing"');
      expect(cursorB).toContain('new URL("../../../package.json", import.meta.url)');
      const providerC = readFileSync(join(root, "tests", "providers", "provider-c.test.ts"), "utf8");
      expect(providerC).toContain("names tests/providers/cursor/cursor-b.test.ts");
      const serial = readFileSync(join(root, "scripts", "test.ts"), "utf8");
      expect(serial).toContain('"providers/cursor/cursor-b.test.ts"');
      expect(loadLayout(layoutPath).migrated).toEqual(["providers", "server"]);
      expect(readFileSync(join(root, "src", "thing.ts"), "utf8")).toBe("export const thing = 2;\n");
      const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString();
      // Renamed in the index, then rewritten in the worktree: git reports "RM".
      expect(status).toContain("RM tests/server-a.test.ts -> tests/server/server-a.test.ts");
      expect(status).toContain("RM tests/cursor-b.test.ts -> tests/providers/cursor/cursor-b.test.ts");
    } finally {
      cleanup();
    }
  });
});
