import { windowsTempAncestryPreload } from "../helpers/windows-temp-ancestry";
import { expect } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { startWindowsCliChild } from "../../src/codex/windows-cli-child";
import { createCodexCliUpdateFence, cancelCodexCliUpdateFence, createWorkerCommitWindow, codexCliUpdateIsCancelled, allocateCodexCliUpdateGateOwner } from "../../src/codex/cli-update-selection-gate";
import { createWindowsApplyFixtures, native, WINDOWS_APPLY_BUDGET_MS, fixtureCleanupProven, type WorkerFixtureReply, artifacts, mainRoot, backingRoot, write } from "../helpers/codex-cli-windows-apply-fixture";

const { liveFixtureRoots, fixture, approved } = createWindowsApplyFixtures();

native.each([false, true])("a fresh Worker closes after offline Windows apply, ACL release failure=%s", async aclReleaseFailure => {
  let root: string | undefined, closed = false, errored = false, worker: Worker | undefined;
  let followupClean = !aclReleaseFailure;
  const requestId = crypto.randomUUID(), messages: WorkerFixtureReply[] = [];
  const cleanupErrors = aclReleaseFailure ? ["lease_release_unverified"] : [];
  try {
    const f = await fixture(undefined, created => { root = created; liveFixtureRoots.add(created); });
    const id = await approved(f);
    worker = new Worker(new URL("../helpers/windows-apply-worker.ts", import.meta.url),
      { type: "module", preload: windowsTempAncestryPreload(f.root) });
    const joined = new Promise<void>((resolve, reject) => {
      worker!.addEventListener("message", event => { messages.push(event.data); });
      worker!.addEventListener("error", () => { errored = true; reject(new Error("offline Worker failed")); }, { once: true });
      worker!.addEventListener("close", () => { closed = true; resolve(); }, { once: true });
    });
    const replied = new Promise<WorkerFixtureReply>(resolve => {
      worker!.addEventListener("message", event => {
        if (["result", "fixture-error"].includes(event.data?.type)) resolve(event.data);
      });
    });
    const gate = new SharedArrayBuffer(8), fence = createCodexCliUpdateFence();
    worker.postMessage({ requestId, planId: id, inspectionDeps: f.deps.inspectionDeps, target: f.target, gate, fence, aclReleaseFailure });
    // Assert the result before joining: the old bug keeps the Worker's handler alive.
    const reply = await Promise.race([replied, joined.then(() => { throw new Error("Worker closed without fixture result"); })]);
    expect(reply.result).toMatchObject({ outcome: "applied", reason: "verified_target", leaseRetained: false, cleanupErrors });
    await joined;
    expect(messages.filter(m => m.type === "native-start")).toHaveLength(1);
    expect(messages.filter(m => m.type === "fixture-error")).toHaveLength(0);
    const results = messages.filter(m => m.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toMatchObject({ outcome: "applied", reason: "verified_target", leaseRetained: false, cleanupErrors });
    expect(fixtureCleanupProven(messages, requestId, closed, errored, cleanupErrors)).toBe(true);
    expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    if (aclReleaseFailure) {
      const next = artifacts("1.2.0");
      const deps = { ...f.deps,
        resolveTarget: () => ({ kind: "resolved" as const, version: "1.2.0", integrity: next.set.main.integrity, artifacts: next.set }),
        fetchArtifact: async (artifact: typeof next.set.main) => artifact.installName === "@openai/codex" ? next.main : next.backing };
      const plan = await createCodexCliUpdatePlan(deps);
      expect(plan.applicable).toBe(true);
      const result = await applyCodexCliUpdate(plan.planId!, deps);
      followupClean = !result.leaseRetained && result.cleanupErrors.length === 0;
      expect(result).toMatchObject({ outcome: "applied", reason: "verified_target",
        installedVersion: "1.2.0", leaseRetained: false, cleanupErrors: [] });
      expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    }
  } finally {
    // A still-live native Worker keeps its exact fixture; never terminate to fake settlement.
    if (root && followupClean && fixtureCleanupProven(messages, requestId, closed, errored, cleanupErrors)) liveFixtureRoots.delete(root);
    // A failing regression must preserve its fixture without keeping the test host alive.
    if (!closed) worker?.unref();
  }
}, WINDOWS_APPLY_BUDGET_MS);

native("a replacement lock survives while the original offline apply Worker closes", async () => {
  let root: string | undefined, closed = false, errored = false, worker: Worker | undefined;
  const requestId = crypto.randomUUID(), messages: WorkerFixtureReply[] = [];
  try {
    const f = await fixture(undefined, created => { root = created; liveFixtureRoots.add(created); });
    const id = await approved(f);
    worker = new Worker(new URL("../helpers/windows-apply-worker.ts", import.meta.url),
      { type: "module", preload: windowsTempAncestryPreload(f.root) });
    const joined = new Promise<void>((resolve, reject) => {
      worker!.addEventListener("message", event => { messages.push(event.data); });
      worker!.addEventListener("error", () => { errored = true; reject(new Error("replacement fixture Worker failed")); }, { once: true });
      worker!.addEventListener("close", () => { closed = true; resolve(); }, { once: true });
    });
    const replied = new Promise<WorkerFixtureReply>(resolve => {
      worker!.addEventListener("message", event => {
        if (["result", "fixture-error"].includes(event.data?.type)) resolve(event.data);
      });
    });
    const gate = new SharedArrayBuffer(8), fence = createCodexCliUpdateFence();
    worker.postMessage({ requestId, planId: id, inspectionDeps: f.deps.inspectionDeps, target: f.target, gate, fence, replaceLock: true });
    const reply = await Promise.race([replied, joined.then(() => { throw new Error("Worker closed without fixture result"); })]);
    expect(reply.result).toMatchObject({ outcome: "applied", reason: "verified_target", leaseRetained: false, cleanupErrors: [] });
    await joined;
    expect(fixtureCleanupProven(messages, requestId, closed, errored)).toBe(true);
    expect(messages.filter(m => m.type === "native-start")).toHaveLength(1);
    expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
    expect(readFileSync(join(f.prefix, ".ocx-codex-cli-apply.lock", "owner.json"), "utf8")).toBe(requestId);
  } finally {
    if (root && fixtureCleanupProven(messages, requestId, closed, errored)) liveFixtureRoots.delete(root);
    if (!closed) worker?.unref();
  }
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows cancellation won inside final synchronous scan cannot create an installer", async () => {
  const f = await fixture(undefined, root => liveFixtureRoots.add(root)), id = await approved(f);
  const fence = createCodexCliUpdateFence(), gate = new SharedArrayBuffer(8);
  const gateOwner = allocateCodexCliUpdateGateOwner(gate);
  let scans = 0, starts = 0;
  const result = await applyCodexCliUpdate(id, { ...f.deps,
    isCancelled: codexCliUpdateIsCancelled(fence),
    commitWindow: createWorkerCommitWindow({ gate, fence, owner: gateOwner }),
    scanProcesses: () => {
      scans++;
      if (Atomics.load(new Int32Array(gate), 0) === gateOwner) expect(cancelCodexCliUpdateFence(fence)).toBe(true);
      return { kind: "observed", processes: [] };
    },
    startWindowsChild: invocation => { starts++; return startWindowsCliChild(invocation); },
  });
  if (!result.leaseRetained) liveFixtureRoots.delete(f.root);
  expect(scans).toBeGreaterThan(0);
  expect(result).toMatchObject({ outcome: "refused", reason: "cancelled", leaseRetained: false });
  expect(starts).toBe(0);
  expect(Atomics.load(new Int32Array(gate), 0)).toBe(0);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows apply runs real offline npm under owned Job, then verifies full target and version", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, f.deps);
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", reason: "verified_target",
    installerExitCode: 0, installedVersion: "1.1.0", leaseRetained: false, cleanupErrors: [] });
  expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows terminal no-op is not_applied even with nonzero installer exit", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => ({ terminal: true, exitCode: 17 }) });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "not_applied", leaseRetained: false, cleanupErrors: [] });
}, WINDOWS_APPLY_BUDGET_MS);

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
}, WINDOWS_APPLY_BUDGET_MS);

native("Windows complete readback outranks a nonzero installer exit", async () => {
  const f = await fixture(), id = await approved(f);
  const result = await applyCodexCliUpdate(id, { ...f.deps, install: async () => {
    for (const [path, bytes] of Object.entries(f.target.mainFiles)) write(join(f.prefix, mainRoot, path), bytes);
    for (const [path, bytes] of Object.entries(f.target.backingFiles)) write(join(f.prefix, backingRoot, path), bytes);
    return { terminal: true, exitCode: 17 };
  } });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "applied", installerExitCode: 17, cleanupErrors: [] });
}, WINDOWS_APPLY_BUDGET_MS);
