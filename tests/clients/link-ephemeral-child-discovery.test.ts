import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { classifySyncResult, classifyVersionProbe } from "../../src/cli/sync-fanout";
import { remoteOcxArgv, remotePinnedSyncArgv } from "../../src/link/ssh-argv";
import { powershellArgv, POWERSHELL_ENCODED_MAX, windowsOcxArgv, windowsPinnedSyncArgv, windowsScriptHelperSource } from "../../src/link/remote-windows";

function writeExecScript(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function createPrivateShellPath(root: string): string {
  const utilDir = join(root, "private-utils");
  mkdirSync(utilDir, { recursive: true });
  for (const util of ["sh", "uname", "mktemp", "rm", "sleep", "kill", "wc", "cat", "printf", "awk"]) {
    for (const sysDir of ["/bin", "/usr/bin"]) {
      const candidate = join(sysDir, util);
      if (existsSync(candidate)) {
        symlinkSync(candidate, join(utilDir, util));
        break;
      }
    }
  }
  return utilDir;
}

function sandboxRemoteScript(script: string, root: string): string {
  return script
    .replaceAll("/Applications/OpenCodex.app/Contents/MacOS/ocx", join(root, "Apps/OpenCodex.app/Contents/MacOS/ocx"))
    .replaceAll("/usr/bin/ocx", join(root, "sys-usr/bin/ocx"))
    .replaceAll("/opt/homebrew/bin", join(root, "sys-homebrew/bin"))
    .replaceAll("/usr/local/bin", join(root, "sys-local/bin"));
}

function inflateWindowsScript(encoded: string): string {
  const outer = Buffer.from(encoded, "base64").toString("utf16le");
  const match = /\$ocxPacked='([^']+)'/.exec(outer);
  if (!match) return outer;
  return inflateRawSync(Buffer.from(Array.from(match[1]!, ch => ch.charCodeAt(0) - 256))).toString("utf8");
}

describe("ephemeral ocx-child SSH discovery and sync fan-out argv", () => {
  test("OCX_PROTOCOL_COMPAT_VERSION in native/ocx-child satisfies >= 2.93.0 fan-out gate", () => {
    const libRs = readFileSync(repoPath("native", "ocx-child", "src", "lib.rs"), "utf8");
    const match = /OCX_PROTOCOL_COMPAT_VERSION:\s*&str\s*=\s*"([^"]+)"/.exec(libRs);
    expect(match).not.toBeNull();
    expect(classifyVersionProbe(`opencodex ${match![1]!}`)).toBeNull();
  });

  test("Windows remoteOcxArgv and windowsPinnedSyncArgv stay below POWERSHELL_ENCODED_MAX, preserve OcxJob, and order ocx.exe vs ocx-child.exe by state.json", () => {
    const execArgv = windowsOcxArgv(["connect", "--link", "--key-stdin", "--tunnel-port", "22222", "--link-id", "lnk_0123456789abcdef"]);
    const syncArgv = windowsPinnedSyncArgv("lnk_0123456789abcdef");
    expect(execArgv[5]!.length).toBeLessThan(POWERSHELL_ENCODED_MAX);
    expect(syncArgv[5]!.length).toBeLessThan(POWERSHELL_ENCODED_MAX);
    const decodedExec = Buffer.from(execArgv[5]!, "base64").toString("utf16le");
    expect(windowsScriptHelperSource(decodedExec)).toContain("CreateJobObjectW");
    for (const inflated of [inflateWindowsScript(execArgv[5]!), inflateWindowsScript(syncArgv[5]!)]) {
      const ocxIdx = inflated.indexOf("Get-Command ocx.exe");
      const childIdx = inflated.indexOf("Get-Command ocx-child.exe");
      expect(ocxIdx).toBeGreaterThan(0);
      expect(childIdx).toBeGreaterThan(ocxIdx);
      expect(inflated).toContain("$r=if($env:HOME){$env:HOME}elseif($u){$u}else{\".\"};$h=if($env:OPENCODEX_HOME){$env:OPENCODEX_HOME}else{\"$r\\.opencodex\"}");
      expect(inflated).toContain("[IO.File]::Exists(\"$h\\child\\state.json\")){$k+$f}else{$f+$k}");
    }
  });

  test.skipIf(process.platform === "win32")("POSIX remoteOcxArgv prefers full ocx when detached, prefers ocx-child when child/state.json exists, and falls back to ocx-child", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ocx-child-disc-"));
    try {
      const utilDir = createPrivateShellPath(scratch);
      const home = join(scratch, "home");
      const pathBin = join(scratch, "path-bin");
      mkdirSync(home, { recursive: true });
      mkdirSync(pathBin, { recursive: true });

      writeExecScript(
        join(home, ".local", "bin", "ocx"),
        'if [ "$1" = "--version" ]; then echo "opencodex 2.98.0"; exit 0; fi; echo "selected:full-ocx:$*"',
      );
      writeExecScript(
        join(home, ".cache", "opencodex", "bin", "ocx-child"),
        'if [ "$1" = "--version" ]; then echo "opencodex 2.98.0"; exit 0; fi; echo "selected:ocx-child:$*"',
      );
      const argv = remoteOcxArgv(["config", "show", "--json"], "posix");
      argv[2] = sandboxRemoteScript(argv[2]!, scratch);
      const both = Bun.spawnSync([...argv], {
        env: { HOME: home, PATH: `${utilDir}:${pathBin}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(both.exitCode).toBe(0);
      expect(both.stdout.toString().trim()).toBe("selected:full-ocx:config show --json");

      // Active ocx-child enrollment (`~/.opencodex/child/state.json` present) prefers ocx-child even when full ocx is present!
      mkdirSync(join(home, ".opencodex", "child"), { recursive: true });
      writeFileSync(join(home, ".opencodex", "child", "state.json"), "{}");
      const attachedPrefersChild = Bun.spawnSync([...argv], {
        env: { HOME: home, PATH: `${utilDir}:${pathBin}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(attachedPrefersChild.exitCode).toBe(0);
      expect(attachedPrefersChild.stdout.toString().trim()).toBe("selected:ocx-child:config show --json");

      // Remove state.json and break full ocx -> falls back to ocx-child
      writeExecScript(join(home, ".local", "bin", "ocx"), "exit 1");
      const fallbackCache = Bun.spawnSync([...argv], {
        env: { HOME: home, OPENCODEX_HOME: join(scratch, "empty-ocx"), PATH: `${utilDir}:${pathBin}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(fallbackCache.exitCode).toBe(0);
      expect(fallbackCache.stdout.toString().trim()).toBe("selected:ocx-child:config show --json");

      const home2 = join(scratch, "home2");
      mkdirSync(home2, { recursive: true });
      writeExecScript(
        join(pathBin, "ocx-child"),
        'if [ "$1" = "--version" ]; then echo "opencodex 2.98.0"; exit 0; fi; echo \'{"schema":"ocx.sync.fanout/1","home":{"state":"synced","exit":0},"fanout":{"state":"not-applicable","reason":null},"children":[]}\'',
      );
      const syncCmd = remotePinnedSyncArgv("lnk_0123456789abcdef", "posix");
      syncCmd[2] = sandboxRemoteScript(syncCmd[2]!, scratch);
      const syncRun = Bun.spawnSync([...syncCmd], {
        env: { HOME: home2, PATH: `${pathBin}:${utilDir}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(syncRun.exitCode).toBe(0);
      expect(classifySyncResult({
        code: syncRun.exitCode,
        stdout: syncRun.stdout.toString(),
        stderr: syncRun.stderr.toString(),
      })).toEqual({ state: "synced", reason: null });
    } finally {
      removeTreeWithRetry(scratch);
    }
  });

  test.skipIf(process.platform !== "win32")("Windows execution selects ocx-child.exe when HOME/.opencodex/child/state.json exists and ocx.exe when state.json is only under USERPROFILE", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ocx-child-win-disc-"));
    try {
      const userProfile = join(scratch, "user-profile");
      const altHome = join(scratch, "alt-home");
      mkdirSync(join(userProfile, ".local", "bin"), { recursive: true });
      mkdirSync(join(userProfile, ".cache", "opencodex", "bin"), { recursive: true });
      mkdirSync(altHome, { recursive: true });
      const compileExe = async (outPath: string, tag: string) => {
        const cs = `using System; class P { static int Main(string[] a) { if (a.Length > 0 && a[0] == "--version") { Console.WriteLine("opencodex 2.98.0"); return 0; } Console.WriteLine("${tag}:" + String.Join("|", a)); return 0; } }`;
        const p = Bun.spawn(powershellArgv(`Add-Type -TypeDefinition '${cs.replaceAll("'", "''")}' -OutputAssembly '${outPath.replaceAll("'", "''")}' -OutputType ConsoleApplication`), { stdout: "pipe", stderr: "pipe" });
        expect(await p.exited).toBe(0);
      };
      await compileExe(join(userProfile, ".local", "bin", "ocx.exe"), "full-ocx");
      await compileExe(join(userProfile, ".cache", "opencodex", "bin", "ocx-child.exe"), "ocx-child");
      const psPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
      const runCmd = async (argv: string[]) => {
        const env: Record<string, string | undefined> = { ...process.env, HOME: altHome, USERPROFILE: userProfile, LOCALAPPDATA: userProfile, ProgramFiles: userProfile, PATH: psPath };
        delete env.OPENCODEX_HOME;
        const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
        const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
        return { code, out: out.replaceAll("\r\n", "\n").trim() };
      };
      // 1. State exists only under USERPROFILE -> HOME wins, so detached precedence picks full ocx.exe
      mkdirSync(join(userProfile, ".opencodex", "child"), { recursive: true });
      writeFileSync(join(userProfile, ".opencodex", "child", "state.json"), "{}");
      expect(await runCmd(windowsOcxArgv(["status"]))).toEqual({ code: 0, out: "full-ocx:status" });
      expect((await runCmd(windowsPinnedSyncArgv("lnk_0123456789abcdef"))).out).toContain("full-ocx:sync|--expect-link|lnk_0123456789abcdef|--json");
      // 2. State exists under HOME -> active ocx-child enrollment wins
      mkdirSync(join(altHome, ".opencodex", "child"), { recursive: true });
      writeFileSync(join(altHome, ".opencodex", "child", "state.json"), "{}");
      expect(await runCmd(windowsOcxArgv(["status"]))).toEqual({ code: 0, out: "ocx-child:status" });
      expect((await runCmd(windowsPinnedSyncArgv("lnk_0123456789abcdef"))).out).toContain("ocx-child:sync|--expect-link|lnk_0123456789abcdef|--json");
    } finally {
      removeTreeWithRetry(scratch);
    }
  }, 30000);
});
