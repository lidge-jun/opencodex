/**
 * Production composition of `ocx update --desktop` (#8246). The decisions live in
 * `./headless.ts`; this file only binds them to the network, the filesystem, Windows Installer,
 * the runtime record and the terminal.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import { getConfigDir } from "../config";
import { packageVersion } from "../lib/package-version";
import { findLiveProxy } from "../server/proxy-liveness";
import { requestBoundSystemRestart } from "../cli/system-restart-client";
import { inspectDesktopSupervision, trustedWindowsSystemDirectory, windowsProcessPair } from "../service/desktop-supervision.mjs";
import { tryAcquireUpdateSyncMutex } from "../update/sync-update-mutex.mjs";
import { acquireBounded, fetchAcquireTransport, realAcquireTimers } from "./acquire";
import { DRAIN_DEADLINE_MS, DRAIN_STOP_DEADLINE_ENV, parseDrainResult } from "./drain";
import { HEADLESS_EXIT, runHeadlessDesktopUpdate, type HeadlessResult } from "./headless";
import { windowsDesktopInstall, type WindowsDesktopInstall } from "./install";
import { MOVED_IMAGE_PATTERN, movedImageName, sameWindowsPath } from "./runtime";

export const HEADLESS_USAGE = "Usage: ocx update --desktop [--check] [--json]";
const RESTART_REQUEST_BUDGET_MS = 20_000;
const VERSION_PROBE_TIMEOUT_MS = 20_000;

export function parseHeadlessArgs(args: readonly string[]): { ok: true; check: boolean; json: boolean } | { ok: false } {
  let desktop = false, check = false, json = false;
  for (const arg of args) {
    if (arg === "--desktop" && !desktop) desktop = true;
    else if (arg === "--check" && !check) check = true;
    else if (arg === "--json" && !json) json = true;
    else return { ok: false };
  }
  return desktop ? { ok: true, check, json } : { ok: false };
}

/** `opencodex <version>` from a bounded `--version` run of the installed executable. */
export function parseVersionOutput(output: string): string | null {
  const match = /^opencodex (\S+)\s*$/m.exec(output);
  return match ? match[1]! : null;
}

async function readInstalledVersion(ocxExe: string): Promise<string | null> {
  try {
    const child = Bun.spawn([ocxExe, "--version"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? parseVersionOutput(output.slice(0, 4096)) : null;
  } catch {
    return null;
  }
}

/** The installed CLI's own `ocx stop --json`, as the app's update drain runs it. */
async function drainRuntime(install: WindowsDesktopInstall): Promise<{ ok: boolean; detail?: string }> {
  try {
    const child = Bun.spawn([install.ocxExe, "stop", "--json"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: DRAIN_DEADLINE_MS + 10_000,
      env: { ...process.env, [DRAIN_STOP_DEADLINE_ENV]: String(DRAIN_DEADLINE_MS - 3_000) },
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return parseDrainResult(output.slice(-65_536), code);
  } catch {
    return { ok: false, detail: "the installed ocx stop could not run" };
  }
}

function desktopSupervisor(pid: number): string | null {
  const evidence = inspectDesktopSupervision({ targetPid: pid });
  return evidence.kind === "desktop" && evidence.runtimePid === pid ? evidence.app : null;
}

const MOVEFILE_DELAY_UNTIL_REBOOT = 4;

/** Ask Windows to delete a still-mapped file at the next restart; best effort. */
function deleteAtReboot(path: string): void {
  try {
    const kernel32 = dlopen("kernel32.dll", { MoveFileExW: { args: ["ptr", "ptr", "u32"], returns: "i32" } });
    try {
      const wide = Buffer.from(`${path}\0`, "utf16le");
      kernel32.symbols.MoveFileExW(ptr(wide), null, MOVEFILE_DELAY_UNTIL_REBOOT);
    } finally { kernel32.close(); }
  } catch { /* the next run removes it instead */ }
}

function imageMover(install: WindowsDesktopInstall) {
  return {
    moveAsideOwnImage: () => {
      if (!sameWindowsPath(process.execPath, install.ocxExe)) return null;
      const moved = win32.join(install.dir, movedImageName(process.pid, Date.now()));
      renameSync(install.ocxExe, moved);
      return moved;
    },
    restoreOwnImage: (moved: string) => {
      if (existsSync(install.ocxExe)) return false;
      try { renameSync(moved, install.ocxExe); return true; } catch { return false; }
    },
    retireMovedImages: (current: string | null) => {
      let names: string[] = [];
      try { names = readdirSync(install.dir); } catch { return; }
      for (const name of names) {
        const path = win32.join(install.dir, name);
        if (!MOVED_IMAGE_PATTERN.test(name) || path === current) continue;
        try { rmSync(path); } catch { /* still mapped by a process; a later run or a restart removes it */ }
      }
      if (current) deleteAtReboot(current);
    },
  };
}

function print(result: HeadlessResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  const line = result.message;
  if (result.exitCode === HEADLESS_EXIT.ok) console.log(`✅ ${line}`);
  else console.error(`❌ ${line}`);
}

export async function runHeadlessDesktopUpdateCommand(args: readonly string[]): Promise<number> {
  const parsed = parseHeadlessArgs(args);
  if (!parsed.ok) {
    console.error(HEADLESS_USAGE);
    return HEADLESS_EXIT.usage;
  }
  const install = windowsDesktopInstall();
  if (!install) {
    console.error("ocx update --desktop updates a Windows OpenCodex Desktop installation and must be run with that installation's ocx.exe "
      + "(next to opencodex-desktop.exe). On other installations use 'ocx update', or the app's own updater (tray → Check for Updates).");
    return HEADLESS_EXIT.usage;
  }
  const log = (line: string) => (parsed.json ? console.error : console.log)(line);
  let mutex: ReturnType<typeof tryAcquireUpdateSyncMutex> | null = null;
  if (!parsed.check) {
    mutex = tryAcquireUpdateSyncMutex(getConfigDir(), "update");
    if (mutex.kind === "busy") {
      console.error(`opencodex: another ${mutex.holder === "sync" ? "sync" : "update"} is in progress for this home; retry when it finishes.`);
      return HEADLESS_EXIT.unchanged;
    }
  }
  try {
    const result = await runHeadlessDesktopUpdate({ check: parsed.check }, {
      install,
      currentVersion: packageVersion(),
      fetch: (url, maxBytes) => acquireBounded(url, { maxBytes }, { transport: fetchAcquireTransport, timers: realAcquireTimers }),
      staging: {
        create: () => mkdtempSync(join(tmpdir(), "ocx-desktop-update-")),
        write: (path, bytes) => writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }),
        read: path => new Uint8Array(readFileSync(path)),
        join: (dir, name) => join(dir, name),
        discard: (dir, keep) => {
          if (!keep.length) { rmSync(dir, { recursive: true, force: true }); return; }
          for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (!keep.includes(path)) rmSync(path, { force: true });
          }
        },
      },
      ...imageMover(install),
      msiexecPath: () => win32.join(trustedWindowsSystemDirectory(), "msiexec.exe"),
      spawnInstaller: (file, installerArgs) => {
        const child = Bun.spawn([file, ...installerArgs], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
        return { exited: child.exited };
      },
      timers: realAcquireTimers,
      readInstalledVersion,
      runtime: {
        findLive: () => findLiveProxy(),
        runtimeImage: pid => windowsProcessPair(pid).child?.exe ?? null,
        requestRestart: (live, targetVersion) => requestBoundSystemRestart(live, Date.now() + RESTART_REQUEST_BUDGET_MS,
          { cliVersion: targetVersion, respawnRunsInstalledImage: true }),
        desktopSupervisor,
        drainRuntime: () => drainRuntime(install),
        now: Date.now,
        wait: ms => Bun.sleep(ms),
      },
      log,
    });
    print(result, parsed.json);
    return result.exitCode;
  } finally {
    if (mutex?.kind === "acquired") mutex.release();
  }
}
