import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { assertNotRealHomeUnderTest } from "../../src/lib/test-home-guard";
import { encodeOrchestratedExpect, issueOrchestratedResultCapability } from "../../src/update/orchestrated-session.mjs";
import { createUpdatePlanToken } from "../../src/update/orchestrated-token.mjs";
import { inspectUpdateMarker, inspectUpdateSyncMutex, tryAcquireUpdateSyncMutex } from "../../src/update/sync-update-mutex.mjs";
import { isUpdateInFlight } from "../../src/update/sync-update-mutex";
import { watch } from "node:fs";

// These scenarios run sequentially in one disposable home. Simulate the bound
// passing only after the fixture worker and recorded installer have settled.
function expireFixtureFence(home: string) {
  const path = join(home, "update-orchestrated.json"), marker = JSON.parse(readFileSync(path, "utf8"));
  expect(["failed", "installed", "refused"]).toContain(marker.phase);
  expect(inspectUpdateSyncMutex(home)).toBe("free");
  if (marker.fenceUntil === undefined) { expect(inspectUpdateMarker(home)).toBe("free"); return; }
  expect(inspectUpdateMarker(home, { now: () => marker.fenceUntil })).toBe("free");
  marker.fenceUntil = marker.startedAt;
  writeFileSync(path, JSON.stringify(marker));
}

function expectSyncAdmission(pkg: string, cwd: string, env: Record<string, string | undefined>, admitted: boolean) {
  const sync = spawnSync(process.execPath, [join(pkg, "src/cli/index.ts"), "sync", "--local-only", "--expect-link", "lnk_0000000000000000"],
    { cwd, env, encoding: "utf8", timeout: 30000 });
  // A disconnected-link refusal is reached only after the update guard admits sync.
  expect({ status: sync.status, stderr: sync.stderr }).toMatchObject({ status: admitted ? 5 : 7 });
}

test.skipIf(process.platform === "win32")("npm child fences identity, deadline and sync before mutation and installs the pinned version", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-node-pin-")));
  const home = join(root, "home"), pkg = join(root, "lib/node_modules/@bitkyc08/opencodex"), path = join(root, "path");
  const result = join(root, "result.json"), log = join(root, "npm.log"), cache = join(root, "cache");
  mkdirSync(home); mkdirSync(path); mkdirSync(cache); mkdirSync(pkg, { recursive: true });
  try {
    cpSync(repoPath("src"), join(pkg, "src"), { recursive: true });
    cpSync(repoPath("bin"), join(pkg, "bin"), { recursive: true });
    const launcher = join(pkg, "bin/ocx.mjs");
    const originalLauncher = readFileSync(launcher, "utf8");
    writeFileSync(launcher, originalLauncher.replace("#!/usr/bin/env node\n", `#!/usr/bin/env node\nif (process.env.OCX_UPDATE_ORCHESTRATED_CHILD === '1' && process.env.OCX_FIXTURE_EXIT_EFFECT) {\n  const once = process.once.bind(process);\n  process.once = function(event, listener) {\n    const result = once(event, listener);\n    if (event === 'exit') once('exit', () => {\n      const fs = requireFixtureFs;\n      const output = process.argv[process.argv.indexOf('--orchestrated-result') + 1];\n      if (process.env.OCX_FIXTURE_EXIT_EFFECT === 'missing') fs.unlinkSync(output);\n      if (process.env.OCX_FIXTURE_EXIT_EFFECT === 'damage') fs.unlinkSync(process.env.OCX_FIXTURE_PKG + '/src/cli/index.ts');\n    });\n    return result;\n  };\n}\nimport * as requireFixtureFs from 'node:fs';\n`));
    const timedLauncher = readFileSync(launcher, "utf8").replace("import * as requireFixtureFs from 'node:fs';", `import * as requireFixtureFs from 'node:fs';
if (process.env.OCX_FIXTURE_OVERRUN === '1' && process.argv.includes('--yes')) {
  const start = globalThis.setTimeout, clear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms < 800000) return start(fn, ms, ...args);
    const state = { watcher: null, timer: null };
    state.watcher = requireFixtureFs.watch(process.env.OPENCODEX_HOME, () => {
      try {
        const marker = JSON.parse(requireFixtureFs.readFileSync(process.env.OPENCODEX_HOME + '/update-orchestrated.json'));
        if (marker.phase === 'mutating') { state.watcher.close(); clear(state.timer); fn(...args); }
      } catch (error) {
        // The marker is published by atomic rename: only absence or a not-yet-JSON read is expected here.
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    });
    state.timer = start(() => { state.watcher.close(); fn(...args); }, 15000);
    return state;
  };
  globalThis.clearTimeout = handle => {
    if (handle && handle.watcher) { handle.watcher.close(); clear(handle.timer); }
    else clear(handle);
  };
}`);
    const supervisedLauncher = timedLauncher.replace('markerPath: join(configDir(), "update-orchestrated.json"), authorizeMutation:',
      'markerPath: join(configDir(), "update-orchestrated.json"), timeoutMs: process.env.OCX_FIXTURE_TIMEOUT ? 1000 : 180000, authorizeMutation:');
    if (supervisedLauncher === timedLauncher) throw new Error("installer timeout injection point missing");
    writeFileSync(launcher, supervisedLauncher);
    const manifest = JSON.parse(readFileSync(repoPath("package.json"), "utf8")); manifest.version = "2.0.0";
    writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
    symlinkSync(repoPath("node_modules"), join(pkg, "node_modules"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 1 }));
    const executable = Bun.which("node"); if (!executable) throw new Error("Node required");
    const node = spawnSync(executable, ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
    if (!node || !node.startsWith("/")) throw new Error("Node executable is not an absolute path");
    writeFileSync(join(path, "npm"), `#!${node}\nconst fs=require('node:fs'), p=require('node:path'), a=process.argv.slice(2);\nfs.appendFileSync(process.env.OCX_FIXTURE_LOG,JSON.stringify({args:a,capability:process.env.OCX_UPDATE_RESULT_CAPABILITY??null,outcome:JSON.parse(fs.readFileSync(process.env.OCX_FIXTURE_RESULT))})+'\\n');\nif(a[0]==='config') console.log(process.env.OCX_FIXTURE_CACHE);\nelse if(a[0]==='view') console.log(a.includes('dist.integrity')?'sha512-YWJj':(process.env.OCX_FIXTURE_MOVED==='1' && a.some(x=>x.endsWith('@2.1.0'))?'2.2.0':'2.1.0'));\nelse if(a[0]==='install'){const s=a[a.indexOf('--prefix')+1],d=p.join(s,'lib/node_modules/@bitkyc08/opencodex');fs.cpSync(process.env.OCX_FIXTURE_PKG,d,{recursive:true});const m=JSON.parse(fs.readFileSync(p.join(d,'package.json')));m.version='2.1.0';fs.writeFileSync(p.join(d,'package.json'),JSON.stringify(m));if(process.env.OCX_FIXTURE_ROLLBACK==='1'){const l=p.join(d,'bin/ocx.mjs'),t=p.join(s,'temporary-launcher');fs.copyFileSync(l,t);fs.unlinkSync(l);fs.symlinkSync(p.relative(p.dirname(l),t),l);}}\nelse process.exit(90);\n`);
    chmodSync(join(path, "npm"), 0o755);
    const npmScript = join(path, "npm"), npmSource = readFileSync(npmScript, "utf8");
    const npmTimed = npmSource.replace("const s=a[a.indexOf('--prefix')+1]", "if(process.env.OCX_FIXTURE_TIMEOUT==='1'){const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.env.OCX_FIXTURE_DESCENDANT,String(c.pid));setInterval(()=>{},1000);return;}const s=a[a.indexOf('--prefix')+1]");
    if (npmTimed === npmSource) throw new Error("installer fixture injection point missing");
    writeFileSync(npmScript, npmTimed);
    const token = createUpdatePlanToken({ currentVersion: "2.0.0", targetVersion: "2.1.0", installer: "npm", cliRoot: pkg, servingRoot: null, runtimeOwner: "none", runtime: null });
    const env = { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: join(root, "codex"),
      OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_UPDATE_ORCHESTRATED_CHILD: "1",
      OPENCODEX_BUN_PATH: process.execPath, PATH: path, OCX_FIXTURE_LOG: log, OCX_FIXTURE_CACHE: cache, OCX_FIXTURE_PKG: pkg, OCX_FIXTURE_RESULT: result };
    const backup = join(root, "lib/node_modules/@bitkyc08/.ocx-backup-sync/opencodex");
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "package.json"), JSON.stringify({ version: "1.9.0" }));
    const update = tryAcquireUpdateSyncMutex(home, "update");
    if (update.kind !== "acquired") throw new Error("fixture update mutex unavailable");
    try {
      const blockedSync = spawnSync(node, [launcher, "sync", "--local-only"], { cwd: root, env, encoding: "utf8", timeout: 30000 });
      expect({ status: blockedSync.status, stderr: blockedSync.stderr }).toMatchObject({ status: 7, stderr: expect.stringContaining("update-in-flight") });
      expect(existsSync(join(backup, "package.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.0.0");
    } finally { update.release(); }
    const run = (planToken: string, deadline?: number, rollback = false) => {
      const encoded = encodeOrchestratedExpect({ home, cliRoot: pkg, servingRoot: null, runtimePid: null, planToken });
      const args = [join(pkg, "bin/ocx.mjs"), "update", "--version", "2.1.0", "--orchestrated-expect", encoded, "--orchestrated-result", result];
      if (deadline) args.push("--not-after", String(deadline));
      rmSync(result, { force: true });
      const { capability } = issueOrchestratedResultCapability(result);
      return spawnSync(node, args, { cwd: root, env: { ...env, OCX_UPDATE_RESULT_CAPABILITY: capability, OCX_FIXTURE_ROLLBACK: rollback ? "1" : "0" }, encoding: "utf8", timeout: 30000 });
    };
    const encoded = encodeOrchestratedExpect({ home, cliRoot: pkg, servingRoot: null, runtimePid: null, planToken: token });
    const descendant = join(root, "installer-descendant");
    const { capability } = issueOrchestratedResultCapability(result);
    const timeout = spawnSync(node, [launcher, "update", "--version", "2.1.0", "--orchestrated-expect", encoded, "--orchestrated-result", result], {
      cwd: root, env: { ...env, OCX_UPDATE_RESULT_CAPABILITY: capability, OCX_FIXTURE_TIMEOUT: "1", OCX_FIXTURE_DESCENDANT: descendant }, encoding: "utf8", timeout: 30000,
    });
    expect({ status: timeout.status, stderr: timeout.stderr }).toMatchObject({ status: 1 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ phase: "failed", terminationConfirmed: false });
    expect(() => process.kill(Number(readFileSync(descendant, "utf8")), 0)).toThrow();
    expect(isUpdateInFlight(home)).toBe(true);
    expectSyncAdmission(pkg, root, env, false);
    expireFixtureFence(home);
    rmSync(result); rmSync(log);
    const unauthorized = spawnSync(node, [join(pkg, "bin/ocx.mjs"), "update", "--version", "2.1.0", "--orchestrated-expect", encoded, "--orchestrated-result", result], {
      cwd: root, env: { ...env, OCX_UPDATE_ORCHESTRATED_CHILD: "0" }, encoding: "utf8", timeout: 30000,
    });
    expect(unauthorized.status).toBe(64); expect(existsSync(result)).toBe(false); expect(existsSync(log)).toBe(false);
    const holder = tryAcquireUpdateSyncMutex(home, "sync");
    expect(holder.kind).toBe("acquired");
    try { expect(run(token).status).toBe(10); expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ phase: "refused", error: "sync-in-progress" }); }
    finally { if (holder.kind === "acquired") holder.release(); }
    const deadline = run(token, 1);
    expect({ status: deadline.status, stderr: deadline.stderr }).toMatchObject({ status: 10 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ phase: "refused", error: "deadline-passed" });
    const changed = run("a".repeat(43));
    expect({ status: changed.status, stderr: changed.stderr }).toMatchObject({ status: 10 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ phase: "refused", error: "plan-changed" });
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.0.0");
    expect(readFileSync(log, "utf8")).not.toContain('"install"');
    const rolledBack = run(token, undefined, true);
    expect({ status: rolledBack.status, stdout: rolledBack.stdout, stderr: rolledBack.stderr }).toMatchObject({ status: 1 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "failed", rollbackPerformed: true });
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.0.0");
    expireFixtureFence(home);
    const updated = run(token);
    expect({ status: updated.status, stdout: updated.stdout, stderr: updated.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "installed", activeRoot: pkg });
    expect(JSON.parse(readFileSync(join(home, "update-orchestrated.json"), "utf8")).fenceUntil).toBeUndefined();
    expect(isUpdateInFlight(home)).toBe(false);
    expectSyncAdmission(pkg, root, env, true);
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.1.0");
    expect(readFileSync(log, "utf8")).toContain("@bitkyc08/opencodex@2.1.0");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    // The child takes the result capability out of its environment before any probe or installer runs.
    expect(calls.length).toBeGreaterThan(0); expect(calls.filter(call => call.capability !== null)).toEqual([]);
    expect(calls.find(call => call.args[0] === "view").outcome.phase).toBe("preflight");
    expect(calls.some(call => call.args[0] === "view" && call.args.includes("dist.integrity") && call.args.includes("@bitkyc08/opencodex@2.1.0"))).toBe(true);
    expect(calls.find(call => call.args[0] === "install").outcome.phase).toBe("mutating");
    expect(calls.find(call => call.args[0] === "install").args).toContain("@bitkyc08/opencodex@2.1.0");
    const installs = calls.filter(call => call.args[0] === "install").length;
    expireFixtureFence(home);
    const current = run(token);
    expect({ status: current.status, stderr: current.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "preflight" });
    expect(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(call => call.args[0] === "install")).toHaveLength(installs);
    const restored = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")); restored.version = "2.0.0";
    writeFileSync(join(pkg, "package.json"), JSON.stringify(restored));
    const parentArgs = [join(pkg, "bin/ocx.mjs"), "update", "--yes", "--json", "--tag", "preview"];
    const parentEnv = { ...env, OCX_UPDATE_ORCHESTRATED_CHILD: "0" };
    const parent = (extraEnv = {}) => spawnSync(node, parentArgs, { cwd: root, env: { ...parentEnv, ...extraEnv }, encoding: "utf8", timeout: 30000 });
    const parentTimeout = parent({ OCX_FIXTURE_TIMEOUT: "1", OCX_FIXTURE_DESCENDANT: descendant });
    expect({ status: parentTimeout.status, stderr: parentTimeout.stderr }).toMatchObject({ status: 12 });
    expect(JSON.parse(parentTimeout.stdout)).toMatchObject({ applied: false, error: "installer-termination-unconfirmed" });
    expect(isUpdateInFlight(home)).toBe(true);
    expireFixtureFence(home);
    const sync = tryAcquireUpdateSyncMutex(home, "sync");
    expect(sync.kind).toBe("acquired");
    try { const blocked = parent(); expect(blocked.status).toBe(10); expect(JSON.parse(blocked.stdout).error).toBe("sync-in-progress"); }
    finally { if (sync.kind === "acquired") sync.release(); }
    const parentRollback = parent({ OCX_FIXTURE_ROLLBACK: "1" });
    expect({ status: parentRollback.status, stderr: parentRollback.stderr }).toMatchObject({ status: 11 });
    expect(JSON.parse(parentRollback.stdout)).toMatchObject({ rolledBack: true, applied: false });
    expireFixtureFence(home);
    const parentApplied = parent({ OCX_FIXTURE_MOVED: "1" });
    expect({ status: parentApplied.status, stderr: parentApplied.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(parentApplied.stdout)).toMatchObject({ applied: true, toVersion: "2.1.0" });
    expect(readFileSync(log, "utf8")).toContain("@bitkyc08/opencodex@2.1.0");
    expect(readFileSync(log, "utf8")).toContain("@bitkyc08/opencodex@preview");
    expect(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(call => call.capability !== null)).toEqual([]);
    expireFixtureFence(home);
    const resetVersion = () => {
      const m = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")); m.version = "2.0.0";
      writeFileSync(join(pkg, "package.json"), JSON.stringify(m));
    };
    resetVersion();
    const overrun = spawnSync(node, parentArgs, { cwd: root, env: { ...parentEnv, OCX_FIXTURE_OVERRUN: "1" },
      encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
    expect(overrun.status).toBe(12);
    expect(JSON.parse(overrun.stdout).error).toBe("overrun");
    const marker = JSON.parse(readFileSync(join(home, "update-orchestrated.json"), "utf8"));
    expect(marker.phase).toBe("mutating");
    expect(() => process.kill(marker.pid, 0)).not.toThrow();
    expect(isUpdateInFlight(home)).toBe(true);
    await new Promise<void>((resolveDone, rejectDone) => {
      const timer = setTimeout(() => { observer.close(); rejectDone(new Error("fixture child did not finish")); }, 30000);
      const check = () => {
        const current = JSON.parse(readFileSync(join(home, "update-orchestrated.json"), "utf8"));
        if (["installed", "failed", "refused"].includes(current.phase) && inspectUpdateSyncMutex(home) === "free") {
          clearTimeout(timer); observer.close(); resolveDone();
        }
      };
      const observer = watch(home, check);
      check();
    });
    expireFixtureFence(home);
    resetVersion();
    const missing = parent({ OCX_FIXTURE_EXIT_EFFECT: "missing" });
    expect({ status: missing.status, stderr: missing.stderr }).toMatchObject({ status: 12 });
    expect(JSON.parse(missing.stdout).error).toBe("outcome-unverified");
    expireFixtureFence(home);
    resetVersion();
    const damaged = parent({ OCX_FIXTURE_EXIT_EFFECT: "damage" });
    expect({ status: damaged.status, stderr: damaged.stderr }).toMatchObject({ status: 12 });
    expect(JSON.parse(damaged.stdout)).toMatchObject({ error: "install-unverified", applied: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90000);

test.skipIf(process.platform === "win32")("pnpm child reports unchanged active tree without rollback and installs the pinned version", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-pnpm-child-")));
  const home = join(root, "home"), group = join(root, "global/v11"), bin = join(root, "bin");
  const pkg = join(group, "node_modules/@bitkyc08/opencodex"), result = join(root, "result.json"), log = join(root, "pnpm.log");
  mkdirSync(home); mkdirSync(bin); mkdirSync(pkg, { recursive: true });
  try {
    cpSync(repoPath("src"), join(pkg, "src"), { recursive: true }); cpSync(repoPath("bin"), join(pkg, "bin"), { recursive: true });
    const manifest = JSON.parse(readFileSync(repoPath("package.json"), "utf8")); manifest.version = "2.0.0";
    writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest)); symlinkSync(repoPath("node_modules"), join(pkg, "node_modules"));
    writeFileSync(join(group, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 1 }));
    const executable = Bun.which("node"); if (!executable) throw new Error("Node required");
    const node = spawnSync(executable, ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
    if (!node || !node.startsWith("/")) throw new Error("Node executable is not an absolute path");
    for (const name of ["ocx", "opencodex"]) { writeFileSync(join(bin, name), `#!/bin/sh\nexec '${node}' '${pkg}/bin/ocx.mjs' "$@"\n`); chmodSync(join(bin, name), 0o755); }
    writeFileSync(join(bin, "pnpm"), `#!${node}\nconst fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),e=process.env;\nfs.appendFileSync(e.OCX_FIXTURE_LOG,JSON.stringify({args:a,outcome:JSON.parse(fs.readFileSync(e.OCX_FIXTURE_RESULT)),mutex:fs.existsSync(p.join(e.OPENCODEX_HOME,'sync-update.mutation.lock'))})+'\\n');\nconst m=JSON.parse(fs.readFileSync(p.join(e.OCX_FIXTURE_PKG,'package.json')));\nif(a[0]==='list') console.log(JSON.stringify([{path:e.OCX_FIXTURE_GROUP,dependencies:{'@bitkyc08/opencodex':{version:m.version,path:e.OCX_FIXTURE_PKG}}}]));\nelse if(a[0]==='root') console.log(e.OCX_FIXTURE_GROUP+'/node_modules');\nelse if(a[0]==='config') console.log(a[2]==='global-dir'?p.dirname(e.OCX_FIXTURE_GROUP):e.OCX_FIXTURE_BIN);\nelse if(a[0]==='view') console.log(a.includes('dist.integrity')?'sha512-YWJj':'2.1.0');\nelse if(a[0]==='add'){if(e.OCX_FIXTURE_FAIL==='1')process.exit(1);m.version='2.1.0';fs.writeFileSync(p.join(e.OCX_FIXTURE_PKG,'package.json'),JSON.stringify(m));}\nelse process.exit(90);\n`); chmodSync(join(bin, "pnpm"), 0o755);
    const token = createUpdatePlanToken({ currentVersion: "2.0.0", targetVersion: "2.1.0", installer: "pnpm", cliRoot: pkg, servingRoot: null, runtimeOwner: "none", runtime: null });
    const encoded = encodeOrchestratedExpect({ home, cliRoot: pkg, servingRoot: null, runtimePid: null, planToken: token });
    const args = [join(pkg, "bin/ocx.mjs"), "update", "--version", "2.1.0", "--orchestrated-expect", encoded, "--orchestrated-result", result];
    const env = { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: join(root, "codex"),
      OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_UPDATE_ORCHESTRATED_CHILD: "1", OPENCODEX_BUN_PATH: process.execPath,
      PATH: bin, OCX_FIXTURE_LOG: log, OCX_FIXTURE_PKG: pkg, OCX_FIXTURE_GROUP: group, OCX_FIXTURE_BIN: bin, OCX_FIXTURE_RESULT: result };
    const firstCapability = issueOrchestratedResultCapability(result).capability;
    const failed = spawnSync(node, args, { cwd: root, env: { ...env, OCX_UPDATE_RESULT_CAPABILITY: firstCapability, OCX_FIXTURE_FAIL: "1" }, encoding: "utf8", timeout: 30000 });
    expect({ status: failed.status, stdout: failed.stdout, stderr: failed.stderr }).toMatchObject({ status: 1 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "failed", rollbackPerformed: false });
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.0.0");
    expireFixtureFence(home);
    rmSync(result, { force: true });
    const nextCapability = issueOrchestratedResultCapability(result).capability;
    const updated = spawnSync(node, args, { cwd: root, env: { ...env, OCX_UPDATE_RESULT_CAPABILITY: nextCapability }, encoding: "utf8", timeout: 30000 });
    expect({ status: updated.status, stdout: updated.stdout, stderr: updated.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "installed", activeRoot: pkg });
    expect(JSON.parse(readFileSync(join(home, "update-orchestrated.json"), "utf8")).fenceUntil).toBeUndefined();
    expect(isUpdateInFlight(home)).toBe(false);
    expectSyncAdmission(pkg, root, env, true);
    expect(readFileSync(log, "utf8")).toContain("@bitkyc08/opencodex@2.1.0");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls.find(call => call.args[0] === "list").outcome.phase).toBe("preflight");
    expect(calls.find(call => call.args[0] === "add")).toMatchObject({ outcome: { phase: "mutating" }, mutex: true });
    expect(calls.some(call => call.args[0] === "view" && call.args.includes("dist.integrity") && call.args.includes("@bitkyc08/opencodex@2.1.0"))).toBe(true);
    expect(calls.find(call => call.args[0] === "add").args).toContain("@bitkyc08/opencodex@2.1.0");
    expireFixtureFence(home);
    const restored = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")); restored.version = "2.0.0";
    writeFileSync(join(pkg, "package.json"), JSON.stringify(restored));
    const parentArgs = [join(pkg, "bin/ocx.mjs"), "update", "--yes", "--json"];
    const parentEnv = { ...env, OCX_UPDATE_ORCHESTRATED_CHILD: "0" };
    const parent = (extraEnv = {}) => spawnSync(node, parentArgs, { cwd: root, env: { ...parentEnv, ...extraEnv }, encoding: "utf8", timeout: 30000 });
    const unchanged = parent({ OCX_FIXTURE_FAIL: "1" });
    expect({ status: unchanged.status, stderr: unchanged.stderr }).toMatchObject({ status: 11 });
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ rolledBack: false, applied: false });
    expireFixtureFence(home);
    const parentApplied = parent();
    expect({ status: parentApplied.status, stderr: parentApplied.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(parentApplied.stdout)).toMatchObject({ applied: true, toVersion: "2.1.0" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90000);

test.skipIf(process.platform === "win32")("identity probe is passive through both Node and Bun entrypoints", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-identity-probe-"));
  const home = join(root, "home"), pkg = join(root, "node_modules/@bitkyc08/opencodex");
  mkdirSync(home); mkdirSync(pkg, { recursive: true });
  try {
    cpSync(repoPath("src"), join(pkg, "src"), { recursive: true });
    cpSync(repoPath("bin"), join(pkg, "bin"), { recursive: true });
    cpSync(repoPath("package.json"), join(pkg, "package.json"));
    symlinkSync(repoPath("node_modules"), join(pkg, "node_modules"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 1 }));
    const backup = join(root, "node_modules/@bitkyc08/.ocx-backup-fixture/opencodex");
    mkdirSync(backup, { recursive: true }); writeFileSync(join(backup, "keep"), "backup");
    mkdirSync(join(root, ".opencodex-desktop"));
    writeFileSync(join(root, ".opencodex-desktop/cli.json"), "malformed desktop record");
    const executable = Bun.which("node"); if (!executable) throw new Error("Node required");
    const node = spawnSync(executable, ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
    const env = { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: join(root, "codex"),
      OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OPENCODEX_BUN_PATH: process.execPath,
      OPENCODEX_CODEX_SHIM_AUTO_RESTORE: "1", PATH: root };
    for (const [bin, entry] of [[node, join(pkg, "bin/ocx.mjs")], [process.execPath, join(pkg, "src/cli/index.ts")]]) {
      const result = spawnSync(bin!, [entry!, "__update-orchestrated-identity"], { cwd: root, env, encoding: "utf8", timeout: 15000 });
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: "absent", cliRoot: realpathSync.native(pkg) });
    }
    expect(readdirSync(home)).toEqual(["config.json"]);
    expect(readFileSync(join(backup, "keep"), "utf8")).toBe("backup");
    const missing = join(root, "missing/node_modules/@bitkyc08/opencodex");
    mkdirSync(join(missing, "bin"), { recursive: true }); mkdirSync(join(missing, "node_modules/bun"), { recursive: true });
    cpSync(repoPath("bin/ocx.mjs"), join(missing, "bin/ocx.mjs")); symlinkSync(repoPath("src"), join(missing, "src"));
    writeFileSync(join(missing, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: "2.0.0" }));
    writeFileSync(join(missing, "node_modules/bun/package.json"), JSON.stringify({ name: "bun", version: "1.0.0" }));
    writeFileSync(join(missing, "node_modules/bun/install.js"), `require('node:fs').writeFileSync(${JSON.stringify(join(root, "bun-installed"))},'bad')`);
    const noBun = spawnSync(node, [join(missing, "bin/ocx.mjs"), "__update-orchestrated-identity"], {
      cwd: root, env: { ...env, OPENCODEX_BUN_PATH: "" }, encoding: "utf8", timeout: 15000,
    });
    expect(noBun.status).not.toBe(0);
    expect(existsSync(join(root, "bun-installed"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40000);

test.skipIf(process.platform === "win32")("authorized npm launcher child writes a preflight outcome before package checks", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-node-child-")));
  const home = join(root, "home"), pkg = join(root, "node_modules/@bitkyc08/opencodex");
  const result = join(root, "result.json");
  try {
    mkdirSync(home); mkdirSync(join(pkg, "bin"), { recursive: true });
    cpSync(repoPath("bin/ocx.mjs"), join(pkg, "bin/ocx.mjs"));
    symlinkSync(repoPath("src"), join(pkg, "src"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: "2.0.0", type: "module" }));
    const node = Bun.spawnSync(["node", "-p", "process.execPath"], { stdout: "pipe" }).stdout.toString().trim();
    const expected = encodeOrchestratedExpect({ home, cliRoot: pkg, servingRoot: null, runtimePid: null, planToken: "a".repeat(43) });
    const { capability } = issueOrchestratedResultCapability(result);
    const child = spawnSync(node, [join(pkg, "bin/ocx.mjs"), "update", "--version", "2.1.0", "--orchestrated-expect", expected, "--orchestrated-result", result], {
      cwd: root, encoding: "utf8", timeout: 30000,
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: join(root, "codex"),
        OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_UPDATE_ORCHESTRATED_CHILD: "1", OCX_UPDATE_RESULT_CAPABILITY: capability, PATH: root },
    });
    expect(child.status).not.toBe(64);
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({ phase: "preflight" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 35000);

test("authorized child reaches Bun update preflight while internal flags without authorization are rejected", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-child-entry-")));
  const home = join(root, "home"), codex = join(root, "codex"), result = join(root, "result.json");
  mkdirSync(home); mkdirSync(codex); assertNotRealHomeUnderTest(home);
  const expectValue = encodeOrchestratedExpect({ home, cliRoot: repoPath(), servingRoot: null, runtimePid: null, planToken: "a".repeat(43) });
  const args = ["update", "--version", "99.0.0", "--orchestrated-expect", expectValue, "--orchestrated-result", result];
  const run = async (authorized: boolean, launcher: "bun" | "node" = "bun") => {
    const capability = authorized ? issueOrchestratedResultCapability(result).capability : undefined;
    const entry = launcher === "bun" ? [process.execPath, repoPath("src/cli/index.ts")] : [Bun.which("node")!, repoPath("bin/ocx.mjs")];
    const proc = Bun.spawn([...entry, ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
        OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(),
        OCX_UPDATE_ORCHESTRATED_CHILD: authorized ? "1" : "0", OCX_UPDATE_RESULT_CAPABILITY: capability } });
    return { stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text(), code: await proc.exited };
  };
  try {
    const rejected = await run(false);
    expect(rejected.code).toBe(64); expect(JSON.parse(rejected.stdout)).toEqual({ error: "usage" }); expect(existsSync(result)).toBe(false);
    const child = await run(true);
    expect(child.code).toBe(1);
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "preflight" });
    // Through the Node launcher, the source checkout hands the same child to the Bun CLI with its capability.
    rmSync(result);
    await run(true, "node");
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "preflight" });
    expect(JSON.parse(readFileSync(join(home, "update-orchestrated.json"), "utf8")).phase).toBe("failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test.skipIf(process.platform === "win32")("Bun-global apply runs the real child with the plan's exact target", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-bun-global-")));
  const home = join(root, "home"), ocxHome = join(home, ".opencodex"), path = join(root, "path");
  const pkg = join(home, ".bun/install/global/node_modules/@bitkyc08/opencodex"), log = join(root, "commands");
  mkdirSync(pkg, { recursive: true }); mkdirSync(ocxHome, { recursive: true }); mkdirSync(path);
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({ port: 1, hostname: "127.0.0.1" }));
  cpSync(repoPath("src"), join(pkg, "src"), { recursive: true });
  cpSync(repoPath("bin"), join(pkg, "bin"), { recursive: true });
  const manifest = JSON.parse(readFileSync(repoPath("package.json"), "utf8")); manifest.version = "2.0.0";
  writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
  symlinkSync(repoPath("node_modules"), join(pkg, "node_modules"));
  writeFileSync(join(path, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OCX_FIXTURE_LOG"\nprintf 'CAP=%s\\n' "\${OCX_UPDATE_RESULT_CAPABILITY:-none}" >> "$OCX_FIXTURE_LOG"\ncase "$*" in *dist.integrity*) printf 'sha512-YWJj\\n';; *) if [ -e "$OCX_FIXTURE_PKG/tag-queried" ]; then printf '2.2.0\\n'; else : > "$OCX_FIXTURE_PKG/tag-queried"; printf '2.1.0\\n'; fi;; esac\n`);
  chmodSync(join(path, "npm"), 0o755);
  writeFileSync(join(path, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OCX_FIXTURE_LOG"\nprintf 'CAP=%s\\n' "\${OCX_UPDATE_RESULT_CAPABILITY:-none}" >> "$OCX_FIXTURE_LOG"\nexec '${process.execPath}' -e 'const fs=require("node:fs"),root=process.env.OCX_FIXTURE_PKG;fs.writeFileSync(root+"/installer-ready","");const end=Date.now()+10000;const t=setInterval(()=>{if(!fs.existsSync(root+"/installer-release") && Date.now()<end)return;clearInterval(t);const p=root+"/package.json",m=JSON.parse(fs.readFileSync(p,"utf8"));m.version="2.1.0";fs.writeFileSync(p,JSON.stringify(m));},10);'\n`);
  chmodSync(join(path, "bun"), 0o755);
  const proc = Bun.spawn([process.execPath, join(pkg, "src/cli/index.ts"), "update", "--yes", "--json", "--tag", "preview"], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome,
      CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: `${path}:/usr/bin:/bin`,
      OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_FIXTURE_LOG: log, OCX_FIXTURE_PKG: pkg },
  });
  try {
    const ready = join(pkg, "installer-ready"), release = join(pkg, "installer-release"), deadline = Date.now() + 15000;
    while (!existsSync(ready) && Date.now() < deadline && proc.exitCode === null) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    proc.kill("SIGTERM");
    await Bun.sleep(150);
    expect(tryAcquireUpdateSyncMutex(ocxHome, "sync")).toMatchObject({ kind: "busy", holder: "update" });
    expect(isUpdateInFlight(ocxHome)).toBe(true);
    writeFileSync(release, "release");
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr, stdout }).toMatchObject({ code: 0 });
    expect(JSON.parse(stdout)).toMatchObject({ schema: "ocx.update.result/1", applied: true, healthy: true, toVersion: "2.1.0" });
    expect(JSON.parse(readFileSync(join(ocxHome, "update-orchestrated.json"), "utf8")).fenceUntil).toBeUndefined();
    expect(isUpdateInFlight(ocxHome)).toBe(false);
    expectSyncAdmission(pkg, root, { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome,
      CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: `${path}:/usr/bin:/bin`,
      OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir() }, true);
    expect(readFileSync(log, "utf8")).toContain("add -g @bitkyc08/opencodex@2.1.0");
    expect(readFileSync(log, "utf8").match(/@preview version/g)).toHaveLength(1);
    const noCapability = () => { const seen = readFileSync(log, "utf8").split("\n").filter(line => line.startsWith("CAP="));
      expect(seen.length).toBeGreaterThan(0); expect(seen.filter(line => line !== "CAP=none")).toEqual([]); };
    noCapability();
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.1.0");
    expireFixtureFence(ocxHome);
    const reset = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")); reset.version = "2.0.0";
    writeFileSync(join(pkg, "package.json"), JSON.stringify(reset));
    rmSync(join(pkg, "tag-queried"));
    const updateSource = join(pkg, "src/update/index.ts");
    const source = readFileSync(updateSource, "utf8");
    const point = '  if (r.status === 0) {\n    if (homePolicy.packageOnly)';
    if (!source.includes(point)) throw new Error("recovery injection point missing");
    writeFileSync(updateSource, source.replace(point, '  if (r.status === 0) {\n    throw new Error("fixture recovery failure");\n    if (homePolicy.packageOnly)'));
    const failed = Bun.spawn([process.execPath, join(pkg, "src/cli/index.ts"), "update", "--yes", "--json"], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome,
        CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: `${path}:/usr/bin:/bin`,
        OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_FIXTURE_LOG: log, OCX_FIXTURE_PKG: pkg },
    });
    const [failedOut, failedErr, failedCode] = await Promise.all([new Response(failed.stdout).text(), new Response(failed.stderr).text(), failed.exited]);
    expect({ code: failedCode, stderr: failedErr }).toMatchObject({ code: 12 });
    expect(JSON.parse(failedOut)).toMatchObject({ applied: true, healthy: false, error: "runtime-unhealthy" });
    expect(JSON.parse(readFileSync(join(ocxHome, "update-orchestrated.json"), "utf8")).phase).toBe("installed");
    expireFixtureFence(ocxHome);
    writeFileSync(join(pkg, "package.json"), JSON.stringify(reset));
    const childResult = join(root, "result.json"), cliRoot = realpathSync.native(pkg), childHome = ocxHome;
    const planToken = createUpdatePlanToken({ currentVersion: "2.0.0", targetVersion: "2.1.0", installer: "bun", cliRoot,
      servingRoot: null, runtimeOwner: "none", runtime: null });
    const childExpect = encodeOrchestratedExpect({ home: childHome, cliRoot, servingRoot: null, runtimePid: null, planToken });
    const { capability } = issueOrchestratedResultCapability(childResult);
    const worker = Bun.spawn([process.execPath, join(pkg, "src/cli/index.ts"), "update", "--version", "2.1.0",
      "--orchestrated-expect", childExpect, "--orchestrated-result", childResult], {
      cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome,
        CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: `${path}:/usr/bin:/bin`,
        OCX_UPDATE_ORCHESTRATED_CHILD: "1", OCX_UPDATE_RESULT_CAPABILITY: capability, OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(),
        OCX_FIXTURE_LOG: log, OCX_FIXTURE_PKG: pkg },
    });
    const [, workerError, workerCode] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]);
    expect({ code: workerCode, stderr: workerError }).toMatchObject({ code: 1 });
    expect(JSON.parse(readFileSync(childResult, "utf8"))).toMatchObject({ phase: "installed", activeRoot: cliRoot, recoveryFailed: true, error: "runtime-unhealthy" });
    noCapability();
  } finally {
    if (proc.exitCode === null) {
      writeFileSync(join(pkg, "installer-release"), "release");
      const ended = await Promise.race([proc.exited.then(() => true), Bun.sleep(15000).then(() => false)]);
      if (!ended) throw new Error(`test worker did not exit; retained ${root}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test("a source checkout update plan emits one JSON refusal in a temporary home", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-update-entry-"));
  const home = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(home); mkdirSync(codex); assertNotRealHomeUnderTest(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: 1 }));
  const proc = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "update", "--plan", "--json"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
      CODEX_SQLITE_HOME: codex, CLAUDE_CONFIG_DIR: join(root, "claude"), OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_TEST_HOME_GUARD: "1" },
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ schema: "ocx.update.plan/1", installer: "source", canApply: false, reason: "source-checkout", updateInFlight: false });
    expect(stderr).not.toContain("shim repair");
    writeFileSync(join(home, "update-orchestrated.json"), JSON.stringify({ pid: process.pid, phase: "mutating", startedAt: Date.now() }));
    const active = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "update", "--plan", "--json"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
        CODEX_SQLITE_HOME: codex, CLAUDE_CONFIG_DIR: join(root, "claude"), OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_TEST_HOME_GUARD: "1" },
    });
    const [activeOutput, activeError, activeCode] = await Promise.all([new Response(active.stdout).text(), new Response(active.stderr).text(), active.exited]);
    expect(activeCode).toBe(0);
    expect(activeError).not.toContain("shim repair");
    expect(JSON.parse(activeOutput).updateInFlight).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test.skipIf(process.platform === "win32")("npm-shaped launcher plans without repair or Desktop handoff, including missing Bun", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-plan-launcher-"));
  const home = join(root, "home"), ocxHome = join(home, ".opencodex"), path = join(root, "path");
  const pkg = join(root, "lib", "node_modules", "@bitkyc08", "opencodex");
  const backup = join(root, "lib", "node_modules", "@bitkyc08", ".ocx-backup-123", "opencodex");
  const npmLog = join(root, "npm-log");
  const envLog = join(root, "npm-env");
  mkdirSync(pkg, { recursive: true }); mkdirSync(ocxHome, { recursive: true }); mkdirSync(path); mkdirSync(backup, { recursive: true });
  mkdirSync(join(home, ".opencodex-desktop"), { recursive: true });
  writeFileSync(join(home, ".opencodex-desktop", "cli.json"), JSON.stringify({ version: 1, enabled: true, bundle: { platform: process.platform, kind: process.platform === "darwin" ? "macos-app" : "linux-deb", cliExecutable: join(root, "no-desktop") } }));
  writeFileSync(join(backup, "keep"), "backup");
  mkdirSync(join(ocxHome, "codex-shim.json"));
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({ port: 1 }));
  cpSync(repoPath("src"), join(pkg, "src"), { recursive: true });
  cpSync(repoPath("bin"), join(pkg, "bin"), { recursive: true });
  cpSync(repoPath("package.json"), join(pkg, "package.json"));
  mkdirSync(join(pkg, "node_modules"));
  for (const name of readdirSync(repoPath("node_modules"))) {
    if (name !== "bun") symlinkSync(repoPath("node_modules", name), join(pkg, "node_modules", name));
  }
  symlinkSync(repoPath("node_modules", "bun"), join(pkg, "node_modules", "bun"));
  writeFileSync(join(path, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${npmLog}'\nprintf '%s|%s|%s|%s|%s|%s\\n' "$npm_config_cache" "$npm_config_logs_dir" "$npm_config_logs_max" "$npm_config_update_notifier" "$pnpm_config_cache_dir" "$BUN_INSTALL_CACHE_DIR" >> '${envLog}'\n/bin/mkdir -p "$npm_config_cache"\n: > "$npm_config_cache/probe-write"\n[ "$1" = view ] || exit 1\nprintf '99.0.0\\n'\n`); chmodSync(join(path, "npm"), 0o755);
  const nodeCommand = Bun.which("node"); if (!nodeCommand) throw Error("Node required");
  const node = spawnSync(nodeCommand, ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
  if (!node) throw Error("Node executable could not be resolved");
  const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome, CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: path, npm_config_cache: join(home, "user-cache"), OPENCODEX_BUN_PATH: "", OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OPENCODEX_CODEX_SHIM_AUTO_RESTORE: "1" };
  const launch = async (args = ["--plan", "--json", "--version", "99.0.0"]) => {
    const child = Bun.spawn([node, join(pkg, "bin", "ocx.mjs"), "update", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    return { stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), code: await child.exited };
  };
  try {
    for (const [executable, entry] of [[node, join(pkg, "bin/ocx.mjs")], [process.execPath, join(pkg, "src/cli/index.ts")]]) {
      for (const args of [["--plan=true"], ["--plan=true", "--json=true"], ["--yes=1", "--json"], ["--json=false"]]) {
        const child = Bun.spawn([executable!, entry!, "update", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        expect({ args, code }).toEqual({ args, code: 64 });
        expect(JSON.parse(stdout)).toEqual({ error: "usage" });
        expect(existsSync(npmLog)).toBe(false);
        expect(readFileSync(join(backup, "keep"), "utf8")).toBe("backup");
        expect(existsSync(join(ocxHome, "update-orchestrated.json"))).toBe(false);
        expect(existsSync(join(ocxHome, "codex-shim.json"))).toBe(true);
      }
    }
    const first = await launch();
    const [cache, logs, logsMax, notifier, pnpmCache, bunCache] = readFileSync(envLog, "utf8").trim().split("|");
    expect(cache).toBeTruthy(); expect(cache!.startsWith(home)).toBe(false);
    expect(logs!.startsWith(cache!)).toBe(true); expect(logsMax).toBe("0"); expect(notifier).toBe("false");
    expect(pnpmCache!.startsWith(cache!)).toBe(true); expect(bunCache!.startsWith(cache!)).toBe(true);
    expect(existsSync(cache!)).toBe(false); expect(existsSync(join(home, "user-cache"))).toBe(false);
    expect({ code: first.code, stderr: first.stderr }).toMatchObject({ code: 0 });
    expect({ stderr: first.stderr, npmLog: existsSync(npmLog) ? readFileSync(npmLog, "utf8") : "missing" }).toMatchObject({ npmLog: expect.stringContaining("@bitkyc08/opencodex@99.0.0") });
    expect(first.stderr).not.toContain("auto-restore");
    expect(JSON.parse(first.stdout)).toMatchObject({ installer: "npm", targetVersion: "99.0.0", canApply: true });
    const mismatch = await launch(["--yes", "--json", "--version", "99.0.0", "--expect-plan", "a".repeat(43)]);
    expect(mismatch.code).toBe(10);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({ error: "plan-changed" });
    const deadline = await launch(["--yes", "--json", "--version", "99.0.0", "--not-after", "1"]);
    expect(deadline.code).toBe(10);
    expect(JSON.parse(deadline.stdout)).toMatchObject({ error: "deadline-passed" });
    const apply = await launch(["--yes", "--json", "--version", "99.0.0"]);
    expect(apply.stderr).toContain("opencodex v");
    expect(JSON.parse(apply.stdout).error).not.toBe("plan-unavailable");
    expect(readFileSync(npmLog, "utf8")).toContain("@bitkyc08/opencodex@99.0.0");
    const entry = join(pkg, "src/cli/index.ts"), originalEntry = readFileSync(entry, "utf8");
    for (const invalidPlan of ["console.log('not json')", "process.stdout.write('x'.repeat(65537))", "process.exit(1)"]) {
      writeFileSync(entry, invalidPlan);
      const invalid = await launch(["--yes", "--json", "--version", "99.0.0"]);
      expect(invalid.code).toBe(10);
      expect(JSON.parse(invalid.stdout)).toMatchObject({ error: "plan-unavailable", applied: false });
    }
    writeFileSync(entry, originalEntry);
    rmSync(join(pkg, "node_modules", "bun"));
    const missing = await launch();
    expect(missing.code).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ installer: "npm", reason: "plan-unavailable", canApply: false });
    const missingApply = await launch(["--yes", "--json", "--version", "99.0.0"]);
    expect(missingApply.code).toBe(10);
    expect(JSON.parse(missingApply.stdout)).toMatchObject({ error: "plan-unavailable", applied: false });
    const bunDir = join(pkg, "node_modules", "bun"), installed = join(root, "unexpected-bun-install");
    mkdirSync(bunDir); writeFileSync(join(bunDir, "package.json"), JSON.stringify({ name: "bun", version: "1.4.4" }));
    writeFileSync(join(bunDir, "install.js"), `require('node:fs').writeFileSync(${JSON.stringify(installed)},'unexpected')`);
    const sync = spawnSync(node, [join(pkg, "bin/ocx.mjs"), "sync", "--local-only"], { cwd: root, env: { ...env, OCX_NO_DESKTOP_HANDOFF: "1" }, encoding: "utf8", timeout: 30000 });
    expect({ status: sync.status, stderr: sync.stderr }).toMatchObject({ status: 1, stderr: expect.stringContaining("Bun is unavailable") });
    expect(existsSync(installed)).toBe(false);
    expect(readFileSync(join(backup, "keep"), "utf8")).toBe("backup");
    expect(missing.stderr).not.toContain("auto-restore");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("the Node launcher classifies orchestration before package-manager update and boot recovery", () => {
  const source = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
  const classification = source.indexOf("const orchestratedUpdate =");
  expect(classification).toBeGreaterThan(-1);
  expect(classification).toBeLessThan(source.indexOf('process.argv[2] === "update" && installMethod === "mise"'));
  expect(classification).toBeLessThan(source.indexOf('const probe = bootRestoreProbe('));
});

test("malformed and unsupported internal orchestration is rejected before legacy update", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-update-help-"));
  const home = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(home); mkdirSync(codex); assertNotRealHomeUnderTest(home);
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required to test the published launcher");
  try {
    for (const [executable, entry] of [[node, repoPath("bin/ocx.mjs")], [process.execPath, repoPath("src/cli/index.ts")]]) {
    for (const args of [["--plan", "--json", "--help"], ["--version", "99.0.0", "--orchestrated-result", join(root, "result.json")]]) {
    const proc = Bun.spawn([executable!, entry!, "update", ...args], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
        OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_TEST_HOME_GUARD: "1" },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(64);
    expect(JSON.parse(stdout)).toEqual({ error: "usage" });
    expect(stderr).toContain("Usage:");
    expect(existsSync(join(root, "result.json"))).toBe(false);
    }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
