import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { assertNotRealHomeUnderTest } from "../../src/lib/test-home-guard";
import { encodeOrchestratedExpect } from "../../src/update/orchestrated-session.mjs";

test("authorized child reaches Bun update preflight while internal flags without authorization are rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-child-entry-"));
  const home = join(root, "home"), codex = join(root, "codex"), result = join(root, "result.json");
  mkdirSync(home); mkdirSync(codex); assertNotRealHomeUnderTest(home);
  const expectValue = encodeOrchestratedExpect({ home, cliRoot: repoPath(), servingRoot: null, runtimePid: null, planToken: "a".repeat(43) });
  const args = ["update", "--version", "99.0.0", "--orchestrated-expect", expectValue, "--orchestrated-result", result];
  const run = async (authorized: boolean) => {
    const proc = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
        OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(),
        OCX_UPDATE_ORCHESTRATED_CHILD: authorized ? "1" : "0" } });
    return { stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text(), code: await proc.exited };
  };
  try {
    const rejected = await run(false);
    expect(rejected.code).toBe(64); expect(JSON.parse(rejected.stdout)).toEqual({ error: "usage" }); expect(existsSync(result)).toBe(false);
    const child = await run(true);
    expect(child.code).toBe(1);
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ phase: "preflight" });
    expect(JSON.parse(readFileSync(join(home, "update-orchestrated.json"), "utf8")).phase).toBe("failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test.skipIf(process.platform === "win32")("Bun-global apply runs the real child with the plan's exact target", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-bun-global-"));
  const home = join(root, "home"), ocxHome = join(home, ".opencodex"), path = join(root, "path");
  const pkg = join(home, ".bun/install/global/node_modules/@bitkyc08/opencodex"), log = join(root, "commands");
  mkdirSync(pkg, { recursive: true }); mkdirSync(ocxHome, { recursive: true }); mkdirSync(path);
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({ port: 1, hostname: "127.0.0.1" }));
  cpSync(repoPath("src"), join(pkg, "src"), { recursive: true });
  cpSync(repoPath("bin"), join(pkg, "bin"), { recursive: true });
  const manifest = JSON.parse(readFileSync(repoPath("package.json"), "utf8")); manifest.version = "2.0.0";
  writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
  symlinkSync(repoPath("node_modules"), join(pkg, "node_modules"));
  writeFileSync(join(path, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OCX_FIXTURE_LOG"\ncase "$*" in *dist.integrity*) printf 'sha512-YWJj\\n';; *) if [ -e "$OCX_FIXTURE_PKG/tag-queried" ]; then printf '2.2.0\\n'; else : > "$OCX_FIXTURE_PKG/tag-queried"; printf '2.1.0\\n'; fi;; esac\n`);
  chmodSync(join(path, "npm"), 0o755);
  writeFileSync(join(path, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OCX_FIXTURE_LOG"\nexec '${process.execPath}' -e 'const fs=require("node:fs");const p=process.env.OCX_FIXTURE_PKG+"/package.json";const m=JSON.parse(fs.readFileSync(p,"utf8"));m.version="2.1.0";fs.writeFileSync(p,JSON.stringify(m));'\n`);
  chmodSync(join(path, "bun"), 0o755);
  const proc = Bun.spawn([process.execPath, join(pkg, "src/cli/index.ts"), "update", "--yes", "--json"], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome,
      CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: `${path}:/usr/bin:/bin`,
      OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_FIXTURE_LOG: log, OCX_FIXTURE_PKG: pkg },
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr, stdout }).toMatchObject({ code: 0 });
    expect(JSON.parse(stdout)).toMatchObject({ schema: "ocx.update.result/1", applied: true, healthy: true, toVersion: "2.1.0" });
    expect(readFileSync(log, "utf8")).toContain("add -g @bitkyc08/opencodex@2.1.0");
    expect(readFileSync(log, "utf8").match(/@latest version/g)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version).toBe("2.1.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  writeFileSync(join(path, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${npmLog}'\nprintf '99.0.0\\n'\n`); chmodSync(join(path, "npm"), 0o755);
  const nodeCommand = Bun.which("node"); if (!nodeCommand) throw Error("Node required");
  const node = spawnSync(nodeCommand, ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
  if (!node) throw Error("Node executable could not be resolved");
  const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome, CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: path, OCX_TEST_HOME_GUARD: "1", OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OPENCODEX_CODEX_SHIM_AUTO_RESTORE: "1" };
  const launch = async () => {
    const child = Bun.spawn([node, join(pkg, "bin", "ocx.mjs"), "update", "--plan", "--json", "--version", "99.0.0"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    return { stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), code: await child.exited };
  };
  try {
    const first = await launch();
    expect(first.code).toBe(0);
    expect({ stderr: first.stderr, npmLog: existsSync(npmLog) ? readFileSync(npmLog, "utf8") : "missing" }).toMatchObject({ npmLog: expect.stringContaining("@bitkyc08/opencodex@99.0.0") });
    expect(first.stderr).not.toContain("auto-restore");
    expect(JSON.parse(first.stdout)).toMatchObject({ installer: "npm", targetVersion: "99.0.0", canApply: true });
    expect(readFileSync(npmLog, "utf8")).toContain("@bitkyc08/opencodex@99.0.0");
    rmSync(join(pkg, "node_modules", "bun"));
    const missing = await launch();
    expect(missing.code).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ installer: "npm", reason: "plan-unavailable", canApply: false });
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
