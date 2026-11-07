import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { trustWindowsTempFixtureAncestry, windowsTempAncestryPreload } from "../helpers/windows-temp-ancestry";
import { dirname, isAbsolute, join, parse } from "node:path";
import { hardenSecretDir } from "../../src/lib/windows-secret-acl";
import { inspectCodexCliInstall, MAX_NATIVE_BACKING_BYTES } from "../../src/codex/cli-install-provenance";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { runCodexCliUpdatePlanInWorker } from "../../src/codex/cli-update-job-worker";
import { withWindowsCodexCliPlanToolchain, windowsCodexCliPlanRefusalForTests } from "../../src/codex/cli-windows-plan-provenance";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed, protectedHomeForTests } from "../../src/lib/test-home-guard";
import { TEST_TEMP_OWNER_FILE } from "../../scripts/test-temp";
import { setWindowsInstallationFilesOpenedForTests, setWindowsInstallationFilesReadForTests } from "../../src/codex/windows-installation-files";
import { removeTreeAfterBackgroundWork, removeTreeWithRetry } from "../helpers/remove-tree";
import { helperPath, repoPath, repoRoot } from "../helpers/repo-root";
import { handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import { initializeNodeLauncherContext, NODE_LAUNCH_CONTEXT_ENV, NODE_LAUNCH_PROOF_PREFIX } from "../../src/cli/launcher-context";
import { trackBackgroundWork } from "../../src/lib/background-work";
import { CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS } from "../../src/update/codex-cli-update-launch-policy.mjs";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { proveWindowsPlanJobExit } from "../helpers/windows-plan-job-proof";
import { hostedWindowsQuarantine } from "../helpers/windows-ci-quarantine";

const native = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
const roots: string[] = [];
const liveWorkerRoots = new Set<string>();
type OwnedPlanChild = { exited: Promise<number>; exitCode: number | null; kill(): unknown };
const ownedPlanChildren = new Map<string, OwnedPlanChild>();
let planCleanupEpoch = 0;
function independentPlanTemp(): string {
  const local = process.env.LOCALAPPDATA?.trim();
  if (!local || !isAbsolute(local)) throw new Error("native temp parent unavailable");
  const tempParent = realpathSync.native(join(local, "Temp"));
  for (let ancestor = tempParent;;) {
    if (existsSync(join(ancestor, TEST_TEMP_OWNER_FILE))) throw new Error("native temp is inside a test sandbox");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return tempParent;
}
async function stopOwnedPlanChild(root: string, timeoutMs = INTERNAL_DEADLINE_MS,
  requestStop: (child: OwnedPlanChild) => unknown = child => child.kill()): Promise<boolean> {
  const child = ownedPlanChildren.get(root);
  if (!child) return true;
  let killFailed = false;
  try { if (child.exitCode === null) requestStop(child); } catch { killFailed = true; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const exited = child.exited.then(() => true, () => false);
  const confirmed = await Promise.race([exited, expired]);
  clearTimeout(timer);
  if (!confirmed || killFailed) return false;
  ownedPlanChildren.delete(root);
  return true;
}
async function stopAllOwnedPlanChildren(): Promise<string[]> {
  const failures: string[] = [];
  for (const root of ownedPlanChildren.keys()) {
    if (!await stopOwnedPlanChild(root)) failures.push("Windows plan child exit unconfirmed; fixture retained");
  }
  return failures;
}
async function cleanupPlanFixture(root: string): Promise<boolean> {
  if (liveWorkerRoots.has(root)) return false;
  await removeTreeAfterBackgroundWork(root);
  return true;
}
afterEach(async () => {
  planCleanupEpoch++;
  const failures: unknown[] = (await stopAllOwnedPlanChildren()).map(message => new Error(message));
  initializeNodeLauncherContext(["bun", "cli"], {});
  setWindowsInstallationFilesOpenedForTests();
  setWindowsInstallationFilesReadForTests();
  for (const root of roots.splice(0)) {
    // A test timeout does not cancel its async body. Retain fixtures until a real
    // Worker close, or external reconciliation of an unsettled CLI process tree.
    try { if (!await cleanupPlanFixture(root)) roots.push(root); }
    catch (error) { roots.push(root); failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Windows plan fixture cleanup failed");
}, SPAWN_BUDGET_MS);
// npm's independent cmd-shim fixture; no candidate is ever executed.
const cmd = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL',
  'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (',
  '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');
function fixture(separateNodeToolchain = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-windows-plan-"))); roots.push(root);
  hardenSecretDir(root, { required: true });
  trustWindowsTempFixtureAncestry(root);
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
  const second = await inspectCodexCliInstall(f.deps);
  expect(second.installContentDigest, second.installContentDigest === null
    ? `Windows plan reinspection refused: ${second.reason}; ${JSON.stringify(windowsCodexCliPlanRefusalForTests(second))}` : undefined).toBe(report.installContentDigest);
  expect(JSON.stringify(report)).not.toContain(f.root);
  expect([...f.files].map(([path]) => readFileSync(path))).toEqual(before);
});

native("Windows plan sharing refusals retain bounded gate and reason diagnostics", async () => {
  const f = fixture();
  const { dlopen, ptr } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  try {
    for (const [path, gate] of [
      [join(f.prefix, "node.exe"), "local-node"],
      [join(f.backing, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"), "final-observation"],
    ] as const) {
      // A writer that changes no bytes still conflicts with the inspector's read-only sharing.
      const name = Buffer.from(path + "\0", "utf16le");
      const handle = kernel.symbols.CreateFileW(ptr(name), 0x40000000, 7, null, 3, 0, 0);
      expect(handle).not.toBe(0); expect(handle).not.toBe(0xffffffffffffffffn);
      try {
        const report = await inspectCodexCliInstall(f.deps);
        expect(report).toMatchObject({ managed: false, reason: "windows_inspection_deferred", installContentDigest: null });
        expect(windowsCodexCliPlanRefusalForTests(report)).toEqual({ gate, reason: "open-refused" });
        expect(JSON.stringify(report)).not.toContain(f.root);
        expect(JSON.stringify(report)).not.toContain(gate);
      } finally { expect(kernel.symbols.CloseHandle(handle)).not.toBe(0); }
    }
    const recovered = await inspectCodexCliInstall(f.deps);
    expect(recovered.managed).toBe(true);
    expect(windowsCodexCliPlanRefusalForTests(recovered)).toBeNull();
  } finally { kernel.close(); }
});

test.skipIf(process.platform !== "win32")("native 8.3 spellings cannot promote version-manager ownership or query metadata", async () => {
  const f = fixture();
  const query = spawnSync(join(process.env.SystemRoot!, "System32", "fsutil.exe"),
    ["8dot3name", "query", f.root.slice(0, 2)], { windowsHide: true, encoding: "utf8", timeout: 5_000 });
  expect(query.error).toBeUndefined(); expect(query.status).toBe(0);
  const { dlopen, ptr } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", { GetShortPathNameW: { args: ["ptr", "ptr", "u32"], returns: "u32" } });
  let shortRoot: string;
  try {
    const input = Buffer.from(f.root + "\0", "utf16le"), output = Buffer.alloc(32768 * 2);
    const length = kernel.symbols.GetShortPathNameW(ptr(input), ptr(output), 32768);
    expect(length).toBeGreaterThan(0); expect(length).toBeLessThan(32768);
    shortRoot = output.toString("utf16le", 0, length * 2);
  } finally { kernel.close(); }
  const different = shortRoot.toLowerCase() !== f.root.toLowerCase();
  if (!different) {
    // Disabled creation is a real negative lane, never an early successful return.
    const settings = [...query.stdout.matchAll(/:\s*(\d)/g)].map(match => Number(match[1]));
    expect(settings.length).toBeGreaterThanOrEqual(2);
    expect(settings[1] === 1 || (settings[1]! >= 2 && settings[0] === 1)).toBe(true);
  }
  const environments = different ? [
    { ...f.deps.env, NVM_HOME: f.root },
    { ...f.deps.env, CODEX_CLI_PATH: join(shortRoot, "npm", "codex.cmd"), NVM_HOME: f.root },
    { ...f.deps.env, NVM_HOME: shortRoot },
    { ...f.deps.env, CODEX_CLI_PATH: join(shortRoot, "npm", "codex.cmd"), NVM_HOME: shortRoot },
  ] : [
    { ...f.deps.env, NVM_HOME: f.root },
    // No alias can be created here: an unresolvable exclusion must refuse instead.
    { ...f.deps.env, NVM_HOME: join(f.root, "missing-manager-root") },
  ];
  for (const env of environments) {
    const inspectionDeps = { ...f.deps, env }; let queries = 0;
    const plan = await createCodexCliUpdatePlan({ inspectionDeps,
      scanProcesses: () => ({ kind: "observed", processes: [] }),
      resolveTarget: () => { queries++; return { kind: "resolved", version: "1.2.4",
        integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") }; },
    });
    expect(queries).toBe(0);
    expect(plan.managed).toBe(false); expect(plan.planId).toBeNull();
    const report = await inspectCodexCliInstall(inspectionDeps);
    expect(report.managed).toBe(false); expect(report.installContentDigest).toBeNull();
  }
}, 20_000);

native("configured exclusions must be canonical directories held throughout inspection and metadata", async () => {
  const f = fixture(), other = join(f.root, "unrelated-manager"); mkdirSync(other);
  const junction = join(f.root, "manager-junction"); symlinkSync(other, junction, "junction");
  for (const root of [join(f.root, "missing-manager"), junction, "relative-manager", "\\\\host\\share\\manager"]) {
    const report = await inspectCodexCliInstall({ ...f.deps, env: { ...f.deps.env, NVM_HOME: root } });
    expect(report.managed).toBe(false);
  }
  // More than twelve configured roots must cross the reader's request batch
  // boundary without dropping the final exclusion or refusing valid siblings.
  const managerRoots = Object.fromEntries(CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS.map((slot, index) => {
    const path = join(other, `manager-${index}`); mkdirSync(path); return [slot, path];
  }));
  expect((await inspectCodexCliInstall({ ...f.deps, env: { ...f.deps.env, ...managerRoots } })).managed).toBe(true);
  managerRoots.VOLTA_HOME = join(f.root, "missing-final-root");
  expect((await inspectCodexCliInstall({ ...f.deps, env: { ...f.deps.env, ...managerRoots } })).managed).toBe(false);
  const inspectionDeps = { ...f.deps, env: { ...f.deps.env, NVM_HOME: other } };
  const report = await inspectCodexCliInstall(inspectionDeps);
  expect(report.managed).toBe(true);
  let attempts = 0, blocked = 0;
  setWindowsInstallationFilesReadForTests(path => {
    if (!path.endsWith("package.json")) return;
    attempts++;
    try { renameSync(other, other + "-moved"); } catch { blocked++; }
  });
  expect((await inspectCodexCliInstall(inspectionDeps)).managed).toBe(true);
  expect(attempts).toBeGreaterThan(0); expect(blocked).toBe(attempts);
  expect(await withWindowsCodexCliPlanToolchain(report, async () => {
    expect(() => renameSync(other, other + "-moved")).toThrow(); return "held";
  })).toBe("held");
  setWindowsInstallationFilesReadForTests();
  renameSync(other, other + "-moved");
  symlinkSync(f.prefix, other, "junction");
  let queries = 0;
  expect(await withWindowsCodexCliPlanToolchain(report, async () => { queries++; return "unsafe"; })).toBeNull();
  expect(queries).toBe(0);
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

native("Windows plan fixture job close terminates its handle-bound child", () => {
  proveWindowsPlanJobExit(false); // Real child stays alive until its own release event.
  proveWindowsPlanJobExit(true); // Same fixture job configuration used by the child preload.
}, SPAWN_BUDGET_MS);

native("Windows plan cleanup stops its owned child before releasing its fixture", async () => {
  const epoch = planCleanupEpoch;
  try {
  const root = realpathSync.native(mkdtempSync(join(independentPlanTemp(), "ocx-plan-owned-child-")));
  roots.push(root); liveWorkerRoots.add(root);
  expect(isTestHomeGuardArmed()).toBe(true);
  assertNotRealHomeUnderTest(root);
  const child = Bun.spawn([process.execPath, "-e", 'console.log("READY"); for await(const chunk of Bun.stdin.stream()){void chunk;}'],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  ownedPlanChildren.set(root, child);
  const reader = child.stdout.getReader();
  let bodyFailed = false, bodyError: unknown;
  try {
    let ready = ""; const decoder = new TextDecoder();
    while (!ready.includes("\n")) {
      const part = await reader.read();
      if (planCleanupEpoch !== epoch) return;
      if (part.done || ready.length > 128) throw new Error("owned-child probe readiness unavailable");
      ready += decoder.decode(part.value, { stream: true });
    }
    expect(ready).toBe("READY\n");
    expect(child.exitCode).toBeNull();
    const beforeStop = await cleanupPlanFixture(root);
    if (planCleanupEpoch !== epoch) return;
    expect(beforeStop).toBe(false);
    expect(existsSync(root)).toBe(true);
    // If termination does not settle, the bounded cleanup must retain ownership.
    const unconfirmed = await stopOwnedPlanChild(root, 1, () => {});
    if (planCleanupEpoch !== epoch) return;
    expect(unconfirmed).toBe(false);
    expect(ownedPlanChildren.get(root)).toBe(child);
    expect(child.exitCode).toBeNull();
    const afterUnconfirmed = await cleanupPlanFixture(root);
    if (planCleanupEpoch !== epoch) return;
    expect(afterUnconfirmed).toBe(false);
    expect(existsSync(root)).toBe(true);
    const failures = await stopAllOwnedPlanChildren();
    if (planCleanupEpoch !== epoch) return;
    expect(failures).toEqual([]);
    const exit = await child.exited;
    if (planCleanupEpoch !== epoch) return;
    expect(exit).not.toBeNull();
    expect(ownedPlanChildren.has(root)).toBe(false);
    expect(existsSync(root)).toBe(true);
  } catch (error) {
    bodyFailed = true; bodyError = error;
  } finally {
    try {
      reader.releaseLock();
      child.stdin.end();
      await child.exited;
      if (planCleanupEpoch === epoch) {
        ownedPlanChildren.delete(root);
        liveWorkerRoots.delete(root);
      }
    } catch (cleanupError) {
      if (bodyFailed) throw new AggregateError([bodyError, cleanupError], "owned-child probe and cleanup failed");
      throw cleanupError;
    }
  }
  if (bodyFailed) throw bodyError;
  } catch (error) {
    if (planCleanupEpoch === epoch) throw error;
    console.error(`[test] owned-child probe settled after cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
}, SPAWN_BUDGET_MS);

// This case owns a real Bun child, its real lifetime-probe child, and Windows ACL
// subprocesses. It reached 5.02s locally against Bun's 5s default; Windows CI
// already supplies 60s. The shared spawn budget bounds the same intrinsic work.
test.skipIf(hostedWindowsQuarantine || process.platform !== "win32" || process.arch !== "x64")("an unsafe Windows ledger refuses admission and a disabled plan never installs", async () => {
  const epoch = planCleanupEpoch;
  try {
  // The child may outlive this test and the preload sandbox after a timeout.
  // Its fixture therefore lives outside every ownership-marked test sandbox.
  const tempParent = independentPlanTemp();
  const root = realpathSync.native(mkdtempSync(join(tempParent, "ocx-windows-plan-")));
  roots.push(root);
  // No fixture subprocess may start before ownership is registered.
  liveWorkerRoots.add(root);
  const f = { root, deps: { configDir: join(root, "absent-home") } };
  expect(isTestHomeGuardArmed()).toBe(true);
  assertNotRealHomeUnderTest(f.deps.configDir);
  const temp = join(f.root, "tmp"), localAppData = join(f.root, "AppData", "Local");
  for (const path of [temp, localAppData, join(f.root, "AppData", "Roaming")]) mkdirSync(path, { recursive: true });
  const drive = parse(f.root).root.slice(0, -1);
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root, HOMEDRIVE: drive, HOMEPATH: f.root.slice(drive.length),
    LOCALAPPDATA: localAppData, APPDATA: join(f.root, "AppData", "Roaming"), TEMP: temp, TMP: temp, TMPDIR: temp,
    XDG_CONFIG_HOME: join(f.root, "xdg", "config"), XDG_DATA_HOME: join(f.root, "xdg", "data"), XDG_CACHE_HOME: join(f.root, "xdg", "cache"),
    GIT_CONFIG_GLOBAL: join(f.root, "gitconfig"), BUN_INSTALL_CACHE_DIR: join(f.root, "bun-cache"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    OPENCODEX_HOME: f.deps.configDir, CODEX_HOME: join(f.root, "codex"), CODEX_SQLITE_HOME: join(f.root, "codex"),
    OCX_OWNER_REGISTRY_DIR: join(f.root, "ocx-homes"), CLAUDE_CONFIG_DIR: join(f.root, "claude"), GROK_HOME: join(f.root, "grok"),
    OPENCODEX_ADMIN_AUTH_TOKEN: undefined, OPENCODEX_API_AUTH_TOKEN: undefined, OCX_API_TOKEN_FILE: undefined,
    OCX_TEST_HOME_GUARD: "1", OCX_TEST_OWNED_ROOT: f.root, OCX_TEST_TEMP_PARENT: tempParent,
    OCX_TEST_PROTECTED_HOME: protectedHomeForTests() };
  // Register before spawning or awaiting. A failed or unsettled child retains its
  // independently owned root; only a successful, drained child releases it.
  const parentHome = process.env.OPENCODEX_HOME, parentAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  const child = Bun.spawn([process.execPath, "--preload", helperPath("windows-plan-child-processes.ts"),
    helperPath("windows-cli-plan-unsafe-case.ts")], {
    cwd: f.root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  ownedPlanChildren.set(f.root, child);
  const errorsPromise = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let readyChecked = false;
  let readinessFailed = false, readinessError: unknown;
  try {
    const decoder = new TextDecoder();
    let ready = "";
    while (!ready.includes("\n")) {
      const chunk = await reader.read();
      if (planCleanupEpoch !== epoch) return;
      if (chunk.done) throw new Error(`Windows plan child exited before readiness: ${await errorsPromise}`);
      ready += decoder.decode(chunk.value, { stream: true });
    }
    expect(ready).toBe("WINDOWS_CLI_PLAN_UNSAFE_CASE_READY\n");
    // Exercise the actual teardown while the real child is held before its work.
    const cleaned = await cleanupPlanFixture(f.root);
    if (planCleanupEpoch !== epoch) return;
    expect(cleaned).toBe(false);
    expect(existsSync(f.root)).toBe(true);
    expect(process.env.OPENCODEX_HOME).toBe(parentHome);
    expect(process.env.OPENCODEX_ADMIN_AUTH_TOKEN).toBe(parentAdmin);
    readyChecked = true;
  } catch (error) {
    readinessFailed = true; readinessError = error;
  } finally {
    try {
      child.stdin.end();
      if (!readyChecked) reader.releaseLock();
    } catch (cleanupError) {
      if (readinessFailed) throw new AggregateError([readinessError, cleanupError], "Windows plan readiness and cleanup failed");
      throw cleanupError;
    }
  }
  if (readinessFailed) throw readinessError;
  const outputPromise = (async () => {
    const decoder = new TextDecoder(); let output = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return output + decoder.decode();
        output += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
  })();
  const [exit, output, errors] = await Promise.all([child.exited, outputPromise, errorsPromise]);
  if (planCleanupEpoch !== epoch) {
    console.error(`[test] timed-out Windows plan child exited with ${exit}; fixture retained`);
    return;
  }
  if (exit !== 0) throw new Error(`Windows plan child failed: ${errors}`);
  expect(output.trim()).toBe("WINDOWS_CLI_PLAN_UNSAFE_CASE_PASS");
  ownedPlanChildren.delete(f.root);
  liveWorkerRoots.delete(f.root);
  } catch (error) {
    if (planCleanupEpoch === epoch) throw error;
    // Bun already failed the timed-out test. Preserve its independently owned
    // root and report a late child error without throwing into the next test.
    console.error(`[test] Windows plan fixture settled after cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
}, SPAWN_BUDGET_MS);

native("a published-size Windows npm backing binds; one past the shared finite limit refuses", async () => {
  const f = fixture();
  const binary = join(f.backing, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  // An NTFS sparse file has the installed 0.153.4-win32-x64 backing's logical
  // size without copying its bytes or allocating a dense 295 MB fixture.
  writeFileSync(binary, "");
  expect(process.env.SystemRoot).toBeDefined();
  const sparse = spawnSync(join(process.env.SystemRoot!, "System32", "fsutil.exe"), ["sparse", "setflag", binary],
    { windowsHide: true, encoding: "utf8", timeout: 5_000 });
  expect({ error: sparse.error ?? null, status: sparse.status, signal: sparse.signal,
    stdout: sparse.stdout?.trim() ?? null, stderr: sparse.stderr?.trim() ?? null })
    .toMatchObject({ error: null, status: 0 });
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
  const invalidShim = await inspectCodexCliInstall(f.deps);
  expect(invalidShim.managed).toBe(false);
  expect(windowsCodexCliPlanRefusalForTests(invalidShim)).toEqual({ gate: "shim-content" });
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

test.skipIf(hostedWindowsQuarantine || process.platform !== "win32" || process.arch !== "x64")("npm toolchain drift after inspection refuses metadata without executing the replacement", async () => {
  for (const f of [fixture(), fixture(true)]) {
    let queries = 0;
    const plan = await createCodexCliUpdatePlan({ inspectionDeps: f.deps, inspect: async deps => {
      const report = await inspectCodexCliInstall(deps);
      expect(report.managed, report.managed ? undefined : `Windows toolchain inspection refused (${f.prefix === f.toolchainPrefix ? "prefix-local" : "separate-PATH"}): ${JSON.stringify(windowsCodexCliPlanRefusalForTests(report))}`).toBe(true);
      writeFileSync(join(f.npmRoot, "bin", "npm-cli.js"), "throw new Error('replacement');");
      return report;
    }, resolveTarget: () => { queries++; throw new Error("must not query changed toolchain"); } });
    expect(queries).toBe(0); expect(plan.refusal).toBe("target_unresolved");
  }
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

native("a separate PATH Node/npm toolchain binds for read-only planning under the launcher arch anchor", async () => {
  const f = fixture(true);
  expect((await inspectCodexCliInstall({ ...f.deps, selectionAttested: false })).managed).toBe(false);
  const report = await inspectCodexCliInstall(f.deps);
  expect(report).toMatchObject({ managed: true, selectionAttested: true, provenance: "npm-global",
    reason: "managed_npm_global", packageVersion: "1.2.3" });
  expect(report.installContentDigest).toMatch(/^[a-f0-9]{64}$/);
  expect((await inspectCodexCliInstall(f.deps)).installContentDigest).toBe(report.installContentDigest);
  expect(JSON.stringify(report)).not.toContain(f.root);

  const deps = { inspectionDeps: f.deps,
    resolveTarget: () => ({ kind: "resolved" as const, version: "1.2.4", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") }),
    scanProcesses: () => ({ kind: "observed" as const, processes: [] }) };
  const first = await createCodexCliUpdatePlan(deps);
  expect(first).toMatchObject({ managed: true, applicable: false, refusal: "windows_apply_disabled",
    installedVersion: "1.2.3", targetVersion: "1.2.4" });
  expect(first.planId).toMatch(/^[a-f0-9]{32}$/);
  expect((await createCodexCliUpdatePlan(deps)).planId).toBe(first.planId);
  expect(JSON.stringify(first)).not.toContain(f.root);
});

native("a separate PATH Node without the launcher arch anchor stays refused", async () => {
  const f = fixture(true);
  const report = await inspectCodexCliInstall({ ...f.deps, arch: undefined });
  expect(report).toMatchObject({ managed: false, installContentDigest: null });
  let targetQueries = 0;
  const plan = await createCodexCliUpdatePlan({ inspectionDeps: { ...f.deps, arch: undefined },
    resolveTarget: () => { targetQueries++; throw new Error("unanchored Node must not query registry"); } });
  expect(targetQueries).toBe(0);
  expect(plan.managed).toBe(false);
  expect(plan.refusal).toBe("windows_inspection_deferred");
  expect(JSON.stringify(plan)).not.toContain(f.root);
});

native("a separate PATH Node whose PE arch disagrees with the launcher anchor stays refused", async () => {
  const f = fixture(true);
  const report = await inspectCodexCliInstall({ ...f.deps, arch: "arm64" as const });
  expect(report).toMatchObject({ managed: false, installContentDigest: null });
});

native("a separate PATH Node without its adjacent npm-cli.js stays deferred", async () => {
  const f = fixture(true);
  removeTreeWithRetry(f.npmRoot);
  const report = await inspectCodexCliInstall(f.deps);
  expect(report).toMatchObject({ managed: false, installContentDigest: null });
  const plan = await createCodexCliUpdatePlan({ inspectionDeps: f.deps });
  expect(plan.managed).toBe(false);
  expect(plan.refusal).toBe("windows_inspection_deferred");
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

// An honest decision is coupled to its own evidence: a clean private prefix the
// apply authority can pin yields an applicable plan, while a real session or
// process-table blocker - or an apply path the lane cannot support - yields the
// matching refusal. The pair is asserted together so neither side can drift.
function expectPlanDecision(plan: { applicable: boolean; refusal: string | null;
  session: { state: string; matches: number | null } }): void {
  expect(plan.applicable).toBe(plan.refusal === null);
  if (plan.refusal !== null)
    expect(["blocked_active_session", "blocked_process_state_unknown", "windows_apply_disabled"]).toContain(plan.refusal);
  if (plan.refusal === "blocked_active_session") {
    expect(plan.session).toMatchObject({ state: "active" });
    expect(Number.isInteger(plan.session.matches)).toBe(true);
    expect(plan.session.matches).toBeGreaterThan(0);
  }
  else if (plan.refusal === "blocked_process_state_unknown") expect(plan.session).toMatchObject({ state: "unknown", matches: null });
  else expect(plan.session).toMatchObject({ state: "none", matches: 0 });
}

native("a fresh production Worker rebuilds private Windows plan evidence before reading fixture metadata", async () => {
  const f = fixture(); const hostNode = Bun.which("node"); expect(hostNode).not.toBeNull();
  copyFileSync(hostNode!, join(f.toolchainPrefix, "node.exe"));
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const main = { name: "@openai/codex", version: "1.2.4", optionalDependencies: { "@openai/codex-win32-x64": "1.2.4" },
    dist: { integrity, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.2.4.tgz" } };
  const backing = { name: "@openai/codex-win32-x64", version: "1.2.4", dist: { integrity,
    tarball: "https://registry.npmjs.org/@openai/codex-win32-x64/-/codex-win32-x64-1.2.4.tgz" } };
  // Only this owned npm protocol fixture runs; Codex and real npm never execute.
  writeFileSync(join(f.npmRoot, "bin", "npm-cli.js"),
    `const spec = process.argv[3]; console.log(JSON.stringify(spec.startsWith('@openai/codex-win32-x64@') ? ${JSON.stringify(backing)} : ${JSON.stringify(main)}));`);
  let starts = 0, worker: Worker | undefined, closed = false;
  try {
    const plan = await runCodexCliUpdatePlanInWorker({
      snapshot: { codexCliPath: f.deps.env.CODEX_CLI_PATH, path: f.prefix, pathExt: ".EXE;.CMD",
        home: f.root, nodePath: null, managerRoots: {}, transportEnv: {}, configDir: f.deps.configDir, arch: "x64" },
      spawnWorkerFn: (url, key) => {
        expect(key).toBe("cli-update-worker"); starts++;
        // Pin this integration to current source, not a leftover generated bundle.
        worker = new Worker(url, { type: "module", preload: windowsTempAncestryPreload(f.root) });
        liveWorkerRoots.add(f.root);
        const actualClose = Promise.withResolvers<void>();
        void trackBackgroundWork("windows-plan-fixture-worker-close", actualClose.promise);
        worker.addEventListener("close", () => {
          closed = true; liveWorkerRoots.delete(f.root); actualClose.resolve();
        }, { once: true });
        return worker;
      },
    });
    expect(starts).toBe(1);
    expect(closed).toBe(true);
    expect(plan).toMatchObject({ managed: true, installedVersion: "1.2.3", targetVersion: "1.2.4",
      targetIntegrity: integrity });
    expect(plan.installContentDigest).toMatch(/^[a-f0-9]{64}$/);
    // The decision is evaluated after private-evidence admission and successful
    // fixture metadata resolution; refusal stays allowed only for real blockers.
    expectPlanDecision(plan);
    expect(JSON.stringify(plan)).not.toContain(f.root);
  } finally {
    // afterEach retains this fixture even if the test times out before this
    // finally is reached. No terminate() or fabricated terminal evidence.
    if (worker && !closed) liveWorkerRoots.add(f.root);
  }
}, 60_000);

function separateWorkerFixture(copyExecutable = true) {
  const f = fixture(true);
  if (copyExecutable) {
    const hostNode = Bun.which("node"); expect(hostNode).not.toBeNull();
    copyFileSync(hostNode!, join(f.toolchainPrefix, "node.exe"));
  }
  expect(existsSync(join(f.prefix, "node.exe"))).toBe(false);
  const marker = join(f.root, "metadata-ran"), integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const main = { name: "@openai/codex", version: "1.2.4", optionalDependencies: { "@openai/codex-win32-x64": "1.2.4" },
    dist: { integrity, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.2.4.tgz" } };
  const backing = { name: "@openai/codex-win32-x64", version: "1.2.4", dist: { integrity,
    tarball: "https://registry.npmjs.org/@openai/codex-win32-x64/-/codex-win32-x64-1.2.4.tgz" } };
  writeFileSync(join(f.npmRoot, "bin", "npm-cli.js"),
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'metadata\\n'); const spec = process.argv[3]; console.log(JSON.stringify(spec.startsWith('@openai/codex-win32-x64@') ? ${JSON.stringify(backing)} : ${JSON.stringify(main)}));`);
  return { ...f, marker, integrity };
}

async function separateWorkerPlan(f: ReturnType<typeof separateWorkerFixture>, arch: "x64" | "arm64" | null, drift = false) {
  let starts = 0, closed = false;
  const plan = await runCodexCliUpdatePlanInWorker({
    snapshot: { codexCliPath: f.deps.env.CODEX_CLI_PATH, path: f.toolchainPrefix, pathExt: ".EXE;.CMD",
      home: f.root, nodePath: null, managerRoots: {}, transportEnv: {}, configDir: f.deps.configDir, arch },
    spawnWorkerFn: (url, key) => {
      expect(key).toBe("cli-update-worker"); starts++;
      // Drift needs a test-only injection seam; the positive and arch refusals use the production entry.
      const worker = new Worker(drift ? repoPath("tests", "helpers", "cli-windows-plan-drift-worker.ts") : url,
        { type: "module", preload: windowsTempAncestryPreload(f.root) });
      liveWorkerRoots.add(f.root);
      const actualClose = Promise.withResolvers<void>();
      void trackBackgroundWork("windows-plan-fixture-worker-close", actualClose.promise);
      worker.addEventListener("close", () => {
        closed = true; liveWorkerRoots.delete(f.root); actualClose.resolve();
      }, { once: true });
      return worker;
    },
  });
  // afterEach retains the root if dispatch/test timeout occurs without real close.
  expect(starts).toBe(1); expect(closed).toBe(true);
  return plan;
}

native("a fresh production Worker binds a separate Node/npm metadata vehicle with the launcher arch", async () => {
  const f = separateWorkerFixture(), plan = await separateWorkerPlan(f, "x64");
  expect(plan).toMatchObject({ managed: true, installedVersion: "1.2.3", targetVersion: "1.2.4",
    targetIntegrity: f.integrity });
  expect(plan.installContentDigest).toMatch(/^[a-f0-9]{64}$/);
  expectPlanDecision(plan);
  expect(readFileSync(f.marker, "utf8")).toContain("metadata");
  expect(JSON.stringify(plan)).not.toContain(f.root);
}, 60_000);

native("fresh Worker realms refuse missing or mismatched arch and reject post-inspection npm drift before metadata", async () => {
  for (const mode of ["missing", "mismatch", "drift"] as const) {
    const f = separateWorkerFixture(mode === "drift");
    const plan = await separateWorkerPlan(f, mode === "missing" ? null : mode === "mismatch" ? "arm64" : "x64", mode === "drift");
    expect(plan).toMatchObject({ managed: mode === "drift", applicable: false, targetVersion: null,
      refusal: mode === "drift" ? "target_unresolved" : "windows_inspection_deferred" });
    if (mode === "drift") expect(plan.installContentDigest).toMatch(/^[a-f0-9]{64}$/);
    else expect(plan.installContentDigest).toBeNull();
    expect(existsSync(f.marker)).toBe(false);
    expect(JSON.stringify(plan)).not.toContain(f.root);
  }
}, 60_000);

function checkPublishedNodeCliPlan(separateNodeToolchain: boolean) {
  const started = performance.now();
  const hostNode = Bun.which("node"); expect(hostNode).not.toBeNull();
  const f = fixture(separateNodeToolchain);
  const node = join(f.toolchainPrefix, "node.exe"); copyFileSync(hostNode!, node);
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const main = { name: "@openai/codex", version: "1.2.4", optionalDependencies: { "@openai/codex-win32-x64": "1.2.4" },
    dist: { integrity, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.2.4.tgz" } };
  const backing = { name: "@openai/codex-win32-x64", version: "1.2.4", dist: { integrity,
    tarball: "https://registry.npmjs.org/@openai/codex-win32-x64/-/codex-win32-x64-1.2.4.tgz" } };
  // Controlled registry protocol fixture; no real npm installation or network request.
  writeFileSync(join(f.npmRoot, "bin", "npm-cli.js"),
    `const spec = process.argv[3]; console.log(JSON.stringify(spec.startsWith('@openai/codex-win32-x64@') ? ${JSON.stringify(backing)} : ${JSON.stringify(main)}));`);
  // This independent npm fixture has no manager roots. Inheriting the host's
  // NVM_SYMLINK junction would correctly refuse the plan before metadata.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS.includes(name.toUpperCase() as typeof CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS[number])));
  // Inject the fixture ancestry boundary into the launched Bun realm, while
  // still executing the published Node launcher's capture and production CLI.
  const nodePreload = join(f.root, "node-fixture-preload.cjs");
  writeFileSync(nodePreload, `const cp=require('node:child_process'),spawn=cp.spawn;\ncp.spawn=function(file,args,options){if(file===${JSON.stringify(process.execPath)})args=['--preload',${JSON.stringify(windowsTempAncestryPreload(f.root))},...args];return spawn.call(this,file,args,options)};require('node:module').syncBuiltinESMExports();`);
  const run = spawnSync(node, ["--require", nodePreload, repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "plan", "--json"], {
    cwd: repoRoot(), encoding: "utf8", windowsHide: true, timeout: 45_000,
    env: { ...env, PATH: f.toolchainPrefix + ";" + process.env.PATH, CODEX_CLI_PATH: f.deps.env.CODEX_CLI_PATH, OPENCODEX_HOME: f.deps.configDir,
      OPENCODEX_BUN_PATH: process.execPath, OCX_NO_DESKTOP_HANDOFF: "1" },
  });
  if (run.error || run.status !== 0 || run.signal) {
    // A failed synchronous result does not prove Node/Bun descendants have exited.
    liveWorkerRoots.add(f.root);
    // Keep the preload's ancestor sandbox too; only external ownership checks can release it.
    void trackBackgroundWork("windows-plan-fixture-cli-unsettled", new Promise<void>(() => {}));
    console.error(JSON.stringify({ layout: separateNodeToolchain ? "separate-PATH" : "prefix-local",
      elapsedMs: Math.round(performance.now() - started), status: run.status, signal: run.signal,
      errorCode: (run.error as NodeJS.ErrnoException | undefined)?.code ?? null }));
  }
  expect({ error: run.error ?? null, status: run.status, signal: run.signal,
    stdout: run.stdout?.trim() ?? null, stderr: run.stderr?.trim() ?? null })
    .toMatchObject({ error: null, status: 0 });
  const plan = JSON.parse(run.stdout);
  expect(plan.managed).toBe(true); expect(plan.targetVersion).toBe("1.2.4");
  expect(plan.targetIntegrity).toBe(integrity);
  expectPlanDecision(plan);
  expect(JSON.stringify(plan)).not.toContain(f.root);
}

native("published Node CLI plans with the production inspector and prefix-local toolchain", () => {
  checkPublishedNodeCliPlan(false);
}, 60_000);

native("published Node CLI plans with the production inspector and separate PATH toolchain", () => {
  checkPublishedNodeCliPlan(true);
}, 60_000);
