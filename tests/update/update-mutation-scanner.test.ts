// Best-effort known-pattern regression lint, not a security boundary or
// completeness proof. Runtime mutation guards enforce update authority.
import { afterAll, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintTest, openUpdateLintParser } from "../helpers/update-lint-parser";
import { rawMutationViolations, updateModuleFiles } from "../helpers/update-mutation-scanner";
import { capabilityControlCalls } from "../helpers/update-helper-inventory";

// Reuse the parser service; each mutant still gets its own file and snapshot.
// Repeated compiler subprocess startup is unrelated to the scanner contract.
const api = openUpdateLintParser();
const lint = lintTest(api);
afterAll(() => api?.close());
function scan(text: string, mode: "scanner" | "inventory" = "scanner", target = "src/update/job-pinned-start.ts") {
  const dir=mkdtempSync(join(tmpdir(),"ocx-raw-mutation-")), file=join(dir,"mutant.ts");
  writeFileSync(file,text); const snapshot=api!.updateSnapshot({openFiles:[file]});
  try {
    const source = snapshot.getDefaultProjectForFile(file)!.program.getSourceFile(file)!;
    return mode === "inventory" ? capabilityControlCalls(source).map(node => node.getText()) : rawMutationViolations(source, target);
  }
  finally {snapshot.dispose();rmSync(dir,{recursive:true,force:true});}
}
// Reviewer round-10 named-object variants: every raw call fails regardless of
// where its options came from. Runtime tests separately prove wrapped refusal.
for (const options of ["startOptions", "{ ...startOptions }", "{ stdio: startOptions.stdio }"])
  lint("raw named-options mutant is rejected: "+options,()=>{
    const mutant='const startOptions = { get stdio(){ return preparePinnedStartStdio(); } }; if(authorizeMutation("runtime")) spawn(cmd.bin,cmd.args,'+options+');';
    expect(scan(mutant).length).toBeGreaterThan(0);
  });
for (const text of [
  'await Bun.file(target).delete();',
  'import { file } from "bun"; await file(target).delete();',
  'import { cpSync } from "node:fs"; cpSync(source, target, {recursive:true,force:true});',
  'import { openSync, ftruncateSync } from "node:fs"; ftruncateSync(openSync(target,"r+"),0);',
  'import { openSync, writeSync } from "node:fs"; writeSync(openSync(target,"r+"),payload);',
  ...["cp", "ftruncate", "write", "rm", "truncate", "writeFile"].flatMap(name => [
    `import { ${name} as mutate } from "node:fs"; mutate(target,payload,callback);`,
    `import { ${name} as mutate } from "node:fs/promises"; await mutate(target,payload);`,
    `import fs from "node:fs"; await fs.promises.${name}(target,payload);`,
    `import * as fs from "node:fs/promises"; const { ${name}: mutate } = fs; await mutate(target,payload);`,
  ]),
  'const handle = await fs.promises.open(target,"r+"); await handle.write(payload);',
  'const handle = await fs.promises.open(target,"r+"); await handle.truncate(0);',
  'const writer = Bun.file(target).writer(); writer.write(payload); await writer.end();',
  'import { file as open } from "bun"; const blob = open(target); const { delete: remove } = blob; await remove();',
  'import { futureMutation as mutate } from "node:fs"; mutate(target);',
  'import { dlopen as load } from "bun:ffi"; load(library, symbols);',
  'import { createConnection as connect } from "node:net"; connect(options);',
  'import { createSocket as socket } from "node:dgram"; socket("udp4");',
  'process.futureControl(target);',
  'process.exit(0);',
  'process.on("SIGTERM", handler);',
  'await fetch(target, {method:"POST", body:payload});',
  'Bun.futureControl(target);',
  ...["node:fs", "fs", "node:fs/promises", "fs/promises", "node:child_process", "node:net", "node:tls", "node:dgram", "node:worker_threads", "bun", "bun:ffi"].flatMap(module => [
    `import * as runtime from "${module}"; runtime.futureControl(target);`,
    `import runtime from "${module}"; const { futureControl: mutate } = runtime; mutate(target);`,
    `export { futureControl as mutate } from "${module}";`,
    `export * as runtime from "${module}";`,
    `const { futureControl: mutate } = await import("${module}"); mutate(target);`,
    `const runtime = require("${module}"); runtime.futureControl(target);`,
  ]),
  'import "node:fs";',
  'const { file: open } = Bun; await open(target).delete();',
  'await (Bun as Record<string, Function>)[method](target);',
  'globalThis.Bun.file(target).delete();',
  'const runtime = globalThis; runtime.Bun.file(target).delete();',
  'const proc = (process); proc.kill(pid);',
  'import { setPriority as mutate } from "node:os"; mutate(pid, 0);',
  'import { erase as mutate } from "future-filesystem"; mutate(target);',
  'import { futureControl as mutate } from "node:future_runtime"; mutate(target);',
  'import { $ } from "bun"; await $`taskkill /PID ${pid} /T /F`.quiet();',
  'import { $ as shell } from "bun"; await shell`ocx stop`;',
  'import * as runtime from "bun"; await runtime.$`ocx stop`;',
  'import runtime from "bun"; await runtime.$`ocx stop`;',
  'await Bun.$`ocx stop`;',
  'const shell = Bun.$; await shell`ocx stop`;',
  'const { $: shell } = Bun; await shell`ocx stop`;',
  'const runtime = Bun; const shell = runtime["$"];',
  'const { $: shell } = await import("bun");',
  'export { $ as shell } from "bun";',
  'export * as runtime from "bun";',
  'const runtime = require("bun");',
  'await shell`ocx stop`;',
  'await Bun.write(livePackage, payload);',
  'import { fork as launch } from "child_process"; launch(file);',
  'new Worker(workerUrl);',
  'import { writeFileSync as replace } from "node:fs"; replace(livePackage, payload);',
  'fs.copyFileSync(source, livePackage);',
  'import { spawn as launch } from "node:child_process"; launch(file,args,options);',
  'import * as cp from "node:child_process"; cp.spawn(file,args,options);',
  'export { spawn as launch } from "node:child_process";',
  'const launch=spawn; launch(file,args,options);',
  'import { kill as terminate } from "node:process"; terminate(pid,"SIGTERM");',
  'const { kill: terminate } = process; terminate(pid,"SIGTERM");',
  'const { [method]: terminate } = process; terminate(pid,"SIGTERM");',
  'const proc = process; proc.kill(pid);',
  'const {kill: terminate} = await import("node:process"); terminate(pid);',
  'export * as proc from "node:process";',
  'import fs from "node:fs"; fs.unlink(state);',
  'import { rm as remove } from "node:fs/promises"; remove(state);',
  'process.kill(pid);', 'fs.rename(from,to);', 'fs.unlink(state);', 'killProxy(pid);',
  'spawn(file,args,{get stdio(){return blocking();}});',
  'if(authorizeMutation("runtime")){await ready();spawn(file,args,options);}',
]) lint("scanner rejects raw reference/alias: "+text,()=>expect(scan(text).length).toBeGreaterThan(0));

for (const text of [
  'await Bun.file(target).delete();',
  'import { file } from "bun"; await file(target).delete();',
  ...["cpSync", "ftruncateSync", "writeSync", "cp", "ftruncate", "write"].map(name =>
    `import { ${name} as mutate } from "node:fs"; mutate(target,payload);`),
  ...["rm", "cp", "truncate", "writeFile"].flatMap(name => [
    `import { ${name} as mutate } from "node:fs/promises"; await mutate(target,payload);`,
    `import fs from "node:fs"; await fs.promises.${name}(target,payload);`,
  ]),
  'import { open } from "node:fs/promises"; const handle = await open(target,"r+"); await handle.write(payload);',
  'import { open } from "node:fs/promises"; const handle = await open(target,"r+"); await handle.truncate(0);',
  'const writer = Bun.file(target).writer(); writer.write(payload);',
  'import { futureMutation as mutate } from "node:fs"; const alias = mutate; alias(target);',
  'import * as sockets from "node:net"; sockets.createConnection(options);',
  'process.futureControl(target);',
]) lint("inventory includes sensitive capability acquisition/call: " + text, () => expect(scan(text, "inventory").length).toBeGreaterThan(0));

lint("explicit read-only imports and runtime observations remain allowed", () => {
  expect(scan('import { readFileSync as read, statSync } from "node:fs"; import { readFile } from "node:fs/promises"; import { sleep } from "bun"; read(target); statSync(target); await readFile(target); await sleep(1); process.cwd(); process.getuid?.(); process.env.HOME; Bun.sleep(1);')).toEqual([]);
  expect(scan('import type { FileHandle } from "node:fs/promises"; import type { ChildProcess } from "node:child_process"; type T = typeof Bun;')).toEqual([]);
});

lint("exact log exemptions reject another target, descriptor, or occurrence", () => {
  const prefix = 'import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"; function spawnWorkerPinnedStart(){';
  expect(scan(prefix + 'closeSync(logFd);}', "scanner")).toEqual([]);
  expect(scan(prefix + 'openSync(livePackage,"w");}', "scanner").length).toBeGreaterThan(0);
  expect(scan(prefix + 'closeSync(otherFd);}', "scanner").length).toBeGreaterThan(0);
  expect(scan(prefix + 'closeSync(logFd); closeSync(logFd); closeSync(logFd);}', "scanner")).toContain('extra allowlisted capability occurrence: closeSync(logFd)');
});
lint("wrapped options require no static argument grammar",()=>{
  expect(scan('guardedSpawn(authorizeMutation,"runtime",cmd.bin,cmd.args,startOptions);')).toEqual([]);
  expect(scan('guardedSpawn(authorizeMutation,"runtime",cmd.bin,cmd.args,{ ...startOptions });')).toEqual([]);
});

lint("update inventory descends into nested module directories", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-update-inventory-"));
  try {
    mkdirSync(join(root, "nested", "deeper"), { recursive: true });
    for (const name of ["entry.ts", "nested/helper.mjs", "nested/deeper/control.js", "nested/deeper/control.d.ts", "nested/deeper/types.d.mts"])
      writeFileSync(join(root, name), "");
    expect(updateModuleFiles(root)).toEqual(["src/update/entry.ts", "src/update/nested/deeper/control.js", "src/update/nested/helper.mjs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
