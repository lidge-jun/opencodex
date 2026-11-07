import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { windowsTempAncestryPreload } from "../helpers/windows-temp-ancestry";
import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync, linkSync } from "node:fs";
import { join } from "node:path";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { startWindowsCliChild, type WindowsCliChild } from "../../src/codex/windows-cli-child";
import { windowsInstallNamespaceSupported } from "../../src/codex/cli-update-windows-observation";
import { createWindowsApplyFixtures, native, WINDOWS_APPLY_BUDGET_MS, WINDOWS_APPLY_CHILD_BUDGET_MS, mainRoot, backingRoot, write } from "../helpers/codex-cli-windows-apply-fixture";

const { roots, fixture, approved } = createWindowsApplyFixtures();

native("Windows shared prefix preserves unrelated package and shims while executing x64 backing", async () => {
  // Use the existing Windows compiler, with no package install or downloaded binary.
  // This is a CLR x64 executable fixture with actual Win32 Job observation, not vendor Codex.
  const build = createCodexCliTestRoot("ocx-win-apply-"); roots.push(build);
  const source = join(build, "Backing.cs"), exe = join(build, "backing.exe"), trace = join(build, "native.json");
  write(source, [
    'using System; using System.IO; using System.Runtime.InteropServices;',
    'class Backing {',
    '[DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();',
    '[DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool inside);',
    'static int Main(string[] args) { bool inside;',
    'if(IntPtr.Size!=8 || args.Length!=1 || args[0]!="--version" || !IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out inside) || !inside)return 93;',
    'var self=System.Diagnostics.Process.GetCurrentProcess();',
    `File.WriteAllText(@"${trace.replaceAll('"', '""')}", "{\\"inJob\\":true,\\"x64\\":true,\\"pid\\":"+self.Id+",\\"startUtc\\":\\""+self.StartTime.ToUniversalTime().ToString("o")+"\\"}");`,
    'Console.WriteLine("codex-cli 1.1.0"); return 0; } }',
  ].join("\n"));
  const compiler = join(process.env.SystemRoot ?? "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  expect(existsSync(compiler), "x64 fixture compiler must be available; do not substitute a synthetic PE").toBe(true);
  // A cold .NET Framework compiler on a fresh runner can take seconds before it emits anything;
  // it is a real external binary, so it gets the shared spawn budget (still well inside the test's).
  const compiled = await spawnTestChild([compiler, "/nologo", "/platform:x64", "/target:exe", `/out:${exe}`, source],
    { cwd: build, env: process.env, deadlineMs: SPAWN_BUDGET_MS });
  const compileReport = JSON.stringify({ timedOut: compiled.timedOut, elapsedMs: compiled.elapsedMs, signal: compiled.signal });
  expect(compiled.reaped && compiled.pipesClosed, compileReport).toBe(true);
  expect(compiled.exitCode, `${compileReport}\n${compiled.stdout}${compiled.stderr}`).toBe(0);
  const f = await fixture(readFileSync(exe));
  const unrelated = { "node_modules/unrelated/package.json": '{"name":"unrelated","version":"2.0.0","bin":"index.js"}',
    "node_modules/unrelated/index.js": '#!/usr/bin/env node\nconsole.log("unrelated");\n',
    "unrelated": "unrelated bare shim\n", "unrelated.cmd": "unrelated cmd shim\n", "unrelated.ps1": "unrelated powershell shim\n" };
  for (const [path, bytes] of Object.entries(unrelated)) write(join(f.prefix, path), bytes);
  const children: WindowsCliChild[] = [];
  const id = await approved(f), result = await applyCodexCliUpdate(id, { ...f.deps, startWindowsChild: invocation => {
    const child = startWindowsCliChild(invocation); children.push(child); return child;
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", reason: "verified_target", installerExitCode: 0,
    installedVersion: "1.1.0", leaseRetained: false, cleanupErrors: [], verificationPid: null });
  const backing = JSON.parse(readFileSync(trace, "utf8"));
  expect(backing).toMatchObject({ inJob: true, x64: true }); expect(backing.pid).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(backing.startUtc))).toBe(false);
  expect(children).toHaveLength(2);
  for (const child of children) {
    expect(child.observe()).toMatchObject({ terminal: true, unknown: false });
    expect((await child.wait()).cleanupComplete).toBe(true); expect(child.native.handles.size).toBe(0);
  }
  // Preserve actual descendant identity in the supervisor's bounded test log.
  console.log("owned x64 fixture", JSON.stringify({ backing, jobs: children.map(c => ({ pid: c.pid, start: c.creationTime })) }));
  for (const [path, bytes] of Object.entries(unrelated)) expect(readFileSync(join(f.prefix, path), "utf8")).toBe(bytes);
  expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
}, WINDOWS_APPLY_BUDGET_MS);

native.each(["package", "shim", "new-entry"] as const)("Windows shared prefix unexpected %s mutation is ambiguous", async kind => {
  const f = await fixture();
  write(join(f.prefix, "node_modules/unrelated/package.json"), '{"name":"unrelated","version":"2.0.0"}');
  write(join(f.prefix, "unrelated.cmd"), "original");
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => {
    for (const [path, bytes] of Object.entries(f.target.mainFiles)) write(join(f.prefix, mainRoot, path), bytes);
    for (const [path, bytes] of Object.entries(f.target.backingFiles)) write(join(f.prefix, backingRoot, path), bytes);
    write(join(f.prefix, kind === "package" ? "node_modules/unrelated/package.json" : kind === "shim" ? "unrelated.cmd" : "unexpected"), "changed");
    return { terminal: true, exitCode: 0 };
  } });
  expect(result).toMatchObject({ outcome: "ambiguous", leaseRetained: false });
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows shared namespace still refuses linked unrelated entries", async () => {
  const f = await fixture(), outside = join(f.root, "outside"), alias = join(f.prefix, "node_modules/unrelated");
  mkdirSync(outside); write(join(outside, "value"), "must not be followed or changed");
  symlinkSync(outside, alias, "junction");
  expect(windowsInstallNamespaceSupported(f.prefix)).toBe(false);
  expect((await createCodexCliUpdatePlan(f.deps)).refusal).toBe("windows_apply_disabled");
  unlinkSync(alias);
  linkSync(join(outside, "value"), join(f.prefix, "unrelated.cmd"));
  expect(windowsInstallNamespaceSupported(f.prefix)).toBe(false);
  expect(readFileSync(join(outside, "value"), "utf8")).toBe("must not be followed or changed");
}, WINDOWS_APPLY_BUDGET_MS);

native.each(["installer", "version"] as const)("Windows %s terminal EOF with native CloseHandle failure retains owner and reports cleanup", async policy => {
  const f = await fixture(), id = await approved(f);
  const entry = join(f.root, "cleanup.test.ts"), receipt = join(f.root, "cleanup.json");
  const literals = JSON.stringify({ id, inspectionDeps: f.deps.inspectionDeps, target: f.deps.resolveTarget(),
    main: f.target.main.toString("base64"), backing: f.target.backing.toString("base64"), receipt, prefix: f.prefix, policy,
    mainFiles: f.target.mainFiles, backingFiles: Object.fromEntries(Object.entries(f.target.backingFiles).map(([p, b]) => [p, Buffer.from(b).toString("base64")])) });
  write(entry, [
    'import { test, expect } from "bun:test";',
    'import { existsSync, writeFileSync, readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `import { applyCodexCliUpdate } from ${JSON.stringify(repoPath("src/codex/cli-update-apply.ts"))};`,
    `import { WindowsChildNative } from ${JSON.stringify(repoPath("src/codex/windows-cli-child-native.ts"))};`,
    `import { startWindowsCliChildWithNative } from ${JSON.stringify(repoPath("src/codex/windows-cli-child.ts"))};`,
    `import { normalizeCodexCliJobResult } from ${JSON.stringify(repoPath("src/codex/cli-update-job-execution.ts"))};`,
    `import { projectCodexCliUpdateJobLifecycle } from ${JSON.stringify(repoPath("src/codex/cli-update-job.ts"))};`,
    `const f=${literals};`,
    'test("terminal cleanup ownership",async()=>{ let child, realClose; const native=new WindowsChildNative();',
    'try { const result=await applyCodexCliUpdate(f.id,{platform:"win32",inspectionDeps:f.inspectionDeps,',
    'resolveTarget:()=>f.target,scanProcesses:()=>({kind:"observed",processes:[]}),',
    'fetchArtifact:async a=>Buffer.from(a.installName==="@openai/codex"?f.main:f.backing,"base64"),',
    'install:f.policy==="version"?async()=>{ for(const [p,b] of Object.entries(f.mainFiles))writeFileSync(join(f.prefix,"node_modules/@openai/codex",p),b);',
    'for(const [p,b] of Object.entries(f.backingFiles))writeFileSync(join(f.prefix,"node_modules/@openai/codex-win32-x64",p),Buffer.from(b,"base64"));return {terminal:true,exitCode:0}; }:undefined,',
    'startWindowsChild: invocation=>{ child=startWindowsCliChildWithNative(invocation,native);realClose=native.k.CloseHandle;',
    'native.k.CloseHandle=h=>h===child.process?0:realClose(h);return child; }});',
    'expect(child.observe().terminal).toBe(true);expect(child.pipe.eof).toBe(true);',
    'expect((await child.wait()).cleanupComplete).toBe(false);expect(native.handles.has(child.process)).toBe(true);',
    'expect(result).toMatchObject({outcome:"ambiguous",reason:"child_cleanup_unverified",leaseRetained:true,cleanupErrors:["child_cleanup_failed"]});',
    'expect(JSON.parse(readFileSync(join(f.prefix,"node_modules/@openai/codex/package.json"),"utf8")).version).toBe("1.1.0");',
    'expect(normalizeCodexCliJobResult(result)).toEqual(result);',
    'expect(projectCodexCliUpdateJobLifecycle({...result,status:"finished",active:false})).toMatchObject({childState:"terminal",leaseState:"retained"});',
    'const stage=existsSync(join(f.prefix,".ocx-codex-cli-apply.lock/stage"));expect(stage).toBe(true);',
    'writeFileSync(f.receipt,JSON.stringify({result,stage,terminal:child.observe().terminal,handles:native.handles.size}));',
    '} finally { if(realClose)native.k.CloseHandle=realClose; for(const h of [...native.handles])native.close(h);expect(native.dispose()).toBe(true); }',
    `},${WINDOWS_APPLY_CHILD_BUDGET_MS});`,
  ].join("\n"));
  const result = await spawnTestChild([process.execPath, "test", "--preload", windowsTempAncestryPreload(f.root),
    "--no-env-file", "--no-install", "--timeout", String(WINDOWS_APPLY_CHILD_BUDGET_MS), entry],
    { cwd: repoRoot(), env: process.env, deadlineMs: WINDOWS_APPLY_CHILD_BUDGET_MS + 5000 });
  expect(result.reaped && result.pipesClosed).toBe(true); expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ terminal: true, handles: 1, stage: true });
  // Retained authority is intentionally not released by production. This isolated
  // owner has exited, so only now may afterEach remove its private fixture prefix.
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows shared prefix terminal no-op preserves full observed original", async () => {
  const f = await fixture();
  write(join(f.prefix, "node_modules/unrelated/package.json"), '{"name":"unrelated","version":"2.0.0"}');
  write(join(f.prefix, "unrelated.cmd"), "original");
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => ({ terminal: true, exitCode: 0 }) });
  expect(result).toMatchObject({ outcome: "not_applied", reason: "original_install_unchanged", leaseRetained: false, cleanupErrors: [] });
}, WINDOWS_APPLY_BUDGET_MS);
