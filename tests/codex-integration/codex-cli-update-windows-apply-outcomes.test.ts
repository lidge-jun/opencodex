import { windowsTempAncestryPreload } from "../helpers/windows-temp-ancestry";
import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { inspectCodexCliInstall } from "../../src/codex/cli-install-provenance";
import { holdWindowsCodexCliPlanToolchain, withWindowsCodexCliPlanToolchain } from "../../src/codex/cli-windows-plan-provenance";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { runCodexCliUpdateJobWork } from "../../src/codex/cli-update-job-execution";
import { createWindowsApplyFixtures, native, WINDOWS_APPLY_BUDGET_MS, WINDOWS_APPLY_CHILD_BUDGET_MS, mainRoot, backingRoot, nativePath, write } from "../helpers/codex-cli-windows-apply-fixture";

const { fixture, approved } = createWindowsApplyFixtures();

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
}, WINDOWS_APPLY_BUDGET_MS);

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
}, WINDOWS_APPLY_BUDGET_MS);

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
    `},${WINDOWS_APPLY_CHILD_BUDGET_MS});`,
  ].join("\n"));
  const child = await spawnTestChild([process.execPath, "test", "--preload", windowsTempAncestryPreload(f.root),
    "--no-env-file", "--no-install", "--timeout", String(WINDOWS_APPLY_CHILD_BUDGET_MS), entry],
    { cwd: repoRoot(), env: process.env, deadlineMs: WINDOWS_APPLY_CHILD_BUDGET_MS + 5000 });
  expect(child.reaped).toBe(true); expect(child.pipesClosed).toBe(true); expect(child.exitCode, child.stderr).toBe(0);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ stage: true,
    result: { outcome: "ambiguous", reason: "installer_state_unknown", leaseRetained: true } });
  // The child has exited: only now can the fixture's retained kernel handles be gone.
}, WINDOWS_APPLY_BUDGET_MS);

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
}, WINDOWS_APPLY_BUDGET_MS);

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
}, WINDOWS_APPLY_BUDGET_MS);
