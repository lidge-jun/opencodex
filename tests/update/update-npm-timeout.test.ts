import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { launcherUsableAfterNpmUpdate, transactionalNpmUpdateAsync, UPDATE_OWNER_MARKER } from "../../src/update/transactional-install.mjs";
import { npmInvocation } from "../../src/update/npm-invocation.mjs";
import { runNpmInstall } from "../../src/update/npm-install.mjs";
import { fixturePath, repoPath } from "../helpers/repo-root";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-npm-timeout-é-업데이트-"));
  const packageDir = join(root, "opencodex");
  mkdirSync(packageDir);
  writeFileSync(join(packageDir, "package.json"), '{"version":"1.0.0"}');
  return { root, packageDir };
}

test("timeout preserves ETIMEDOUT and permits recovery through the untouched launcher", async () => {
  const { root, packageDir } = fixture();
  let stage = "";
  try {
    const result = await transactionalNpmUpdateAsync({
      packageDir, pkgName: "@fixture/opencodex", tag: "latest",
      runNpm: (args: string[]) => {
        stage = args[args.indexOf("--prefix") + 1]!;
        return { status: null, error: Object.assign(new Error("npm install exceeded 180000 ms"), { code: "ETIMEDOUT" }), processTreeExited: true };
      },
    });
    expect(result.error).toContain("ETIMEDOUT");
    expect(result.error).toContain("180000 ms");
    expect(result.phase).toBe("stage");
    expect(launcherUsableAfterNpmUpdate(result)).toBe(true);
    expect(existsSync(stage)).toBe(false);
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe('{"version":"1.0.0"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32").each(["tree", "orphan"])("Windows cmd-wrapped %s is joined before first stage removal", async mode => {
  const { root, packageDir } = fixture();
  const receipt = join(root, "ready.json");
  const shimDir = join(root, "npm shim");
  mkdirSync(shimDir);
  const node = Bun.which("node")!;
  expect(node).toBeTruthy();
  writeFileSync(join(shimDir, "npm.cmd"), `@echo off\r\n"${node}" "${fixturePath("npm-timeout-tree.mjs")}" %*\r\n`, "utf8");
  let pids: number[] = [];
  let removals = 0;
  try {
    const result = await transactionalNpmUpdateAsync({
      packageDir, pkgName: "@fixture/opencodex", tag: "latest",
      runNpm: async (args: string[]) => {
        const stage = args[args.indexOf("--prefix") + 1]!;
        const env = { ...process.env, PATH: shimDir, PATHEXT: ".CMD" };
        const invocation = npmInvocation([mode, stage, receipt], "win32", env, { cwd: packageDir });
        expect(invocation?.file.toLowerCase()).toEndWith("system32\\cmd.exe");
        const install = await runNpmInstall(invocation, { env, timeoutMs: 2000 });
        // Receipt is a handshake from the leaf after acquiring its cwd/file.
        // A startup failure cannot masquerade as a passing timeout test.
        expect(existsSync(receipt)).toBe(true);
        pids = JSON.parse(readFileSync(receipt, "utf8")).pids;
        expect(install.processTreeExited).toBe(true);
        expect(install.error?.code).toBe("ETIMEDOUT");
        return install;
      },
      deps: { rm: (path: string, options: { recursive: true; force: true }) => {
        removals++;
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        // No retry: the leaf's stage cwd has actually been released.
        rmSync(path, options);
      } },
    });
    expect(removals).toBeGreaterThan(0);
    expect(result.error).toContain("ETIMEDOUT");
    expect(launcherUsableAfterNpmUpdate(result)).toBe(true);
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe('{"version":"1.0.0"}');
  } finally {
    // Only fixture-owned PIDs; clean up even when testing an unfixed runner.
    if (existsSync(receipt)) {
      for (const pid of JSON.parse(readFileSync(receipt, "utf8")).pids.reverse()) {
        try { process.kill(pid, 0); } catch { continue; }
        spawnSync(join(process.env.SystemRoot!, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test.skipIf(process.platform !== "win32").each([["success", 0], ["failure", 23]] as const)("installer preserves %s exit status", async (mode, status) => {
  const result = await runNpmInstall({ file: Bun.which("node")!, args: [fixturePath("npm-timeout-tree.mjs"), mode], options: {} });
  expect(result.status).toBe(status);
  expect(result.processTreeExited).toBe(true);
  expect(result.error).toBeFalsy();
}, 20000);

test.skipIf(process.platform !== "win32")("spawn failure is explicit and has no running installer", async () => {
  const result = await runNpmInstall({ file: repoPath(".tmp", "missing-npm-executable"), args: [], options: {} });
  expect(result.status).toBeNull();
  expect(result.processTreeExited).toBe(true);
  expect(result.error).toBeTruthy();
}, 20000);

test.each([null, 0])("unproven process-tree exit with status %s retains stage and marker", async status => {
  const { root, packageDir } = fixture();
  let stage = "";
  const removals: string[] = [];
  const logs: string[] = [];
  try {
    const result = await transactionalNpmUpdateAsync({
      packageDir, pkgName: "@fixture/opencodex", tag: "latest", log: (line: string) => logs.push(line),
      runNpm: (args: string[]) => {
        stage = args[args.indexOf("--prefix") + 1]!;
        writeFileSync(join(stage, "still-owned"), "partial download");
        return { status, error: Object.assign(new Error("termination could not be confirmed"), { code: "ETIMEDOUT" }), processTreeExited: false };
      },
      deps: { rm: (path: string) => removals.push(path) },
    });
    expect(removals).toEqual([]);
    expect(existsSync(join(stage, UPDATE_OWNER_MARKER))).toBe(true);
    expect(existsSync(join(stage, "still-owned"))).toBe(true);
    expect(result.phase).toBe("stage");
    expect(logs.join("\n")).toContain("process-tree exit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("async staging requires affirmative exit evidence, even on status zero", async () => {
  const { root, packageDir } = fixture();
  let stage = "";
  try {
    const result = await transactionalNpmUpdateAsync({ packageDir, pkgName: "@fixture/opencodex", tag: "latest",
      runNpm: (args: string[]) => { stage = args[args.indexOf("--prefix") + 1]!; return { status: 0 }; },
    });
    expect(result.phase).toBe("stage");
    expect(result.error).toContain("EINSTALLJOIN");
    expect(existsSync(join(stage, UPDATE_OWNER_MARKER))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
