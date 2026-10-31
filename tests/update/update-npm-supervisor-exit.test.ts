import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { transactionalNpmUpdateAsync, UPDATE_OWNER_MARKER } from "../../src/update/transactional-install.mjs";
import type { runNpmInstall } from "../../src/update/npm-install.mjs";
import { fixturePath, repoPath } from "../helpers/repo-root";

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};
async function until(predicate: () => boolean, budget = 2000) {
  const deadline = Date.now() + budget;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  return predicate();
}

async function runner(root: string, transform: (source: string) => string): Promise<typeof runNpmInstall> {
  // Private copies expose precise crash/API-failure points without production switches.
  const helper = join(root, "supervisor.ps1");
  writeFileSync(helper, transform(readFileSync(repoPath("src/update/npm-install-job.ps1"), "utf8")), "utf8");
  const source = readFileSync(repoPath("src/update/npm-install.mjs"), "utf8");
  const anchor = 'const helper = join(dirname(fileURLToPath(import.meta.url)), "npm-install-job.ps1");';
  expect(source.split(anchor)).toHaveLength(2);
  return (await import("data:text/javascript;base64," + Buffer.from(source.replace(anchor, `const helper = ${JSON.stringify(helper)};`).replaceAll('"./mutation-guard.mjs"', JSON.stringify(pathToFileURL(repoPath("src/update/mutation-guard.mjs")).href))).toString("base64"))).runNpmInstall;
}

test.skipIf(process.platform !== "win32").each(["created", "tree"])("abrupt supervisor exit at %s kills installer and retains unproven stage", async point => {
  const root = mkdtempSync(join(tmpdir(), "ocx-supervisor-exit-"));
  const packageDir = join(root, "opencodex");
  const receipt = join(root, "created.json");
  const leafReceipt = join(root, "leaf.json");
  mkdirSync(packageDir);
  writeFileSync(join(packageDir, "package.json"), '{"version":"1.0.0"}', "utf8");
  let stage = "";
  let pids: number[] = [];
  let supervisor = 0;
  let removals = 0;
  let pending: ReturnType<typeof transactionalNpmUpdateAsync> | undefined;
  try {
    const install = await runner(root, source => {
      const anchor = point === "created" ? "started = true; result.processTreeExited = false;" : "Require(ResumeThread(process.thread) != UInt32.MaxValue);";
      expect(source.split(anchor)).toHaveLength(2);
      const receipt64 = Buffer.from(receipt, "utf16le").toString("base64");
      return source.replace(anchor, `${anchor}
            System.IO.File.WriteAllText(System.Text.Encoding.Unicode.GetString(Convert.FromBase64String("${receipt64}")),
                "{\\"supervisor\\":" + Process.GetCurrentProcess().Id + ",\\"root\\":" + process.pid + "}");
            Thread.Sleep(Timeout.Infinite);`);
    });
    pending = transactionalNpmUpdateAsync({ packageDir, pkgName: "@fixture/opencodex", tag: "latest",
      runNpm: (args: string[]) => {
        stage = args[args.indexOf("--prefix") + 1]!;
        return install({ file: Bun.which("node")!, args: [fixturePath("npm-timeout-tree.mjs"), "tree", stage, leafReceipt], options: {} }, { authorizeMutation: () => true });
      }, deps: { rm: () => { removals++; } },
    });
    expect(await until(() => existsSync(receipt), 10000), "CreateProcess handshake").toBe(true);
    const created = JSON.parse(readFileSync(receipt, "utf8"));
    supervisor = created.supervisor;
    pids = [created.root];
    if (point === "tree") {
      expect(await until(() => existsSync(leafReceipt), 10000), "installer leaf handshake").toBe(true);
      pids = [...new Set([...pids, ...JSON.parse(readFileSync(leafReceipt, "utf8")).pids])] as number[];
      expect(pids.length).toBeGreaterThanOrEqual(3);
    }
    expect(pids.every(alive)).toBe(true);
    // Hold process handles before the kill and wait for kernel exit signals.
    // Terminate ONLY the supervisor: taskkill /T would mask a Job membership bug.
    const killer = join(root, "kill-supervisor.ps1");
    writeFileSync(killer, `param([int]$Supervisor, [string]$Pids)
$ErrorActionPreference = 'Stop'
$watched = @($Pids.Split(',') | ForEach-Object { [Diagnostics.Process]::GetProcessById([int]$_) })
foreach ($entry in $watched) { $null = $entry.Handle }
$owner = [Diagnostics.Process]::GetProcessById($Supervisor)
$owner.Kill()
$owner.WaitForExit()
$exited = $true
foreach ($entry in $watched) { if (!$entry.WaitForExit(2000)) { $exited = $false }; $entry.Dispose() }
$owner.Dispose()
if ($exited) { [Console]::Write('exited') } else { [Console]::Write('alive') }
`, "utf8");
    const killed = spawnSync(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-File", killer, "-Supervisor", String(supervisor), "-Pids", pids.join(",")],
      { windowsHide: true, encoding: "utf8", timeout: 10000 });
    expect(killed.status, killed.stderr).toBe(0);
    expect(existsSync(join(stage, UPDATE_OWNER_MARKER))).toBe(true);
    expect(removals).toBe(0);
    expect(killed.stdout).toBe("exited");
    expect(pids.filter(alive), "installer survived supervisor termination").toEqual([]);
    const result = await pending;
    expect(result.phase).toBe("stage");
    expect(result.error).toContain("EINSTALLJOIN");
    expect(existsSync(join(stage, UPDATE_OWNER_MARKER))).toBe(true);
    expect(removals).toBe(0);
  } finally {
    if (supervisor && alive(supervisor)) process.kill(supervisor);
    if (existsSync(leafReceipt)) pids.push(...JSON.parse(readFileSync(leafReceipt, "utf8")).pids);
    for (const pid of new Set(pids)) {
      if (alive(pid)) spawnSync(join(process.env.SystemRoot!, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
    await pending;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test.skipIf(process.platform !== "win32").each(["0x0002000D", "0x00020002"])("unsupported process attribute %s fails closed before installer creation", async attribute => {
  const root = mkdtempSync(join(tmpdir(), "ocx-job-unavailable-"));
  const launched = join(root, "installer-ran");
  try {
    const install = await runner(root, source => {
      const anchor = `new IntPtr(${attribute})`;
      expect(source.split(anchor)).toHaveLength(2);
      // Exercise a real kernel rejection of an unavailable attribute, not a fake result.
      return source.replace(anchor, "new IntPtr(0x0002FFFF)");
    });
    const result = await install({ file: Bun.which("node")!,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(launched)}, 'ran')`], options: {} }, { authorizeMutation: () => true });
    expect(result.status).toBeNull();
    expect(result.processTreeExited).toBe(true);
    expect(result.error?.code).toBe("EINSTALLJOIN");
    expect(result.error?.message).toContain("Windows 10 or later");
    expect(result.error?.message).toContain("installer was not started");
    expect(existsSync(launched)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
