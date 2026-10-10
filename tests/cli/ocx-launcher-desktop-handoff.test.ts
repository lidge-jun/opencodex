import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, constants, fstatSync, lstatSync, mkdirSync, openSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync as writeFile, type statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readDesktopCliRecord as readRecord, desktopCliRecordPath, DESKTOP_CLI_RECORD_MAX_BYTES, type DesktopCliRecordRead, type DesktopCliRecordOptions, type DesktopCliRecordDeps } from "../../src/lib/desktop-cli-record.mjs";
import { desktopHandoffExcluded, planDesktopCliHandoff, runDesktopCliHandoff } from "../../src/lib/desktop-cli-handoff.mjs";
import { initializeNodeLauncherContext } from "../../src/cli/launcher-context";
import { buildNativeClaudeEnv } from "../../src/cli/claude";
import { observeManagingClis } from "../../src/service/managing-cli";
import { repoPath } from "../helpers/repo-root";

// Explicit private fixtures; only temp paths are written by this helper.
function writeFileSync(path: string, data: Parameters<typeof writeFile>[1]): void {
  writeFile(path, data, { mode: 0o600 });
}
function readDesktopCliRecord(options: DesktopCliRecordOptions = {}, deps: DesktopCliRecordDeps = {}): DesktopCliRecordRead {
  const hostStats = process.platform === "win32" ? {
    euid: 0,
    lstat: (path: string) => { const stat = lstatSync(path); stat.uid = 0; stat.mode = stat.isDirectory() ? 0o40700 : 0o100600; return stat; },
    fstat: (fd: number) => { const stat = fstatSync(fd); stat.uid = 0; stat.mode = 0o100600; return stat; },
  } : {};
  return readRecord(options, { ...hostStats, ...deps });
}
const roots: string[] = [];
const hostKind = { darwin: "macos-app", win32: "windows-install", linux: "linux-deb" }[process.platform as "darwin" | "win32" | "linux"];
const PREFIX = "--ocx-internal-launch-proof=";
const proof = "A".repeat(43);
const context = JSON.stringify({ version: 1, proof, anthropicEnvSlots: ["ANTHROPIC_API_KEY"], codexCliInspectionEnv: null });
afterEach(() => {
  initializeNodeLauncherContext(["bun", "index.ts"], {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function box(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-handoff-")); chmodSync(root, 0o700); roots.push(root); return root;
}
function ready(target = "/fixture/desktop/ocx"): DesktopCliRecordRead {
  return { state: "ready", path: "/fixture/cli.json", record: {
    platform: "linux", kind: "linux-deb", cliExecutable: target,
  } };
}
const stat = (() => ({ isFile: () => true })) as unknown as typeof statSync;
const deps = { stat, access: () => {}, realpath: (path: string) => path };
const coded = (code: string): NodeJS.ErrnoException => Object.assign(new Error("fixture"), { code });

function fakeSpawn(error?: string, exitSignal: NodeJS.Signals | null = null) {
  const parent = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
  const killed: string[] = [];
  child.kill = signal => { killed.push(signal); return true; };
  let observed: { target: string; argv: string[]; options: Record<string, unknown> } | undefined;
  const run = ((target: string, argv: string[], options: Record<string, unknown>) => {
    observed = { target, argv, options };
    queueMicrotask(() => {
      parent.emit("SIGTERM");
      if (error) { child.emit("error", coded(error)); child.emit("exit", 99, null); }
      else child.emit("exit", 17, exitSignal);
    });
    return child;
  }) as unknown as typeof spawn;
  return { run, parent, killed, observed: () => observed };
}

describe("Desktop record and handoff policy", () => {
  test("fixed record location and injected reader path", () => {
    expect(desktopCliRecordPath({ platform: "darwin", home: "/Users/example" })).toBe("/Users/example" + "/.opencodex-desktop/cli.json");
    expect(desktopCliRecordPath({ platform: "win32", env: { USERPROFILE: "C:\\Users\\example" } })).toBe("C:\\Users\\example\\.opencodex-desktop\\cli.json");
    const root = box(); const recordPath = join(root, "cli.json");
    expect(readDesktopCliRecord({ recordPath }).state).toBe("missing");
    writeFileSync(recordPath, '{"version":1,"enabled":false}');
    expect(readDesktopCliRecord({ recordPath }).state).toBe("disabled");
    writeFileSync(recordPath, JSON.stringify({ version: 1, enabled: true, bundle: { platform: process.platform, kind: hostKind, cliExecutable: join(root, "ocx") }, ownerId: "ignored" }));
    expect(readDesktopCliRecord({ recordPath }).state).toBe("ready");
  });
  test("reader refuses oversized, malformed, pending and wrong-platform records", () => {
    const root = box(); const recordPath = join(root, "cli.json");
    const valid = { version: 1, enabled: true, bundle: { platform: process.platform, kind: hostKind, cliExecutable: join(root, "ocx") } };
    for (const value of ["{", "[]", "null", "42", JSON.stringify({ ...valid, enabled: "yes" }), JSON.stringify({ ...valid, bundle: null }), JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, pending: {} }), JSON.stringify({ ...valid, bundle: { platform: "other", cliExecutable: "relative" } }), JSON.stringify({ ...valid, bundle: { platform: process.platform, kind: hostKind, cliExecutable: "relative" } }), JSON.stringify({ ...valid, bundle: { platform: process.platform, kind: hostKind, cliExecutable: "/" + "x".repeat(4096) } }), JSON.stringify({ ...valid, bundle: { platform: process.platform, kind: hostKind, cliExecutable: "/fixture/line\nbreak" } })]) {
      writeFileSync(recordPath, value); expect(readDesktopCliRecord({ recordPath }).state).toBe("invalid");
    }
    writeFileSync(recordPath, " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES));
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ issue: "record-invalid" });
    writeFileSync(recordPath, " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES + 1));
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ issue: "record-too-large" });
    rmSync(recordPath); mkdirSync(recordPath);
    expect(readDesktopCliRecord({ recordPath }).state).toBe("invalid");
  });
  test("descriptor sentinel bounds growth after metadata and strict UTF-8 rejects corrupt bytes", () => {
    const root = box(); const recordPath = join(root, "cli.json");
    writeFileSync(recordPath, Buffer.from([0xff]));
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ issue: "record-invalid" });
    writeFileSync(recordPath, " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES + 1));
    const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.fstatSync; fs.fstatSync = (...args) => { const info = original(...args); info.size = 1; return info; }; syncBuiltinESMExports();
const mod = await import(${JSON.stringify(pathToFileURL(repoPath("src", "lib", "desktop-cli-record.mjs")).href)});
console.log(JSON.stringify(mod.readDesktopCliRecord({recordPath:${JSON.stringify(recordPath)}})));`;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ issue: "record-too-large" });
  });
  (process.platform === "win32" ? test.skip : test)("reader symlinks are unsafe and disabled intent wins over pending journal", () => {
    const root = box(); const recordPath = join(root, "cli.json");
    symlinkSync(recordPath, recordPath);
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ state: "invalid", issue: "record-unsafe" });
    rmSync(recordPath); writeFileSync(recordPath, '{"version":1,"enabled":false,"pending":{}}');
    expect(readDesktopCliRecord({ recordPath })).toMatchObject({ state: "disabled", cleanupPending: true });
  });
  test("record absence and disabled intent keep the package path; invalid records error", () => {
    for (const state of ["missing", "disabled"] as const) expect(planDesktopCliHandoff({ platform: "linux", argv: ["status"], env: {}, recordRead: state === "disabled" ? { state, path: "fixture", cleanupPending: false } : { state, path: "fixture" } })).toEqual({ kind: "continue", reason: state });
    for (const issue of ["record-invalid", "record-too-large", "record-pending", "record-unreadable", "record-unsafe"] as const) expect(planDesktopCliHandoff({ platform: "linux", argv: ["status"], env: {}, recordRead: { state: issue === "record-unreadable" ? "unreadable" : "invalid", issue, path: "fixture" } })).toEqual({ kind: "error", issue });
  });
  test("update, removal, internal inspection and codex-cli-update are exceptions", () => {
    for (const argv of [["update"], ["update", "--help"], ["uninstall"], ["remove"], ["__update-badge"], ["system", "codex-cli-update", "malformed"], [PREFIX + "invalid", "update"]]) {
      expect(desktopHandoffExcluded(argv, {})).toBe(true);
      expect(planDesktopCliHandoff({ platform: "linux", argv, env: {}, recordRead: ready() }, { stat: (() => { throw new Error("must not read target"); }) as typeof stat })).toMatchObject({ reason: "excluded" });
    }
    expect(desktopHandoffExcluded(["--version"], {})).toBe(false);
    expect(desktopHandoffExcluded(["inspect", "config"], {})).toBe(false);
  });
  test("OCX_NO_DESKTOP_HANDOFF is exact and keeps user version handoff eligible", () => {
    expect(desktopHandoffExcluded(["--version"], { OCX_NO_DESKTOP_HANDOFF: "1" })).toBe(true);
    expect(desktopHandoffExcluded(["--version"], { OCX_NO_DESKTOP_HANDOFF: "0" })).toBe(false);
  });
  test("absolute regular executable target selected; self realpath never delegated", () => {
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready(), selfPaths: ["/fixture/package/ocx.mjs"] }, deps)).toEqual({ kind: "handoff", target: "/fixture/desktop/ocx" });
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready(), selfPaths: ["/fixture/alias"] }, { ...deps, realpath: () => "/fixture/same" })).toMatchObject({ kind: "error", issue: "target-self" });
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready("relative") }, deps)).toMatchObject({ issue: "target-invalid" });
    const selfPaths = ["/fixture/missing-self"];
    const missingSelf = { ...deps, realpath: (path: string) => { if (path === selfPaths[0]) throw coded("ENOENT"); return path; } };
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready(), selfPaths }, missingSelf).kind).toBe("handoff");
    const badSelf = { ...deps, realpath: (path: string) => { if (path === selfPaths[0]) throw coded("ELOOP"); return path; } };
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready(), selfPaths }, badSelf)).toMatchObject({ issue: "target-unusable" });
    expect(planDesktopCliHandoff({ argv: [], env: {}, platform: "linux", recordRead: ready() }, { ...deps, stat: (() => ({ isFile: () => false })) as unknown as typeof statSync })).toMatchObject({ issue: "target-invalid" });
  });
  test("target ENOENT resumes and EACCES or other errors fail", () => {
    for (const code of ["ENOENT", "EACCES", "ENOTDIR", "ENOEXEC", "ELOOP"]) {
      const plan = planDesktopCliHandoff({ argv: ["status"], env: {}, platform: "linux", recordRead: ready() }, { ...deps, access: () => { throw coded(code); } });
      expect(plan.kind).toBe(code === "ENOENT" ? "continue" : "error");
    }
  });
  test("Windows returns before reading valid, unreadable or unsafe records and never selects a spawn", () => {
    for (const read of [ready("C:\\App\\ocx.exe"), { state: "unreadable", path: "fixture", issue: "record-unreadable" }, { state: "invalid", path: "fixture", issue: "record-unsafe" }] as DesktopCliRecordRead[]) {
      let readAttempted = false;
      let targetChecked = false;
      let spawned = false;
      const input = { platform: "win32" as const, argv: ["--version"], env: {} };
      Object.defineProperty(input, "recordRead", { get() { readAttempted = true; return read; } });
      const plan = planDesktopCliHandoff(input, { stat: (() => { targetChecked = true; throw new Error("must not check target"); }) as typeof stat });
      if (plan.kind === "handoff") spawned = true;
      expect(plan).toEqual({ kind: "continue", reason: "windows-path-only" });
      expect(readAttempted).toBe(false);
      expect(targetChecked).toBe(false);
      expect(spawned).toBe(false);
    }
  });
});

describe("async handoff transport", () => {
  test("argv, inherited stdin, fresh proof and exit code; signal handlers cleaned", async () => {
    const fake = fakeSpawn();
    const result = await runDesktopCliHandoff({ kind: "handoff", target: "/fixture/ocx" }, {
      argv: [PREFIX + "obsolete", "claude", "a b", "--literal=$x"], proof, context,
      env: { PATH: "fixture", OCX_BUN_RUNTIME_PATH: "stale", OCX_BUN_RUNTIME_SOURCE: "bundled" },
    }, { spawn: fake.run, parent: fake.parent as unknown as NodeJS.Process, platform: "linux" });
    expect(result).toEqual({ kind: "exit", code: 17, signal: null });
    const called = fake.observed()!;
    expect(called.argv).toEqual([PREFIX + proof, "claude", "a b", "--literal=$x"]);
    expect(called.options).toMatchObject({ stdio: "inherit", shell: false, windowsHide: true });
    expect(called.options.env).toEqual({ PATH: "fixture", OCX_NO_DESKTOP_HANDOFF: "1", OCX_NODE_LAUNCH_CONTEXT: context });
    expect(fake.killed).toEqual(["SIGTERM"]); expect(fake.parent.listenerCount("SIGTERM")).toBe(0);
  });
  test("child signal is retained and confirmed asynchronous target ENOENT resumes", async () => {
    for (const error of [undefined, "ENOENT", "EACCES", "ENOEXEC"]) {
      const fake = fakeSpawn(error, "SIGTERM");
      const result = await runDesktopCliHandoff({ kind: "handoff", target: "/fixture/ocx" }, { argv: [], env: {}, proof, context }, { spawn: fake.run, parent: fake.parent as unknown as NodeJS.Process, lstat: (() => { throw coded("ENOENT"); }) as typeof lstatSync });
      expect(result.kind).toBe(!error ? "exit" : error === "ENOENT" ? "continue" : "error");
      if (result.kind === "exit") expect(result.signal).toBe("SIGTERM");
      expect(fake.parent.eventNames()).toHaveLength(0);
    }
  });
  test("Windows forwards INT/TERM only and a kill race still settles from child exit", async () => {
    const fake = fakeSpawn();
    const pending = runDesktopCliHandoff({ kind: "handoff", target: "C:\\App\\ocx.exe" }, { argv: [], env: {}, proof, context }, { spawn: fake.run, parent: fake.parent as unknown as NodeJS.Process, platform: "win32" });
    expect(fake.parent.listenerCount("SIGHUP")).toBe(0); expect(fake.parent.listenerCount("SIGINT")).toBe(1);
    expect((await pending).kind).toBe("exit");
    const parent = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & { kill: () => never };
    child.kill = () => { throw new Error("already exited"); };
    const run = (() => { queueMicrotask(() => { parent.emit("SIGTERM"); child.emit("exit", null, null); }); return child; }) as unknown as typeof spawn;
    expect(await runDesktopCliHandoff({ kind: "handoff", target: "/fixture/ocx" }, { argv: [], env: {}, proof, context }, { spawn: run, parent: parent as unknown as NodeJS.Process })).toEqual({ kind: "exit", code: 1, signal: null });
  });
  test("synchronous spawn errors have the same confirmed-target ENOENT policy", async () => {
    for (const code of ["ENOENT", "EACCES"]) {
      const fail = (() => { throw coded(code); }) as unknown as typeof spawn;
      expect((await runDesktopCliHandoff({ kind: "handoff", target: "/fixture/ocx" }, { argv: [], env: {}, proof, context }, { spawn: fail, lstat: (() => { throw coded("ENOENT"); }) as typeof lstatSync })).kind).toBe(code === "ENOENT" ? "continue" : "error");
    }
  });
  test("proof reaches the real Claude native-env consumer and keeps exported slots", () => {
    const env = { OCX_NODE_LAUNCH_CONTEXT: context, ANTHROPIC_API_KEY: "fixture-user-key", ANTHROPIC_BASE_URL: "https://fixture.invalid", OCX_PRE_BUN_ANTHROPIC_ENV: "obsolete" };
    const argv = ["bun", "index.ts", PREFIX + proof, "claude"];
    expect(initializeNodeLauncherContext(argv, env)?.anthropicEnvSlots).toEqual(["ANTHROPIC_API_KEY"]);
    expect(argv).toEqual(["bun", "index.ts", "claude"]);
    const config = { port: 10100, providers: {} } as Parameters<typeof buildNativeClaudeEnv>[0];
    const child = buildNativeClaudeEnv(config, env);
    expect(child.ANTHROPIC_API_KEY).toBe("fixture-user-key");
    expect(child.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(child.OCX_NODE_LAUNCH_CONTEXT).toBeUndefined();
  });
  test("internal managing CLI probes set the bypass in the actual spawn environment", () => {
    let actual: NodeJS.ProcessEnv | undefined;
    const probe = ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { actual = options.env; return { status: 0, stdout: "2.82.0", stderr: "" }; }) as unknown as typeof spawnSync;
    const result = observeManagingClis(null, { platform: "linux", env: { PATH: "/fixture", KEEP: "yes" }, execPath: "/fixture/self", exists: path => path === "/fixture/ocx", isFile: () => true, spawn: probe });
    expect(result.path.status).toBe("observed"); expect(actual).toEqual({ PATH: "/fixture", KEEP: "yes", OCX_NO_DESKTOP_HANDOFF: "1" });
  });
});

function packageFixture() {
  const home = box(); const directory = join(home, ".opencodex-desktop"); mkdirSync(directory, { mode: 0o700 });
  for (const name of ["opencodex", "codex", "grok"]) mkdirSync(join(home, name));
  const target = join(home, "desktop-cli");
  const recordPath = join(directory, "cli.json");
  writeFileSync(recordPath, JSON.stringify({ version: 1, enabled: true, bundle: { platform: process.platform, kind: hostKind, cliExecutable: target } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(home, "opencodex"), CODEX_HOME: join(home, "codex"), GROK_HOME: join(home, "grok"), ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", OCX_NO_DESKTOP_HANDOFF: "0", OCX_NODE_LAUNCH_CONTEXT: "forged", ANTHROPIC_API_KEY: "fixture-user-key", OPENCODEX_BUN_PATH: join(home, "missing-bun") };
  return { home, target, env };
}
const posixTest = process.platform === "win32" ? test.skip : test;
const launcher = repoPath("bin", "ocx.mjs");
posixTest("real Node launcher regenerates proof, forwards argv/stdin, mirrors exit and bypasses Bun lookup", () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), context: JSON.parse(process.env.OCX_NODE_LAUNCH_CONTEXT), stdin: fs.readFileSync(0, 'utf8'), bypass: process.env.OCX_NO_DESKTOP_HANDOFF }));\nprocess.exit(23);\n`);
  chmodSync(fixture.target, 0o755);
  const result = spawnSync("node", [launcher, "claude", "a b", PREFIX + "old"], { env: fixture.env, input: "fixture stdin\n", encoding: "utf8", timeout: 5000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(23);
  const row = JSON.parse(result.stdout.trim());
  expect(row.stdin).toBe("fixture stdin\n"); expect(row.bypass).toBe("1");
  expect(row.argv.slice(1)).toEqual(["claude", "a b"]);
  expect(row.argv[0]).toBe(PREFIX + row.context.proof);
  expect(row.context.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(row.context.anthropicEnvSlots).toContain("ANTHROPIC_API_KEY");
  const argv = ["bun", "index.ts", ...row.argv];
  const capturedEnv = { OCX_NODE_LAUNCH_CONTEXT: JSON.stringify(row.context), ANTHROPIC_API_KEY: "fixture-user-key", ANTHROPIC_BASE_URL: "https://dotenv.invalid" };
  const captured = initializeNodeLauncherContext(argv, capturedEnv);
  expect(captured?.anthropicEnvSlots).toContain("ANTHROPIC_API_KEY");
  const config = { port: 10100, providers: {} } as Parameters<typeof buildNativeClaudeEnv>[0];
  const native = buildNativeClaudeEnv(config, capturedEnv);
  expect(native.ANTHROPIC_API_KEY).toBe("fixture-user-key");
  expect(native.ANTHROPIC_BASE_URL).toBeUndefined();
});
posixTest("real target disappearance resumes Bun; EACCES never resumes Bun", () => {
  const fixture = packageFixture();
  const absent = spawnSync("node", [launcher, "--version"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(absent.stderr).toContain("OPENCODEX_BUN_PATH");
  writeFileSync(fixture.target, "not executable"); chmodSync(fixture.target, 0o600);
  const denied = spawnSync("node", [launcher, "--version"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(denied.status).toBe(1); expect(denied.stderr).toContain("target-unusable"); expect(denied.stderr).not.toContain("OPENCODEX_BUN_PATH");
});
posixTest("real update-help is untouched; opt-out and bad record activate distinct paths", () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, "#!/usr/bin/env node\nconsole.log('desktop-picked'); process.exit(0);\n"); chmodSync(fixture.target, 0o755);
  const help = spawnSync("node", [launcher, "update", "--help"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(help.status).toBe(0); expect(help.stdout).toContain("Usage: ocx update"); expect(help.stdout).not.toContain("desktop-picked");
  const skipped = spawnSync("node", [launcher, "--version"], { env: { ...fixture.env, OCX_NO_DESKTOP_HANDOFF: "1" }, encoding: "utf8", timeout: 5000 });
  expect(skipped.stdout).not.toContain("desktop-picked"); expect(skipped.stderr).toContain("OPENCODEX_BUN_PATH");
  writeFileSync(join(fixture.home, ".opencodex-desktop", "cli.json"), "{");
  const invalid = spawnSync("node", [launcher, "--version"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(invalid.status).toBe(1); expect(invalid.stderr).toContain("record-invalid"); expect(invalid.stderr).not.toContain("OPENCODEX_BUN_PATH");
});
posixTest("real child terminating signal is mirrored by Node parent", () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n"); chmodSync(fixture.target, 0o755);
  const result = spawnSync("node", [launcher, "status"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(result.signal).toBe("SIGTERM");
});
posixTest("signal sent only to real launcher reaches its child and waits for child exit", async () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.exit(29));\nconsole.log(process.pid); setInterval(() => {}, 1000);\n"); chmodSync(fixture.target, 0o755);
  const child: ChildProcess = spawn("node", [launcher, "status"], { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let targetPid: number | undefined;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("fixture timeout")), 5000);
      child.once("error", reject); child.once("exit", resolve);
      child.stdout!.once("data", bytes => { targetPid = Number(String(bytes).trim()); child.kill("SIGTERM"); });
    });
    expect(code).toBe(29);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      if (targetPid && Number.isSafeInteger(targetPid)) { try { process.kill(targetPid, "SIGKILL"); } catch { /* exited */ } }
      child.kill("SIGKILL");
    }
  }
});
test("launcher source anchors preserve exceptions before handoff and handoff before repair/resolver", () => {
  const source = readFileSync(launcher, "utf8");
  const hook = source.indexOf("const desktopPlan =");
  expect(hook).toBeGreaterThan(source.indexOf("const codexCliUpdateInspection ="));
  expect(hook).toBeLessThan(source.indexOf('if (process.argv[2] === "update" && installMethod === "mise")'));
  expect(hook).toBeLessThan(source.indexOf("const probe = bootRestoreProbe("));
  expect(hook).toBeLessThan(source.indexOf("const bunRuntime = resolveBun("));
  expect(source).toContain("const { launchProof, launchContext, inheritedEnv } = createNodeLaunchContext();");
  expect(source.match(/randomBytes\(32\)/g)).toHaveLength(1);
});

describe("shared Rust record fixtures and lexical path boundaries", () => {
  test("the whole Rust fixture directory maps to consumption state on every supported host", () => {
    const fixtureDir = repoPath("tests", "fixtures", "desktop-cli-record");
    const expected = {
      "valid-darwin.json": { state: "ready", host: "darwin" },
      "valid-win32.json": { state: "ready", host: "win32" },
      "notify-pending.json": { state: "ready", host: "win32" },
      "valid-linux.json": { state: "ready", host: "linux" },
      "disabled-tombstone.json": { state: "disabled", cleanupPending: false },
      "disabled-with-pending.json": { state: "disabled", cleanupPending: true },
      "pending-enabled.json": { state: "invalid", issue: "record-pending" },
      "first-pending.json": { state: "invalid", issue: "record-pending" },
      "appimage-kind.json": { state: "invalid", issue: "record-invalid" },
      "relative-target.json": { state: "invalid", issue: "record-invalid" },
      "dotdot-target.json": { state: "invalid", issue: "record-invalid" },
    } as const;
    const names = readdirSync(fixtureDir).sort();
    expect(names).toEqual(Object.keys(expected).sort());
    const recordPath = join(box(), "cli.json");
    for (const platform of ["darwin", "win32", "linux"] as const) {
      for (const name of names) {
        const want = expected[name as keyof typeof expected];
        writeFileSync(recordPath, readFileSync(join(fixtureDir, name)));
        const actual = readDesktopCliRecord({ recordPath, platform }, { checkAcl: () => true });
        if (want.state === "ready") {
          if (want.host === platform) {
            const fixture = JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
            expect(actual).toMatchObject({ state: "ready", record: {
              platform, kind: fixture.bundle.kind, cliExecutable: fixture.bundle.cliExecutable,
            } });
            if (actual.state === "ready") expect(Object.keys(actual.record).sort()).toEqual(["cliExecutable", "kind", "platform"]);
          } else {
            expect(actual).toMatchObject({ state: "invalid", issue: "record-invalid" });
          }
        } else {
          expect(actual).toMatchObject(want);
        }
      }
    }
  });

  test("path length counts Unicode code points and paths are not normalized before validation", () => {
    const recordPath = join(box(), "cli.json");
    const cases: [string, boolean][] = [
      ["/" + "x".repeat(4095), true],
      ["/" + "x".repeat(4096), false],
      ["/" + "😀".repeat(4095), true],
      ["/" + "😀".repeat(4096), false],
      ["/fixture/./ocx", false],
      ["/fixture/../ocx", false],
      ["/fixture/ocx/..", false],
      ["/fixture/ocx/.", false],
      ["/fixture/ocx\n", false],
      ["/fixture/ocx\r", false],
      ["/fixture/ocx\0", false],
      ["relative/ocx", false],
      ["/fixture/.../ocx", true],
      ["/fixture\\..\\ocx", true],
      ["//fixture//ocx", true],
    ];
    for (const [cliExecutable, accepted] of cases) {
      writeFileSync(recordPath, JSON.stringify({
        version: 1, enabled: true, bundle: { platform: "darwin", kind: "macos-app", cliExecutable },
      }));
      expect(readDesktopCliRecord({ recordPath, platform: "darwin" }, { checkAcl: () => true }).state).toBe(accepted ? "ready" : "invalid");
    }
  });

  test("Windows absolute paths match Rust drive and UNC rules exactly", () => {
    const recordPath = join(box(), "cli.json");
    const cases: [string, boolean][] = [
      ["C:\\App\\ocx.exe", true], ["C:/App/ocx.exe", true],
      ["\\\\server\\share\\ocx.exe", true], ["//server/share/ocx.exe", true],
      ["\\\\server", true], ["\\\\", true], ["//", true],
      ["\\ocx.exe", false], ["/ocx.exe", false], ["C:ocx.exe", false],
      ["1:/ocx.exe", false], ["C:\\App\\..\\ocx.exe", false], ["C:/App/./ocx.exe", false],
      ["C:\\App/../ocx.exe", false],
    ];
    for (const [cliExecutable, accepted] of cases) {
      writeFileSync(recordPath, JSON.stringify({
        version: 1, enabled: true, bundle: { platform: "win32", kind: "windows-install", cliExecutable },
      }));
      expect(readDesktopCliRecord({ recordPath, platform: "win32" }).state).toBe(accepted ? "ready" : "invalid");
    }
  });

  test("platform-kind pairs are closed and the 64 KiB bound accepts a padded valid record", () => {
    const recordPath = join(box(), "cli.json");
    const valid = { version: 1, enabled: true, bundle: { platform: "linux", kind: "linux-deb", cliExecutable: "/fixture/ocx" } };
    for (const kind of ["macos-app", "windows-install", "linux-appimage", "", null]) {
      writeFileSync(recordPath, JSON.stringify({ ...valid, bundle: { ...valid.bundle, kind } }));
      expect(readDesktopCliRecord({ recordPath, platform: "linux" })).toMatchObject({ issue: "record-invalid" });
    }
    writeFileSync(recordPath, JSON.stringify({ ...valid, bundle: { ...valid.bundle, platform: "freebsd" } }));
    expect(readDesktopCliRecord({ recordPath, platform: "freebsd" })).toMatchObject({ issue: "record-invalid" });
    const json = JSON.stringify(valid);
    writeFileSync(recordPath, json + " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES - Buffer.byteLength(json)));
    expect(readDesktopCliRecord({ recordPath, platform: "linux" }).state).toBe("ready");
    writeFileSync(recordPath, json + " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES - Buffer.byteLength(json) + 1));
    expect(readDesktopCliRecord({ recordPath, platform: "linux" })).toMatchObject({ issue: "record-too-large" });
  });
});

test("AM-8 spawn ENOENT resumes only after lstat also reports ENOENT", async () => {
  for (const synchronous of [false, true]) {
    for (const check of ["exists", "ENOENT", "EACCES", "ELOOP", "ENOTDIR"]) {
      let checked: string | undefined;
      const fake = fakeSpawn("ENOENT");
      const spawnChild = synchronous ? (() => { throw coded("ENOENT"); }) as typeof spawn : fake.run;
      const lstat = ((target: string) => {
        checked = target;
        if (check !== "exists") throw coded(check);
        return { isFile: () => true };
      }) as unknown as typeof lstatSync;
      const result = await runDesktopCliHandoff(
        { kind: "handoff", target: "/fixture/desktop/ocx" },
        { argv: [], env: {}, proof, context },
        { spawn: spawnChild, parent: fake.parent as unknown as NodeJS.Process, lstat },
      );
      expect(checked).toBe("/fixture/desktop/ocx");
      expect(result).toEqual(check === "ENOENT" ? { kind: "continue" } : { kind: "error", issue: "spawn-failed" });
      expect(fake.parent.eventNames()).toHaveLength(0);
    }
  }
});

posixTest("AM-8 an executable with a missing interpreter exits 127 without Bun fallback", () => {
  const fixture = packageFixture();
  writeFileSync(fixture.target, "#!" + join(fixture.home, "missing-interpreter") + "\nexit 0\n");
  chmodSync(fixture.target, 0o755);
  const result = spawnSync("node", [launcher, "--version"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(127);
  expect(result.stderr).toContain("Desktop CLI handoff failed (spawn-failed)");
  expect(result.stderr).not.toContain("OPENCODEX_BUN_PATH");
});

posixTest("AM-2 record refusal names the record, repair and exact bypass for every issue", () => {
  const fixture = packageFixture();
  const recordPath = join(fixture.home, ".opencodex-desktop", "cli.json");
  const cases = [
    ["record-invalid", "{"],
    ["record-too-large", " ".repeat(DESKTOP_CLI_RECORD_MAX_BYTES + 1)],
    ["record-pending", JSON.stringify({ version: 1, enabled: true, pending: {} })],
    ["record-unsafe", null],
  ] as const;
  for (const [issue, content] of cases) {
    rmSync(recordPath, { force: true });
    if (content === null) symlinkSync(recordPath, recordPath);
    else writeFileSync(recordPath, content);
    const result = spawnSync("node", [launcher, "--version"], { env: fixture.env, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "opencodex: OpenCodex Desktop's terminal-command record at " + recordPath +
      " could not be used (" + issue + "). Open OpenCodex Desktop to repair the terminal command, or run with OCX_NO_DESKTOP_HANDOFF=1.",
    );
    expect(result.stderr).not.toContain("OPENCODEX_BUN_PATH");
  }
});

posixTest("real --version opts out to the package version even with a broken record", () => {
  const fixture = packageFixture();
  writeFileSync(join(fixture.home, ".opencodex-desktop", "cli.json"), "{");
  const result = spawnSync("node", [launcher, "--version"], {
    env: { ...fixture.env, OPENCODEX_BUN_PATH: process.execPath, OCX_NO_DESKTOP_HANDOFF: "1" },
    encoding: "utf8", timeout: 10000,
  });
  const version = JSON.parse(readFileSync(repoPath("package.json"), "utf8")).version;
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(`opencodex ${version}`);
});

function safetyFixture() {
  const home = box();
  const directory = join(home, ".opencodex-desktop");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const recordPath = join(directory, "cli.json");
  writeFileSync(recordPath, JSON.stringify({
    version: 1, enabled: true, bundle: { platform: process.platform, kind: hostKind, cliExecutable: join(home, "ocx") },
  }));
  chmodSync(recordPath, 0o600);
  return { home, directory, recordPath };
}
function expectUnsafe(read: DesktopCliRecordRead): void {
  expect(read).toMatchObject({ state: "invalid", issue: "record-unsafe" });
  expect(planDesktopCliHandoff({ platform: "linux", argv: ["--version"], env: {}, recordRead: read }, {
    stat: (() => { throw new Error("unsafe record must not inspect or select a target"); }) as typeof stat,
  })).toEqual({ kind: "error", issue: "record-unsafe" });
}

posixTest("POSIX safety precedes JSON/disabled interpretation and accepts explicit 0700/0600", () => {
  const fixture = safetyFixture();
  expect(readDesktopCliRecord({ home: fixture.home }).state).toBe("ready");
  for (const value of ['{"version":1,"enabled":false}', "{"]) {
    writeFileSync(fixture.recordPath, value);
    chmodSync(fixture.recordPath, 0o666);
    expectUnsafe(readDesktopCliRecord({ home: fixture.home }));
    chmodSync(fixture.recordPath, 0o600);
  }
  chmodSync(fixture.directory, 0o777);
  expectUnsafe(readDesktopCliRecord({ home: fixture.home }));
});

posixTest("directory and record symlinks are refused without handoff", () => {
  for (const linked of ["directory", "record"]) {
    const fixture = safetyFixture();
    if (linked === "directory") {
      const moved = join(fixture.home, "moved-directory");
      renameSync(fixture.directory, moved);
      symlinkSync(moved, fixture.directory, "dir");
    } else {
      const moved = join(fixture.directory, "moved-record");
      renameSync(fixture.recordPath, moved);
      symlinkSync(moved, fixture.recordPath);
    }
    expectUnsafe(readDesktopCliRecord({ home: fixture.home }));
  }
});

posixTest("stat seam refuses foreign ownership for either path without requiring root", () => {
  for (const foreign of ["directory", "record"]) {
    const fixture = safetyFixture();
    expectUnsafe(readDesktopCliRecord({ home: fixture.home }, {
      lstat: path => {
        const info = lstatSync(path);
        if (path === (foreign === "directory" ? fixture.directory : fixture.recordPath)) info.uid += 1;
        return info;
      },
    }));
  }
});
const rootTest = process.platform !== "win32" && process.geteuid?.() === 0 ? test : test.skip;
if (process.platform === "win32" || process.geteuid?.() !== 0) console.log("SKIP real foreign-owner fixture: effective uid is not root; injected-owner cases still run.");
rootTest("root-only real foreign-owner directory and record are refused", () => {
  for (const foreign of ["directory", "record"]) {
    const fixture = safetyFixture();
    chownSync(foreign === "directory" ? fixture.directory : fixture.recordPath, 10001, -1);
    expectUnsafe(readDesktopCliRecord({ home: fixture.home }));
  }
});

posixTest("lstat to open replacement and every descriptor identity field fail closed", () => {
  const fixture = safetyFixture();
  let actualFlags = 0;
  expectUnsafe(readDesktopCliRecord({ home: fixture.home }, {
    open: (path, flags) => {
      actualFlags = flags;
      renameSync(path, join(fixture.directory, "old-record"));
      writeFileSync(path, '{"version":1,"enabled":false}');
      return openSync(path, flags);
    },
  }));
  expect(actualFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  expect(actualFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  for (const field of ["dev", "ino", "uid", "mode"] as const) {
    expectUnsafe(readDesktopCliRecord({ home: fixture.home }, {
      fstat: fd => { const info = fstatSync(fd); info[field] += 1; return info; },
    }));
  }
  expectUnsafe(readDesktopCliRecord({ home: fixture.home }, {
    open: () => { throw coded("ENOENT"); },
  }));
});

posixTest("a FIFO record and a FIFO replacement return refusals before the 2-second deadline", () => {
  for (const replaceAtOpen of [false, true]) {
    const fixture = safetyFixture();
    if (!replaceAtOpen) {
      rmSync(fixture.recordPath);
      const created = spawnSync("mkfifo", ["-m", "600", fixture.recordPath], { encoding: "utf8", timeout: 1000 });
      expect(created.error).toBeUndefined();
      expect(created.status).toBe(0);
    }
    const script = [
      'import { readDesktopCliRecord } from ' + JSON.stringify(pathToFileURL(repoPath("src", "lib", "desktop-cli-record.mjs")).href) + ';',
      'import { openSync, renameSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      'const path = ' + JSON.stringify(fixture.recordPath) + ';',
      'const deps = ' + replaceAtOpen + ' ? { open: (path, flags) => {',
      'renameSync(path, path + ".old");',
      'const made = spawnSync("mkfifo", ["-m", "600", path], { timeout: 1000 });',
      'if (made.error || made.status !== 0) throw new Error("mkfifo failed");',
      'return openSync(path, flags); } } : {};',
      'console.log(JSON.stringify(readDesktopCliRecord({ recordPath: path }, deps)));',
    ].join("\n");
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 2000 });
    expect(result.error).toBeUndefined(); // Timeout termination is a failure, never refusal evidence.
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: "invalid", issue: "record-unsafe" });
  }
});

posixTest("macOS ACL seam rejects entries and failed checks before JSON interpretation", () => {
  const fixture = safetyFixture();
  writeFileSync(fixture.recordPath, '{"version":1,"enabled":false}');
  for (const checkAcl of [() => false, () => { throw coded("ETIMEDOUT"); }, () => { throw coded("ENOENT"); }]) {
    expectUnsafe(readDesktopCliRecord({ recordPath: fixture.recordPath, platform: "darwin" }, { checkAcl }));
  }
  let checked: string[] = [];
  expect(readDesktopCliRecord({ recordPath: fixture.recordPath, platform: "darwin" }, {
    checkAcl: (directory, path) => { checked = [directory, path]; return true; },
  }).state).toBe("disabled");
  expect(checked).toEqual([fixture.directory, fixture.recordPath]);
});
const macTest = process.platform === "darwin" ? test : test.skip;
if (process.platform !== "darwin") console.log("SKIP real macOS extended ACL fixture: chmod +a is only available on macOS.");
macTest("macOS real extended ACLs on a 0700 directory or 0600 record are refused", () => {
  for (const aclTarget of ["directory", "record"]) {
    const fixture = safetyFixture();
    const path = aclTarget === "directory" ? fixture.directory : fixture.recordPath;
    const added = spawnSync("/bin/chmod", ["+a", "everyone allow read", path], { encoding: "utf8", timeout: 1000 });
    expect(added.error).toBeUndefined();
    expect(added.status).toBe(0);
    expect(lstatSync(path).mode & 0o077).toBe(0);
    expectUnsafe(readDesktopCliRecord({ home: fixture.home }));
  }
});
