import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectCodexCliInstall, MAX_NATIVE_BACKING_BYTES } from "../../src/codex/cli-install-provenance";
import { applyCodexCliUpdate } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { withWindowsCodexCliPlanToolchain } from "../../src/codex/cli-windows-plan-provenance";
import { handleCodexCliUpdateRoutes } from "../../src/server/management/codex-cli-update-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { setWindowsInstallationFilesOpenedForTests, setWindowsInstallationFilesReadForTests } from "../../src/codex/windows-installation-files";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import { initializeNodeLauncherContext, NODE_LAUNCH_CONTEXT_ENV, NODE_LAUNCH_PROOF_PREFIX } from "../../src/cli/launcher-context";

const native = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
const roots: string[] = [];
afterEach(() => {
  initializeNodeLauncherContext(["bun", "cli"], {});
  setWindowsInstallationFilesOpenedForTests();
  setWindowsInstallationFilesReadForTests();
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});
// npm's independent cmd-shim fixture; no candidate is ever executed.
const cmd = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL',
  'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (',
  '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');
function fixture(separateNodeToolchain = false) {
  const root = mkdtempSync(join(tmpdir(), "ocx-windows-plan-")); roots.push(root);
  const prefix = join(root, "npm");
  const toolchainPrefix = separateNodeToolchain ? join(root, "nodejs") : prefix;
  const npmRoot = join(toolchainPrefix, "node_modules", "npm");
  const packageRoot = join(prefix, "node_modules", "@openai", "codex");
  // Closest Node lookup lane: there is no earlier ancestor package to shadow it.
  const backing = join(packageRoot, "bin", "node_modules", "@openai", "codex-win32-x64");
  const files = new Map<string, string | Buffer>([
    [join(prefix, "codex.cmd"), cmd],
    [join(prefix, "codex.opencodex-real.cmd"), "stale unselected shim backup"],
    [join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.2.3", bin: { codex: "bin/codex.js" } })],
    [join(packageRoot, "bin", "codex.js"), 'throw new Error("Codex must never execute");'],
    [join(backing, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.2.3-win32-x64" })],
    [join(backing, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"), "synthetic backing bytes"],
    [join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" } })],
    [join(npmRoot, "bin", "npm-cli.js"), 'throw new Error("npm must never execute");'],
  ]);
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
  files.set(join(toolchainPrefix, "node.exe"), pe);
  for (const [path, value] of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
  const deps = { env: { CODEX_CLI_PATH: join(prefix, "codex.cmd"), PATH: toolchainPrefix, PATHEXT: ".EXE;.CMD" },
    configDir: join(root, "absent-home"),
    selectionAttested: true, arch: "x64" as const, observeInstallContent: true };
  return { root, prefix, toolchainPrefix, npmRoot, packageRoot, backing, files, deps };
}

native("production Windows inspector binds selected npm shim, package, backing and toolchain with no candidate execution", async () => {
  const f = fixture(); const before = [...f.files].map(([path]) => readFileSync(path));
  const report = await inspectCodexCliInstall(f.deps);
  expect(report).toMatchObject({ managed: true, selectionAttested: true, provenance: "npm-global", reason: "managed_npm_global", packageVersion: "1.2.3" });
  expect(report.installContentDigest).toMatch(/^[a-f0-9]{64}$/);
  expect((await inspectCodexCliInstall(f.deps)).installContentDigest).toBe(report.installContentDigest);
  expect(JSON.stringify(report)).not.toContain(f.root);
  expect([...f.files].map(([path]) => readFileSync(path))).toEqual(before);
});

native("a bare Windows check honors the bounded content-observation opt-in", async () => {
  const f = fixture();
  // Production check context: selectionAttested without observeInstallContent.
  const deps = { env: f.deps.env, configDir: f.deps.configDir,
    selectionAttested: f.deps.selectionAttested, arch: f.deps.arch };
  const reads: { path: string; bytes: number }[] = [];
  setWindowsInstallationFilesReadForTests((path, bytes) => reads.push({ path, bytes }));
  const report = await inspectCodexCliInstall(deps);
  expect(report).toMatchObject({ managed: true, selectionAttested: true, provenance: "npm-global",
    reason: "managed_npm_global", packageVersion: "1.2.3", installContentDigest: null });
  expect(report.evidence).not.toContain("install_content_digest");
  // The same files stay opened, held and identity-bound; only the content streams stop.
  const bytesFor = (suffix: string) => reads.filter(read => read.path.endsWith(suffix)).map(read => read.bytes);
  expect(bytesFor("codex.exe")).toEqual([0]);
  for (const suffix of ["codex.js", "npm-cli.js"]) {
    const fileReads = bytesFor(suffix);
    expect(fileReads.length).toBeGreaterThan(0);
    expect(fileReads.every(bytes => bytes === 0)).toBe(true);
  }
  const nodeReads = bytesFor("node.exe");
  expect(nodeReads.length).toBeGreaterThan(0);
  expect(nodeReads.filter(bytes => bytes > 0)).toEqual([128]);
  // Only bounded ownership reads remain: nothing exceeds the 4 KiB Node header bound.
  expect(Math.max(0, ...reads.map(read => read.bytes))).toBeLessThanOrEqual(4096);
  expect(reads.some(read => read.path.endsWith("codex.cmd") && read.bytes > 0)).toBe(true);
});

native("a production plan is deterministic while Windows apply stays explicitly disabled", async () => {
  const f = fixture();
  const deps = { inspectionDeps: f.deps, resolveTarget: () => ({ kind: "resolved" as const, version: "1.2.4", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") }),
    scanProcesses: () => ({ kind: "observed" as const, processes: [] }) };
  const first = await createCodexCliUpdatePlan(deps);
  expect(first).toMatchObject({ managed: true, applicable: false, refusal: "windows_apply_disabled", installedVersion: "1.2.3", targetVersion: "1.2.4" });
  expect(first.planId).toMatch(/^[a-f0-9]{32}$/);
  expect((await createCodexCliUpdatePlan(deps)).planId).toBe(first.planId);
  writeFileSync(join(f.backing, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"), "changed backing bytes");
  expect((await createCodexCliUpdatePlan(deps)).planId).not.toBe(first.planId);
});

native("a Windows plan id with applicable=false cannot enter a management apply job", async () => {
  const f = fixture();
  const deps = { inspectionDeps: f.deps,
    resolveTarget: () => ({ kind: "resolved" as const, version: "1.2.4", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") }),
    scanProcesses: () => ({ kind: "observed" as const, processes: [] }) };
  const plan = await createCodexCliUpdatePlan(deps);
  expect(plan.planId).toMatch(/^[a-f0-9]{32}$/);
  expect(plan).toMatchObject({ applicable: false, refusal: "windows_apply_disabled" });

  const oldHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = f.deps.configDir;
  try {
    const request = new Request("http://localhost/api/codex/cli-update/apply", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "windows-nonapplicable-plan-001", planId: plan.planId, confirmed: true }) });
    const ctx: ManagementContext = { req: request, url: new URL(request.url),
      config: { port: 10100, providers: {} } as import("../../src/types").OcxConfig,
      deps: {}, version: "test", principal: "gui-session", trustedLoopbackIngress: true, guiSessionIssuance: null,
      convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
      syncClaudeAgentDefsBestEffort: async () => {} };
    const response = await handleCodexCliUpdateRoutes(ctx);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "unsupported_store" });

    let leaseAttempts = 0, installAttempts = 0;
    const apply = await applyCodexCliUpdate(plan.planId!, { platform: "win32", inspectionDeps: f.deps,
      acquireLease: () => { leaseAttempts += 1; return null; },
      install: async () => { installAttempts += 1; return { terminal: true, exitCode: 0 }; } });
    expect(apply).toMatchObject({ outcome: "refused", reason: "windows_apply_disabled" });
    expect(leaseAttempts).toBe(0);
    expect(installAttempts).toBe(0);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  }
});

native("a published-size Windows npm backing binds; one past the shared finite limit refuses", async () => {
  const f = fixture();
  const binary = join(f.backing, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  // An NTFS sparse file has the installed 0.153.4-win32-x64 backing's logical
  // size without copying its bytes or allocating a dense 295 MB fixture.
  writeFileSync(binary, "");
  expect(process.env.SystemRoot).toBeDefined();
  const sparse = spawnSync(join(process.env.SystemRoot!, "System32", "fsutil.exe"), ["sparse", "setflag", binary],
    { windowsHide: true, encoding: "utf8", timeout: 5_000 });
  expect(sparse.error).toBeUndefined(); expect(sparse.status).toBe(0);
  truncateSync(binary, 295_408_944);
  const report = await inspectCodexCliInstall(f.deps);
  expect(report.managed).toBe(true); expect(report.installContentDigest).toMatch(/^[a-f0-9]{64}$/);
  truncateSync(binary, MAX_NATIVE_BACKING_BYTES + 1);
  expect((await inspectCodexCliInstall(f.deps)).managed).toBe(false);
}, 30_000);

native("unattested, mismatched selection, app/Store/version-manager and unverified launchers remain unmanaged", async () => {
  const f = fixture();
  for (const deps of [ { ...f.deps, selectionAttested: false }, { ...f.deps, selectedCommand: join(f.root, "other.cmd") },
    ...["WindowsApps", "OpenAI/Codex/bin/app", ".nvm", "standalone"].map(dir => ({ ...f.deps,
      env: { ...f.deps.env, CODEX_CLI_PATH: join(f.root, dir, "codex.exe") } })),
  ]) expect((await inspectCodexCliInstall(deps)).managed).toBe(false);
  writeFileSync(join(f.prefix, "codex.cmd"), cmd + "\r\necho retargeted");
  expect((await inspectCodexCliInstall(f.deps)).managed).toBe(false);
});

native("a junction prefix is refused and prefix retarget attempts fail throughout the coherent observation", async () => {
  const f = fixture(); const alias = join(f.root, "alias"); symlinkSync(f.prefix, alias, "junction");
  expect((await inspectCodexCliInstall({ ...f.deps, env: { ...f.deps.env, CODEX_CLI_PATH: join(alias, "codex.cmd") } })).managed).toBe(false);
  let blocked = 0;
  setWindowsInstallationFilesOpenedForTests(() => { try { renameSync(f.prefix, f.prefix + "-moved"); } catch { blocked++; } });
  expect((await inspectCodexCliInstall(f.deps)).managed).toBe(true);
  expect(blocked).toBeGreaterThan(0);
});

native("a selected override changing during observation refuses the original prefix", async () => {
  const f = fixture();
  setWindowsInstallationFilesOpenedForTests(() => { f.deps.env.CODEX_CLI_PATH = join(f.root, "other", "codex.cmd"); });
  expect((await inspectCodexCliInstall(f.deps)).managed).toBe(false);
});

native("npm toolchain drift after inspection refuses metadata without executing the replacement", async () => {
  const f = fixture(); let queries = 0;
  const plan = await createCodexCliUpdatePlan({ inspectionDeps: f.deps, inspect: async deps => {
    const report = await inspectCodexCliInstall(deps); expect(report.managed).toBe(true);
    writeFileSync(join(f.npmRoot, "bin", "npm-cli.js"), "throw new Error('replacement');");
    return report;
  }, resolveTarget: () => { queries++; throw new Error("must not query changed toolchain"); } });
  expect(queries).toBe(0); expect(plan.refusal).toBe("target_unresolved");
});

native("the observed toolchain denies replacement until an asynchronous resolver settles", async () => {
  const f = fixture(); const report = await inspectCodexCliInstall(f.deps);
  expect(report.managed).toBe(true);
  const node = join(f.toolchainPrefix, "node.exe");
  const npmCli = join(f.npmRoot, "bin", "npm-cli.js");
  const moved = f.prefix + "-moved";
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const held = withWindowsCodexCliPlanToolchain(report, async () => {
    enter(); await gate; return "resolved";
  }).then(value => { settled = true; return value; });
  let result: string | null;
  try {
    await Promise.race([entered, held.then(() => { throw new Error("toolchain resolver was not entered"); })]);
    // A sync finalize returning an unawaited Promise can close its handles in a
    // microtask; cross an event-loop turn before checking the still-pending gate.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(settled).toBe(false);
    for (const path of [node, npmCli]) expect(() => writeFileSync(path, "replacement")).toThrow();
    expect(() => renameSync(f.prefix, moved)).toThrow();
  } finally {
    release(); result = await held;
  }
  expect(result).toBe("resolved");
  expect(settled).toBe(true);
  for (const path of [node, npmCli]) {
    writeFileSync(path, "replacement");
    expect(readFileSync(path, "utf8")).toBe("replacement");
  }
  renameSync(f.prefix, moved);
  expect(readFileSync(join(moved, "node_modules", "npm", "bin", "npm-cli.js"), "utf8")).toBe("replacement");
});

native("a separate PATH Node is refused without proof of the target cmd-shim's search result", async () => {
  const f = fixture(true);
  expect((await inspectCodexCliInstall({ ...f.deps, selectionAttested: false })).managed).toBe(false);
  const report = await inspectCodexCliInstall(f.deps);
  expect(report).toMatchObject({ managed: false, installContentDigest: null });
  let targetQueries = 0;
  const plan = await createCodexCliUpdatePlan({ inspectionDeps: f.deps,
    resolveTarget: () => { targetQueries++; throw new Error("unproven Node must not query registry"); } });
  expect(targetQueries).toBe(0);
  expect(plan.managed).toBe(false);
  expect(plan.refusal).toBe("windows_inspection_deferred");
  expect(JSON.stringify(plan)).not.toContain(f.root);
});

native("synthetic CMD lookup selects a current-directory node.cmd ahead of PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-cmd-search-")); roots.push(root);
  const current = join(root, "current"); const pathDir = join(root, "path");
  mkdirSync(current); mkdirSync(pathDir);
  writeFileSync(join(current, "node.cmd"), "@echo off\r\necho fixture-current-directory\r\n");
  writeFileSync(join(pathDir, "node.cmd"), "@echo off\r\necho fixture-path\r\n");
  const systemRoot = process.env.SystemRoot!;
  const cmdExe = join(systemRoot, "System32", "cmd.exe");
  const run = spawnSync(cmdExe, ["/d", "/c", "node"], { cwd: current, encoding: "utf8", windowsHide: true,
    timeout: 5_000, env: { SystemRoot: systemRoot, COMSPEC: cmdExe, PATH: pathDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD" } });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("fixture-current-directory");
  expect(run.stdout).not.toContain("fixture-path");
});

native("a refused or reparse prefix-local Node is not treated as absent for PATH fallback", async () => {
  const f = fixture(true);
  mkdirSync(join(f.prefix, "node.exe"));
  const report = await inspectCodexCliInstall(f.deps);
  expect(report.managed).toBe(false);
  expect(report.installContentDigest).toBeNull();

  const g = fixture(true);
  const target = join(g.root, "node-target"); mkdirSync(target);
  symlinkSync(target, join(g.prefix, "node.exe"), "junction");
  const reparse = await inspectCodexCliInstall(g.deps);
  expect(reparse.managed).toBe(false);
  expect(reparse.installContentDigest).toBeNull();
});

native("actual CLI handler reaches production inspector and plan from the proof-bound selection", async () => {
  const f = fixture(); const proof = "W".repeat(43);
  initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], {
    [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({ version: 1, proof, anthropicEnvSlots: [],
      codexCliInspectionEnv: { codexCliPath: f.deps.env.CODEX_CLI_PATH, path: f.prefix,
        pathExt: ".EXE;.CMD", managerRoots: {}, configDir: f.deps.configDir, arch: "x64" } }),
  });
  let reached = false;
  expect(await handleCodexCliUpdateCommand(["plan", "--json"], { createPlan: async deps => {
    const plan = await createCodexCliUpdatePlan({ ...deps,
      resolveTarget: () => ({ kind: "resolved", version: "1.2.4", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") }),
      scanProcesses: () => ({ kind: "observed", processes: [] }),
    });
    expect(plan.managed).toBe(true); expect(plan.planId).toMatch(/^[a-f0-9]{32}$/);
    expect(plan.refusal).toBe("windows_apply_disabled"); reached = true; return plan;
  } })).toBe(0);
  expect(reached).toBe(true);
});

native("published Node CLI uses the production inspector and observed toolchain for read-only metadata", () => {
  const f = fixture(); const hostNode = Bun.which("node"); expect(hostNode).not.toBeNull();
  const node = join(f.toolchainPrefix, "node.exe"); copyFileSync(hostNode!, node);
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const main = { name: "@openai/codex", version: "1.2.4", optionalDependencies: { "@openai/codex-win32-x64": "1.2.4" },
    dist: { integrity, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.2.4.tgz" } };
  const backing = { name: "@openai/codex-win32-x64", version: "1.2.4", dist: { integrity,
    tarball: "https://registry.npmjs.org/@openai/codex-win32-x64/-/codex-win32-x64-1.2.4.tgz" } };
  // Controlled registry protocol fixture; no real npm installation or network request.
  writeFileSync(join(f.npmRoot, "bin", "npm-cli.js"),
    `const spec = process.argv[3]; console.log(JSON.stringify(spec.startsWith('@openai/codex-win32-x64@') ? ${JSON.stringify(backing)} : ${JSON.stringify(main)}));`);
  const run = spawnSync(node, [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "plan", "--json"], {
    cwd: repoRoot(), encoding: "utf8", windowsHide: true, timeout: 45_000,
    env: { ...process.env, CODEX_CLI_PATH: f.deps.env.CODEX_CLI_PATH, OPENCODEX_HOME: f.deps.configDir,
      OPENCODEX_BUN_PATH: process.execPath, OCX_NO_DESKTOP_HANDOFF: "1" },
  });
  expect(run.error).toBeUndefined(); expect(run.status).toBe(0);
  const plan = JSON.parse(run.stdout);
  expect(plan.managed).toBe(true); expect(plan.targetVersion).toBe("1.2.4");
  expect(plan.targetIntegrity).toBe(integrity);
  expect(plan.applicable).toBe(false);
  expect(["blocked_active_session", "blocked_process_state_unknown", "windows_apply_disabled"]).toContain(plan.refusal);
  expect(JSON.stringify(plan)).not.toContain(f.root);
}, 60_000);
