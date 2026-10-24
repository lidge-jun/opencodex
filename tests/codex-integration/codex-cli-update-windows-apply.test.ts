import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync, symlinkSync, unlinkSync, linkSync } from "node:fs";
import { join, dirname, parse } from "node:path";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { inspectCodexCliInstall } from "../../src/codex/cli-install-provenance";
import { holdWindowsCodexCliPlanToolchain, withWindowsCodexCliPlanToolchain } from "../../src/codex/cli-windows-plan-provenance";
import { openWindowsCliApplyAuthority } from "../../src/codex/cli-update-job-store-windows";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { fixtureArtifact, fixtureTar } from "../helpers/codex-cli-apply-artifact";
import { fixturePath, repoPath, repoRoot } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { runCodexCliUpdateJobWork } from "../../src/codex/cli-update-job-execution";
import { startWindowsCliChild, type WindowsCliChild } from "../../src/codex/windows-cli-child";
import { windowsInstallNamespaceSupported } from "../../src/codex/cli-update-windows-observation";

const native = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTreeAfterBackgroundWork(root); });
const mainRoot = "node_modules/@openai/codex", backingRoot = "node_modules/@openai/codex-win32-x64";
const nativePath = "vendor/x86_64-pc-windows-msvc/bin/codex.exe";
const write = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
function artifacts(version: string, executable?: Buffer) {
  const pe = Buffer.alloc(512); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(1, 70); pe.writeUInt16LE(240, 84); pe.writeUInt16LE(2, 86); pe.writeUInt16LE(0x20b, 88);
  // Synthetic PE only. The real Node verification child executes this fixture's JS;
  // this is an npm/readback test, not a claim that a real Codex native binary ran.
  const mainFiles = { "package.json": JSON.stringify({ name: "@openai/codex", version,
    bin: { codex: "bin/codex.js" }, optionalDependencies: { "@openai/codex-win32-x64": version } }),
    "bin/codex.js": executable ? '#!/usr/bin/env node\n' +
      'const cp=require("node:child_process"), path=require("node:path");\n' +
      'const exe=path.join(__dirname,"../../codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");\n' +
      'const child=cp.spawn(exe,process.argv.slice(2),{stdio:"inherit",windowsHide:true});\n' +
      'child.on("error",()=>{process.exitCode=91});child.on("exit",code=>{process.exitCode=code??92});\n'
      : `#!/usr/bin/env node\nconsole.log("codex-cli ${version}");\n`, "README.md": "auxiliary\n" };
  const backingFiles = { "package.json": JSON.stringify({ name: "@openai/codex-win32-x64", version, os: ["win32"], cpu: ["x64"] }),
    [nativePath]: executable ?? pe, "vendor/auxiliary.txt": "auxiliary\n" };
  const main = fixtureTar(mainFiles), backing = fixtureTar(backingFiles);
  return { mainFiles, backingFiles, main, backing, set: { platform: "win32" as const, arch: "x64",
    main: fixtureArtifact(main, version), backing: fixtureArtifact(backing, version, "@openai/codex-win32-x64", "@openai/codex-win32-x64") } };
}
async function fixture(executable?: Buffer) {
  // This host's observed writable AppData ancestry refused; this is not a ban on
  // every profile. Evaluate actual ancestry ACL/owner/reparse evidence instead.
  // Create only this test-owned directory below the repository's volume anchor;
  // never repair or suppress metadata on the host's existing ancestor directories.
  const root = mkdtempSync(join(parse(process.cwd()).root, "ocx-win-apply-")); roots.push(root);
  await hardenSecretDirAsync(root, { required: true });
  const prefix = join(root, "prefix"); mkdirSync(prefix);
  await hardenSecretDirAsync(prefix, { required: true });
  const old = artifacts("1.0.0"), target = artifacts("1.1.0", executable);
  for (const [relative, bytes] of Object.entries(old.mainFiles)) write(join(prefix, mainRoot, relative), bytes);
  for (const [relative, bytes] of Object.entries(old.backingFiles)) write(join(prefix, backingRoot, relative), bytes);
  const shims = JSON.parse(readFileSync(fixturePath("codex-windows-npm-shims.json"), "utf8"));
  for (const [name, bytes] of Object.entries(shims.files)) write(join(prefix, name), String(bytes));
  const nodeDir = join(process.env.ProgramFiles ?? "C:/Program Files", "nodejs");
  const inspectionDeps = { env: { CODEX_CLI_PATH: join(prefix, "codex.cmd"), PATH: nodeDir, PATHEXT: ".EXE;.CMD" },
    configDir: join(root, "absent-home"), arch: "x64" as const, selectionAttested: true };
  const deps = { platform: "win32" as const, inspectionDeps,
    resolveTarget: () => ({ kind: "resolved" as const, version: "1.1.0", integrity: target.set.main.integrity, artifacts: target.set }),
    scanProcesses: () => ({ kind: "observed" as const, processes: [] }),
    fetchArtifact: async (artifact: typeof target.set.main) => artifact.installName === "@openai/codex" ? target.main : target.backing };
  return { root, prefix, old, target, deps };
}
async function approved(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = await createCodexCliUpdatePlan(f.deps);
  expect(plan, JSON.stringify(plan)).toMatchObject({ applicable: true, refusal: null });
  expect(plan.planId).toMatch(/^[a-f0-9]{32}$/); return plan.planId!;
}

native("Windows apply holds distinct prefix lease and private staging, then releases exact owners", async () => {
  const f = await fixture();
  const guard = await openWindowsCliApplyAuthority(f.prefix, true);
  try {
    await guard.createStaging();
    expect(() => renameSync(f.prefix, f.prefix + "-moved")).toThrow();
    expect(() => renameSync(join(f.prefix, "node_modules", "@openai"), join(f.prefix, "node_modules", "moved"))).toThrow();
    await expect(openWindowsCliApplyAuthority(f.prefix, true)).rejects.toThrow();
    await guard.verify(); await guard.removeStaging();
  } finally { expect(await guard.release()).toBe(true); }
  expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
  const replacement = await openWindowsCliApplyAuthority(f.prefix, true);
  try {
    await expect(guard.createStaging()).rejects.toThrow();
    await expect(guard.verify()).rejects.toThrow();
    expect(existsSync(join(replacement.lock, "stage"))).toBe(false);
    await replacement.createStaging(); await replacement.removeStaging();
  } finally { expect(await replacement.release()).toBe(true); }
}, 60000);

native("Windows apply runs real offline npm under owned Job, then verifies full target and version", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, f.deps);
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", reason: "verified_target",
    installerExitCode: 0, installedVersion: "1.1.0", leaseRetained: false, cleanupErrors: [] });
  expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
}, 60000);

native("Windows terminal no-op is not_applied even with nonzero installer exit", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => ({ terminal: true, exitCode: 17 }) });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "not_applied", leaseRetained: false, cleanupErrors: [] });
}, 60000);

native("Windows pack children and installer descendant share transaction ownership", async () => {
  const f = await fixture(), realNode = join(f.deps.inspectionDeps.env.PATH, "node.exe");
  const realNpm = join(f.deps.inspectionDeps.env.PATH, "node_modules/npm/bin/npm-cli.js");
  const tools = join(f.root, "toolchain"), npmCli = join(tools, "node_modules/npm/bin/npm-cli.js"), trace = join(f.root, "trace.jsonl");
  mkdirSync(dirname(npmCli), { recursive: true }); copyFileSync(realNode, join(tools, "node.exe"));
  write(join(tools, "node_modules/npm/package.json"), JSON.stringify({ name: "npm", version: "11.16.0", bin: { npm: "bin/npm-cli.js" } }));
  const sources = Object.fromEntries([f.target.set.main, f.target.set.backing].map((a, i) => {
    const path = join(f.root, `${i}.tgz`); write(path, i ? f.target.backing : f.target.main); return [`${a.name}@${a.version}`, path];
  }));
  write(npmCli, [
    'const fs=require("node:fs"), path=require("node:path"), cp=require("node:child_process");',
    'const args=process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args[0])+"\\n");`,
    `const sources=${JSON.stringify(sources)};`,
    'if(args[0]==="pack") { const source=sources[args[1]]; if(!source)process.exit(91);',
    'const name=path.basename(source); fs.copyFileSync(source,path.join(args[args.indexOf("--pack-destination")+1],name));',
    'console.log(JSON.stringify([{filename:name}])); } else if(args[0]==="install") {',
    `const r=cp.spawnSync(${JSON.stringify(realNode)},[${JSON.stringify(realNpm)},...args],{env:process.env,stdio:"inherit"});process.exit(r.status??92);`,
    '} else process.exit(93);',
  ].join("\n"));
  f.deps.inspectionDeps.env.PATH = tools;
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, fetchArtifact: undefined });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", leaseRetained: false, cleanupErrors: [] });
  expect(readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual(["pack", "pack", "install"]);
}, 60000);

native("Windows complete readback outranks a nonzero installer exit", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => {
    for (const [path, bytes] of Object.entries(f.target.mainFiles)) write(join(f.prefix, mainRoot, path), bytes);
    for (const [path, bytes] of Object.entries(f.target.backingFiles)) write(join(f.prefix, backingRoot, path), bytes);
    return { terminal: true, exitCode: 17 };
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", installerExitCode: 17, cleanupErrors: [] });
}, 60000);

native("Windows cancellation and unknown session observation cannot start an installer", async () => {
  const f = await fixture(), id = await approved(f); let installs = 0;
  const install = async () => { installs++; return { terminal: true, exitCode: 0 }; };
  const abort = new AbortController(); abort.abort();
  expect((await applyCodexCliUpdate(id, { ...f.deps, install, signal: abort.signal })).reason).toBe("cancelled");
  expect((await applyCodexCliUpdate(id, { ...f.deps, install,
    scanProcesses: () => ({ kind: "unavailable" }) })).reason).toBe("blocked_process_state_unknown");
  let scans = 0;
  expect((await applyCodexCliUpdate(id, { ...f.deps, install,
    scanProcesses: () => ++scans < 3 ? { kind: "observed", processes: [] } : { kind: "unavailable" } })).reason)
    .toBe("blocked_process_state_unknown");
  expect(scans).toBe(3);
  expect(installs).toBe(0);
}, 60000);

native.each(["auxiliary", "shim", "hidden-lock", "extra-file", "new-empty-backing", "selection"] as const)("Windows partial %s refuses not_applied", async kind => {
  const f = await fixture();
  if (kind === "new-empty-backing") {
    const nested = join(f.prefix, mainRoot, "bin", "node_modules", "@openai", "codex-win32-x64");
    mkdirSync(dirname(nested), { recursive: true }); renameSync(join(f.prefix, backingRoot), nested);
  }
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => {
    if (kind === "auxiliary") write(join(f.prefix, mainRoot, "README.md"), "changed");
    if (kind === "shim") write(join(f.prefix, "codex.ps1"), "changed");
    if (kind === "hidden-lock") write(join(f.prefix, "node_modules/.package-lock.json"), "{}");
    if (kind === "extra-file") write(join(f.prefix, backingRoot, "unexpected.txt"), "extra");
    if (kind === "new-empty-backing") mkdirSync(join(f.prefix, backingRoot));
    if (kind === "selection") f.deps.inspectionDeps.env.CODEX_CLI_PATH = join(f.prefix, "other.cmd");
    return { terminal: true, exitCode: 1 };
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "ambiguous", leaseRetained: false });
}, 60000);

native("Windows uncertain installer retains lease and staging until owning process exits", async () => {
  const f = await fixture(), id = await approved(f);
  const entry = join(f.root, "uncertain.test.ts"), receipt = join(f.root, "result.json");
  const literals = JSON.stringify({ id, inspectionDeps: f.deps.inspectionDeps, target: f.deps.resolveTarget(),
    main: f.target.main.toString("base64"), backing: f.target.backing.toString("base64"), receipt, prefix: f.prefix });
  writeFileSync(entry, [
    'import { test, expect } from "bun:test";',
    'import { existsSync, writeFileSync } from "node:fs";',
    `import { applyCodexCliUpdate } from ${JSON.stringify(repoPath("src/codex/cli-update-apply.ts"))};`,
    `const f = ${literals};`,
    'test("retained transaction", async () => {',
    'const result = await applyCodexCliUpdate(f.id, { platform:"win32", inspectionDeps:f.inspectionDeps,',
    'resolveTarget:()=>f.target, scanProcesses:()=>({kind:"observed",processes:[]}),',
    'fetchArtifact:async a=>Buffer.from(a.installName==="@openai/codex"?f.main:f.backing,"base64"),',
    'install:async()=>({terminal:false,exitCode:null}) });',
    'const stage=existsSync(f.prefix+"/.ocx-codex-cli-apply.lock/stage");',
    'writeFileSync(f.receipt,JSON.stringify({result,stage}));',
    'expect(result.outcome).toBe("ambiguous"); expect(result.leaseRetained).toBe(true); expect(stage).toBe(true);',
    '},60000);',
  ].join("\n"));
  const child = await spawnTestChild([process.execPath, "--no-env-file", "--no-install", "test", "--timeout", "60000", entry],
    { cwd: repoRoot(), env: process.env, deadlineMs: 55000 });
  expect(child.reaped).toBe(true); expect(child.pipesClosed).toBe(true); expect(child.exitCode, child.stderr).toBe(0);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ stage: true,
    result: { outcome: "ambiguous", reason: "installer_state_unknown", leaseRetained: true } });
  // The child has exited: only now can the fixture's retained kernel handles be gone.
}, 60000);

native("Windows completion persistence retry does not repeat the installer", async () => {
  const f = await fixture(), id = await approved(f); let installs = 0, finishes = 0;
  await runCodexCliUpdateJobWork(() => applyCodexCliUpdate(id, { ...f.deps,
    install: async () => { installs++; return { terminal: true, exitCode: 0 }; } }), {
    begin: async () => 1,
    finish: async (_revision, result) => {
      expect(result.outcome).toBe("not_applied");
      if (++finishes < 3) throw Object.assign(new Error("fixture busy"), { code: "EBUSY" });
      return null;
    }, read: async () => null, release: async () => {},
  });
  expect(installs).toBe(1); expect(finishes).toBe(3);
}, 60000);

native("Windows toolchain pins survive an awaited callback; bounded shared prefix is eligible", async () => {
  const f = await fixture();
  const tools = join(f.root, "toolchain"), npmCli = join(tools, "node_modules/npm/bin/npm-cli.js");
  write(join(tools, "node.exe"), f.old.backingFiles[nativePath]);
  write(join(tools, "node_modules/npm/package.json"), JSON.stringify({ name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" } }));
  write(npmCli, "// never executed\n"); f.deps.inspectionDeps.env.PATH = tools;
  const report = await inspectCodexCliInstall({ ...f.deps.inspectionDeps, observeInstallContent: true });
  expect(report.managed).toBe(true);
  expect(await withWindowsCodexCliPlanToolchain(report, async () => {
    await Bun.sleep(10);
    // This write must still be denied after await; returning a promise while
    // releasing native pins early would make this assertion fail.
    expect(() => writeFileSync(npmCli, "replacement")).toThrow(); return 42;
  })).toBe(42);
  writeFileSync(npmCli, "// changed after release\n");
  const refreshed = await inspectCodexCliInstall({ ...f.deps.inspectionDeps, observeInstallContent: true });
  const pin = await holdWindowsCodexCliPlanToolchain(refreshed); expect(pin).not.toBeNull(); expect(await pin!.release()).toBe(true);
  mkdirSync(join(f.prefix, "node_modules", "unrelated"));
  expect((await createCodexCliUpdatePlan(f.deps)).applicable).toBe(true);
}, 60000);

native("Windows shared prefix preserves unrelated package and shims while executing x64 backing", async () => {
  // Use the existing Windows compiler, with no package install or downloaded binary.
  // This is a CLR x64 executable fixture with actual Win32 Job observation, not vendor Codex.
  const build = mkdtempSync(join(parse(process.cwd()).root, "ocx-win-apply-")); roots.push(build);
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
  const compiled = await spawnTestChild([compiler, "/nologo", "/platform:x64", "/target:exe", `/out:${exe}`, source],
    { cwd: build, env: process.env, deadlineMs: 10000 });
  expect(compiled.reaped && compiled.pipesClosed).toBe(true); expect(compiled.exitCode, compiled.stdout + compiled.stderr).toBe(0);
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
}, 60000);

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
}, 60000);

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
}, 60000);

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
    '},60000);',
  ].join("\n"));
  const result = await spawnTestChild([process.execPath, "--no-env-file", "--no-install", "test", "--timeout", "60000", entry],
    { cwd: repoRoot(), env: process.env, deadlineMs: 55000 });
  expect(result.reaped && result.pipesClosed).toBe(true); expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ terminal: true, handles: 1, stage: true });
  // Retained authority is intentionally not released by production. This isolated
  // owner has exited, so only now may afterEach remove its private fixture prefix.
}, 60000);

native("Windows shared prefix terminal no-op preserves full observed original", async () => {
  const f = await fixture();
  write(join(f.prefix, "node_modules/unrelated/package.json"), '{"name":"unrelated","version":"2.0.0"}');
  write(join(f.prefix, "unrelated.cmd"), "original");
  const id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => ({ terminal: true, exitCode: 0 }) });
  expect(result).toMatchObject({ outcome: "not_applied", reason: "original_install_unchanged", leaseRetained: false, cleanupErrors: [] });
}, 60000);
