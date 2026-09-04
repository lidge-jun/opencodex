import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { repoPath, repoRoot } from "./helpers/repo-root";
import { listTestFiles, planMoves } from "../scripts/test-layout/plan";
import { runMove } from "../scripts/test-layout/move";
import { runVerify } from "../scripts/test-layout/verify";
import {
  anchors,
  currentPath,
  loadLayout,
  resolveTarget,
  rewriteMetaDirEscapes,
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
    (s: string) => `mock.module("${s}", () => ({}));`,
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
  test("rewriteMetaDirEscapes converts the documented shapes and adds the helper import once", () => {
    const src = [
      'import { join } from "node:path";',
      'import { x } from "../../src/x";',
      '',
      'const a = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");',
      'const b = join(import.meta.dir, "../src/lib/winsw.ts");',
      'const c = copyFileSync(join(import.meta.dir, "helpers", "child.ts"), out);',
      'const d = join(import.meta.dir, "..");',
      'const e = fileURLToPath(new URL("../", import.meta.url));',
      'const f = readFileSync(join(import.meta.dir, "fixtures/x.json"), "utf8");',
      'const g = join(import.meta.dir, "helpers/child.ts");',
      'const local = join(import.meta.dir, ".tmp-x");',
    ].join("\n");
    const { source, rewrites } = rewriteMetaDirEscapes(src, 1);
    expect(rewrites).toBe(7);
    expect(source).toContain('import { fixturePath, helperPath, repoPath, repoRoot } from "../helpers/repo-root";');
    expect(source).toContain('readFileSync(fixturePath("x.json"), "utf8")');
    expect(source).toContain('const g = helperPath("child.ts");');
    expect(source).toContain('readFileSync(repoPath("src", "cli", "index.ts"), "utf8")');
    expect(source).toContain('repoPath("src/lib/winsw.ts")');
    expect(source).toContain('copyFileSync(helperPath("child.ts"), out)');
    expect(source).toContain("const d = repoRoot();");
    expect(source).toContain("const e = repoRoot();");
    expect(source).toContain('join(import.meta.dir, ".tmp-x")');
    expect(scanEscapes(source)).toEqual([]);
    expect(rewriteMetaDirEscapes(source, 1).rewrites).toBe(0);
  });

  test("rewrites never touch string, template, or comment payloads", () => {
    const src = [
      'import { thing } from "../src/thing";',
      '// import { c } from "../src/comment";',
      'const oracle = \'expect(text).toContain(\\\'await import("../grok/inject")\\\')\';',
      'const tpl = `import { x } from "../src/tpl";`;',
      'const plain = "from \\"../src/plain\\"";',
      '/* join(import.meta.dir, "..", "src") */',
      'const note = "join(import.meta.dir, \\"..\\")";',
    ].join("\n");
    const out = rewriteMetaDirEscapes(rewriteSource(src, 2), 2);
    expect(out.rewrites).toBe(0);
    const lines = out.source.split("\n");
    expect(lines[0]).toBe('import { thing } from "../../../src/thing";');
    expect(lines.slice(1)).toEqual(src.split("\n").slice(1));
    expect(scanEscapes(src)).toEqual([]);
  });

  test("a local repoRoot binding is rebound through an aliased import; other helper-named locals stop the rewrite", () => {
    const src = 'import { join } from "node:path";\nconst repoRoot = join(import.meta.dir, "..");\nconst read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");\n';
    const out = rewriteMetaDirEscapes(src, 1);
    expect(out.rewrites).toBe(1);
    expect(out.source.split("\n")[1]).toBe('import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";');
    expect(out.source).toContain("const repoRoot = resolveRepoRoot();");
    expect(out.source).toContain('readFileSync(join(repoRoot, rel), "utf8")');
    expect(scanEscapes(out.source)).toEqual([]);

    // A second escape in the same file must call the alias, never the local string; and a
    // dynamic import() deep in the file must not drag the helper import to the bottom.
    const two = 'import { join } from "node:path";\nconst repoRoot = join(import.meta.dir, "..");\nasync function f() {\n  const m = await import("../src/x");\n  return { cwd: join(import.meta.dir, "..") };\n}\n';
    const outTwo = rewriteMetaDirEscapes(two, 1);
    expect(outTwo.source.split("\n")[1]).toBe('import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";');
    expect(outTwo.source).toContain("return { cwd: resolveRepoRoot() };");
    expect(outTwo.source).not.toContain("repoRoot()");

    // A file whose last line is a stray import still gets the helper in the leading block.
    const trailing = 'import { join } from "node:path";\n\nconst r = join(import.meta.dir, "..");\nimport { X } from "../helpers/x";\n';
    const outTrailing = rewriteMetaDirEscapes(trailing, 1).source.split("\n");
    expect(outTrailing[1]).toBe('import { repoRoot } from "../helpers/repo-root";');
    expect(outTrailing[outTrailing.length - 2]).toBe('import { X } from "../helpers/x";');

    const url = 'import { join } from "node:path";\nconst root = new URL("../../", import.meta.url);\nconst t = await Bun.file(new URL(p, root)).text();\n';
    const outUrl = rewriteMetaDirEscapes(url, 2);
    expect(outUrl.source).toContain('const root = pathToFileURL(repoRoot() + "/");');
    expect(outUrl.source).toContain('import { pathToFileURL } from "node:url";');
    expect(outUrl.source).toContain('import { repoRoot } from "../../helpers/repo-root";');

    const other = 'import { join } from "node:path";\nconst repoPath = (x: string) => x;\nconst s = join(import.meta.dir, "..", "src");\n';
    const outOther = rewriteMetaDirEscapes(other, 1);
    expect(outOther.rewrites).toBe(0);
    expect(outOther.source).toBe(other);
    expect(scanEscapes(other).map(h => h.line)).toEqual([3]);
  });

  test("resolve/dirname/fileURLToPath and multi-line import blocks are handled", () => {
    const src = [
      'import {',
      '  a,',
      '',
      '  b,',
      '} from "../src/ab";',
      'import { resolve, dirname } from "node:path";',
      '',
      'const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");',
      'const gen = resolve(import.meta.dir, "../src/generated/x.ts");',
    ].join("\n");
    const out = rewriteMetaDirEscapes(rewriteSource(src, 1), 1);
    expect(out.rewrites).toBe(2);
    const lines = out.source.split("\n");
    expect(lines[4]).toBe('} from "../../src/ab";');
    expect(lines[5]).toBe('import { resolve, dirname } from "node:path";');
    // Only the helpers the rewrite actually used are imported, so lint stays quiet.
    expect(lines[6]).toBe('import { repoPath, repoRoot } from "../helpers/repo-root";');
    expect(out.source).toContain("const root = repoRoot();");
    expect(out.source).toContain('const gen = repoPath("src/generated/x.ts");');
    expect(scanEscapes(out.source)).toEqual([]);
  });

  test("a partial repo-root import is augmented and a semicolonless import does not swallow the next statement", () => {
    const partial = 'import { repoPath } from "../helpers/repo-root";\nconst a = repoPath("x");\nconst c = copyFileSync(join(import.meta.dir, "helpers", "child.ts"), out);\n';
    const out = rewriteMetaDirEscapes(partial, 1);
    expect(out.source.split("\n")[0]).toBe('import { helperPath, repoPath } from "../helpers/repo-root";');
    expect(out.source.match(/helpers\/repo-root/g)).toHaveLength(1);

    const semicolonless = 'import { join } from "node:path"\nfunction f() {\n  return 1;\n}\nconst r = join(import.meta.dir, "..");\n';
    const lines = rewriteMetaDirEscapes(semicolonless, 1).source.split("\n");
    expect(lines[0]).toBe('import { join } from "node:path"');
    expect(lines[1]).toBe('import { repoRoot } from "../helpers/repo-root";');
    expect(lines[2]).toBe("function f() {");
  });

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
    expect(scanEscapes('const root = fileURLToPath(new URL("..", import.meta.url));')).toHaveLength(1);
    expect(rewriteMetaDirEscapes('const R = fileURLToPath(new URL("..", import.meta.url));\nconst U = new URL("..", import.meta.url).href;\n', 1).source)
      .toContain('const R = repoRoot();\nconst U = pathToFileURL(repoRoot() + "/").href;');
    expect(scanEscapes('const c = join(import.meta.dir, "helpers", "child.ts");')).toHaveLength(1);
    expect(scanEscapes('const r = resolve(\n  import.meta.dir,\n  "..",\n);')).toHaveLength(1);
    expect(scanEscapes('const t = `${import.meta.dir}/../src/x.ts`;')).toHaveLength(1);
    expect(scanEscapes('const u = pathToFileURL(join(import.meta.dir, "../src/lib/x.ts")).href;')).toHaveLength(1);
    expect(scanEscapes('const s = await Bun.file(new URL(file, import.meta.url)).text();')).toHaveLength(1);
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
    expect(resolveTarget({ ...layout, keepAtRoot: ["server-kept.test.ts"] }, "server-kept.test.ts")).toBeNull();
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
    // The explicit map and the fixture are two copies of the same table; they must be identical
    // so a file added to one side cannot silently ride on the regex seeds.
    expect(layout.explicit).toEqual(EXPECTED);
    const live = listTestFiles(repoRoot()).map(rel => basename(rel)).filter(name => !layout.keepAtRoot.includes(name));
    const liveSet = new Set(live);
    const missingFromTree = Object.keys(EXPECTED).filter(name => !liveSet.has(name)).sort();
    // A file the fixture does not know yet (added on dev after the snapshot) is fine as long as
    // the regex seeds place it: that is the whole point of the seeds. It is only an error when
    // nothing resolves it, or when the map and the fixture disagree about a file both know.
    const unresolvedNew = live.filter(name => !(name in EXPECTED) && resolveTarget(layout, name) === null).sort();
    const wrongTarget = live
      .filter(name => name in EXPECTED && resolveTarget(layout, name) !== EXPECTED[name])
      .map(name => `${name}: ${resolveTarget(layout, name)} != ${EXPECTED[name]}`)
      .sort();
    expect({ unresolvedNew, missingFromTree, wrongTarget }).toEqual({ unresolvedNew: [], missingFromTree: [], wrongTarget: [] });
  });

  test("the fixture histogram never drops below the inventory in devlog 001 §2.B", () => {
    // 001 is a snapshot of 2026-09-05; files added on dev afterwards join the fixture and
    // raise a domain's count. A count that falls below the snapshot means a file was dropped
    // from the map, which is the defect this guards against.
    const histogram: Record<string, number> = {};
    for (const target of Object.values(EXPECTED)) histogram[target] = (histogram[target] ?? 0) + 1;
    const doc = readFileSync(repoPath("devlog", "_plan", "260905_test_modularization_and_windows", "001_test_inventory.md"), "utf8");
    const expected: Record<string, number> = {};
    for (const m of doc.matchAll(/^#### `tests\/([a-z0-9/-]+)\/` \((\d+)\)\r?$/gm)) expected[m[1]!] = Number(m[2]);
    expect(Object.keys(expected).length).toBeGreaterThan(20);
    expect(Object.keys(histogram).sort()).toEqual(Object.keys(expected).sort());
    const below = Object.entries(expected).filter(([dir, n]) => (histogram[dir] ?? 0) < n).map(([dir, n]) => `${dir}: ${histogram[dir]} < ${n}`);
    expect(below).toEqual([]);
  });

  test("a file that only the regex seeds know still resolves (new test files before they are mapped)", () => {
    const layout = loadLayout();
    const seedOnly: Layout = { ...layout, explicit: {} };
    // A seed may only ever disagree with the explicit table on a file the table pins on purpose
    // (the 001 §2 "9 disagreeing files" whose name says one thing and whose imports say another).
    // Anything else is a seed pointing at the wrong domain, which would place a brand-new file
    // incorrectly on the day it is added.
    const pinnedOverrides = new Set([
      "openai-responses-passthrough.test.ts",
    ]);
    const mismatches: string[] = [];
    let resolved = 0;
    for (const [name, target] of Object.entries(layout.explicit)) {
      const r = resolveTarget(seedOnly, name);
      if (r === null) continue;
      resolved += 1;
      if (r !== target && !pinnedOverrides.has(name)) mismatches.push(`${name}: seed ${r} != ${target}`);
    }
    expect(resolved).toBeGreaterThan(600);
    expect(mismatches).toEqual([]);
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
      const dry = runMove({ root, domains: ["server", "providers"], dryRun: true, layoutPath, log: l => logs.push(l) });
      expect(dry.exitCode).toBe(0);
      expect(dry.manual).toEqual([]);
      expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString()).toBe(" M src/thing.ts\n");
      const report = runMove({ root, domains: ["server", "providers"], dryRun: false, layoutPath, skipVerify: true, log: l => logs.push(l) });
      expect(report.exitCode).toBe(0);
      expect(report.manual).toEqual([]);
      const verify = runVerify({ root, domains: ["server", "providers"], layoutPath, skipTests: true, log: l => logs.push(l) });
      expect(verify.staleLiterals).toEqual([]);
      expect(verify.manual).toEqual([]);
      expect(verify.ok).toBe(true);
      // The guard's placement rule on the migrated scratch tree: nothing at root, nothing misplaced.
      const migratedLayout = loadLayout(layoutPath);
      for (const rel of listTestFiles(root)) {
        const dirName = rel.slice("tests/".length, rel.lastIndexOf("/"));
        expect(dirName).toBe(resolveTarget(migratedLayout, basename(rel))!);
      }

      const serverA = readFileSync(join(root, "tests", "server", "server-a.test.ts"), "utf8");
      expect(serverA).toContain('from "../../src/thing"');
      expect(serverA).toContain('from "../helpers/remove-tree"');
      expect(serverA).toContain('helperPath("child.ts")');
      expect(serverA).toContain('from "../helpers/repo-root"');
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
