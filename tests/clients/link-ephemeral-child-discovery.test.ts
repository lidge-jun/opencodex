import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { classifySyncResult, classifyVersionProbe } from "../../src/cli/sync-fanout";
import { remoteOcxArgv, remotePinnedSyncArgv } from "../../src/link/ssh-argv";
import { POWERSHELL_ENCODED_MAX, windowsOcxArgv, windowsPinnedSyncArgv, windowsScriptHelperSource } from "../../src/link/remote-windows";

function writeExecScript(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function sandboxRemoteScript(script: string, root: string): string {
  return script
    .replaceAll("/Applications/OpenCodex.app/Contents/MacOS/ocx", join(root, "Apps/OpenCodex.app/Contents/MacOS/ocx"))
    .replaceAll("/usr/bin/ocx", join(root, "sys-usr/bin/ocx"))
    .replaceAll("/opt/homebrew/bin", join(root, "sys-homebrew/bin"))
    .replaceAll("/usr/local/bin", join(root, "sys-local/bin"));
}

describe("ephemeral ocx-child SSH discovery and sync fan-out argv", () => {
  test("OCX_PROTOCOL_COMPAT_VERSION in native/ocx-child satisfies >= 2.93.0 fan-out gate", () => {
    const libRs = readFileSync(repoPath("native", "ocx-child", "src", "lib.rs"), "utf8");
    const match = /OCX_PROTOCOL_COMPAT_VERSION:\s*&str\s*=\s*"([^"]+)"/.exec(libRs);
    expect(match).not.toBeNull();
    expect(classifyVersionProbe(`opencodex ${match![1]!}`)).toBeNull();
  });

  test("Windows remoteOcxArgv and windowsPinnedSyncArgv stay below POWERSHELL_ENCODED_MAX and preserve OcxJob containment", () => {
    const execArgv = windowsOcxArgv(["connect", "--link", "--key-stdin", "--tunnel-port", "22222", "--link-id", "lnk_0123456789abcdef"]);
    const syncArgv = windowsPinnedSyncArgv("lnk_0123456789abcdef");
    expect(execArgv[5]!.length).toBeLessThan(POWERSHELL_ENCODED_MAX);
    expect(syncArgv[5]!.length).toBeLessThan(POWERSHELL_ENCODED_MAX);
    const decodedExec = Buffer.from(execArgv[5]!, "base64").toString("utf16le");
    expect(windowsScriptHelperSource(decodedExec)).toContain("CreateJobObjectW");
  });

  test.skipIf(process.platform === "win32")("POSIX remoteOcxArgv prefers runnable full ocx and falls back to ocx-child when full ocx is absent or broken", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ocx-child-disc-"));
    try {
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
        env: { HOME: home, PATH: `/usr/bin:/bin:${pathBin}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(both.exitCode).toBe(0);
      expect(both.stdout.toString().trim()).toBe("selected:full-ocx:config show --json");

      writeExecScript(join(home, ".local", "bin", "ocx"), "exit 1");
      const fallbackCache = Bun.spawnSync([...argv], {
        env: { HOME: home, PATH: `/usr/bin:/bin:${pathBin}` },
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
        env: { HOME: home2, PATH: `${pathBin}:/usr/bin:/bin` },
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
});
