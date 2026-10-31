// Auxiliary regression lint over known patterns, not a security boundary or
// completeness proof. Runtime mutation guards enforce update authority.
import { afterAll, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintTest, openUpdateLintParser } from "../helpers/update-lint-parser";
import { rawMutationViolations } from "../helpers/update-mutation-scanner";
import { capabilityControlCalls } from "../helpers/update-helper-inventory";
import { repoPath } from "../helpers/repo-root";

const api = openUpdateLintParser();
const lint = lintTest(api);
afterAll(() => api?.close());
function inspect(text: string, target = "src/update/job-pinned-start.ts") {
  const dir = mkdtempSync(join(tmpdir(), "ocx-closed-policy-")), file = join(dir, "probe.ts");
  writeFileSync(file, text);
  const snapshot = api!.updateSnapshot({ openFiles: [file] });
  try {
    const source = snapshot.getDefaultProjectForFile(file)!.program.getSourceFile(file)!;
    return { scanner: rawMutationViolations(source, target), inventory: capabilityControlCalls(source, target) };
  } finally { snapshot.dispose(); rmSync(dir, { recursive: true, force: true }); }
}

const probes = [
  'import.meta.require("node:fs").cpSync(source,target);',
  'const io = import.meta.require("node:fs"); io.cpSync(source,target);',
  'const { cpSync: copy } = import.meta.require("node:fs"); copy(source,target);',
  'const { openSync: open, ftruncateSync: cut } = import.meta.require("node:fs"); cut(open(target,"r+"),0);',
  'import.meta.require("node:net").createConnection(options);',
  'import.meta.require("bun:ffi").dlopen(library,symbols);',
  'import.meta.require("bun").file(target).delete();',
  'const load = require; load("node:fs").cpSync(source,target);',
  'const load = import.meta.require; const io = load("node:fs"); const copy = io.cpSync; copy(source,target);',
  'const load = require; const io = load("node:fs"); const { cpSync: copy } = io; copy(source,target);',
  'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const load = require; load("node:fs").cpSync(source,target);',
  'import { createRequire } from "node:module"; function bunBinDir(launcherPath){ const resolver = createRequire(launcherPath || import.meta.url); return resolver("node:fs").cpSync(source,target); }',
  'const { require: load } = import.meta; load("node:fs").cpSync(source,target);',
  'const load = (import.meta["require"]); load("node:fs").cpSync(source,target);',
  'const runtime = module; runtime.require("node:fs").cpSync(source,target);',
  'const out = exports; out.publish(target);',
  'eval(payload);', 'const run = eval; run(payload);', 'new Function(payload)();', // justified: parsed adversarial fixtures, never executed
  'const run = Function; run(payload)();',
  'globalThis.setTimeout(callback,0);', 'const root = globalThis; root.run(payload);',
  'const { run } = global; run(payload);', 'consume(self);',
  'Reflect.apply(operation,null,args);', 'const invoke = Reflect.apply; invoke(operation,null,args);',
  'const root = new Proxy(process,handler); root.cwd();',
  'WebAssembly.instantiate(bytes);',
  'process.binding("fs");', 'process.dlopen(module,path);', 'process._linkedBinding("fs");',
  'process["cwd"]();', 'Bun["sleep"](1);',
  'const { cwd } = process; cwd();', 'const copy = {...Bun}; copy.sleep(1);',
  'const get = () => process; get().cwd();', 'consume(process);',
  'await import("./new-helper");', 'const load = () => import("./index"); await load();',
  'import.meta.resolve("node:fs");',
  'import { run } from "./unreviewed-helper"; run(target);',
  'let load; load = require; let io; io = load("node:fs"); io.cpSync(source,target);',
];
for (const probe of probes) for (const mode of ["scanner", "inventory"] as const)
  lint(`${mode} rejects known acquisition pattern: ${probe}`, () => {
    expect(inspect(probe, "bin/ocx.mjs")[mode].length).toBeGreaterThan(0);
  });

for (const probe of [
  'import { helper } from "./unreviewed-helper";',
  'import { run } from "../service/unreviewed";',
  'import { setTimeout } from "node:timers";',
  'export * from "./unreviewed-helper";',
  'import "./index";',
]) lint("static imports/exports require explicit admission: " + probe, () => {
  expect(inspect(probe).scanner.length).toBeGreaterThan(0);
});

for (const target of ["src/update/mutation-guard.mjs", "src/update/guarded-runtime-ops.ts", "src/update/guarded-tray-ops.ts"])
  for (const probe of ['import.meta.require("node:fs").cpSync(source,target);',
    'const load = require; load("node:fs");', 'Reflect.apply(operation,null,args);',
    'await import("node:vm");', 'import { runInThisContext } from "node:vm";'])
    lint("wrapper lint rejects known import/root pattern: " + target + ": " + probe, () => {
      expect(inspect(probe, target).scanner.length).toBeGreaterThan(0);
    });

lint("inventory preserves loader-result identity through destructuring", () => {
  const result = inspect('const load = require; const io = load("node:fs"); const { cpSync: copy } = io; copy(source,target);');
  expect(result.inventory.map(node => node.getText())).toContain("copy(source,target)");
});

lint("wrapper root slots reject extra occurrences", () => {
  expect(inspect('function materializeMutationData(value){ Reflect.ownKeys(value); Reflect.ownKeys(value); }',
    "src/update/mutation-guard.mjs").scanner.length).toBeGreaterThan(0);
});

lint("deferred imports admit only reviewed bindings, contexts and counts", () => {
  const binding = 'const { guardedStartWindowsTray } = await import("./guarded-tray-ops");';
  expect(inspect('async function runUpdate(){' + binding.repeat(3) + '}', "src/update/index.ts").scanner).toEqual([]);
  for (const body of [binding.repeat(4), 'const runtime = await import("./guarded-tray-ops");',
    'const { startWindowsTray } = await import("./guarded-tray-ops");'])
    expect(inspect('async function runUpdate(){' + body + '}', "src/update/index.ts").scanner.length).toBeGreaterThan(0);
  expect(inspect('async function other(){' + binding + '}', "src/update/index.ts").scanner.length).toBeGreaterThan(0);
});

lint("production resolver resolves default and alternate package roots without executing a package", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-resolver-"));
  try {
    const source = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
    const start = source.indexOf("function bunBinDir(launcherPath) {");
    const body = source.slice(start, source.indexOf("\n}", start) + 2);
    expect(body).toContain('resolver.resolve("bun/package.json")');
    const roots = [root, join(root, "other")];
    for (const base of roots) {
      mkdirSync(join(base, "node_modules", "bun"), { recursive: true });
      writeFileSync(join(base, "node_modules", "bun", "package.json"), '{"name":"bun","main":"index.js"}');
      writeFileSync(join(base, "node_modules", "bun", "index.js"), 'throw new Error("package code must not load");');
    }
    const fixture = join(root, "resolver.mjs");
    writeFileSync(fixture, 'import {createRequire} from "node:module"; import {dirname} from "node:path";\n'
      + body + '\nconsole.log(JSON.stringify([bunBinDir(),bunBinDir(process.argv[2]),bunBinDir("")]));\n');
    const result = spawnSync(process.platform === "win32" ? "node.exe" : "node", [fixture, join(roots[1], "launcher.mjs")],
      { encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([root, roots[1], root].map(base => join(base, "node_modules", "bun")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

lint("resolver-only site admits resolution and rejects escape, aliases and a second factory", () => {
  const prefix = 'import { createRequire } from "node:module"; function bunBinDir(launcherPath){';
  const factory = 'const resolver = createRequire(launcherPath || import.meta.url);';
  expect(inspect(prefix + factory + 'return dirname(resolver.resolve("bun/package.json"));}', "bin/ocx.mjs").scanner).toEqual([]);
  for (const use of ['return resolver;', 'const load = resolver; return load("node:fs");',
    'consume(resolver);', 'return resolver.resolve.call(null,"bun/package.json");',
    'return resolver["resolve"]("bun/package.json");', 'return resolver.resolve("node:fs");',
    'const other = createRequire(launcherPath || import.meta.url);'])
    expect(inspect(prefix + factory + use + '}', "bin/ocx.mjs").scanner.length).toBeGreaterThan(0);
});
