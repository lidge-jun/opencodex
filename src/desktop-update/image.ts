/**
 * The updater's own running `ocx.exe` and Windows Installer (#8246).
 *
 * Windows Installer's Restart Manager closes every process that maps a file the package replaces,
 * which would end this command and everything sharing its console and roll the install back.
 * Windows allows renaming a running image, so the running file is renamed aside inside the
 * installation directory, where its mapping stays valid, and an unmapped copy of it takes the
 * installed name. The name is empty only between two back-to-back renames, and then only while
 * Windows Installer itself replaces the file (a major upgrade removes the old one first); the
 * installer finishes or rolls back its own transaction even if this command is killed (Ctrl+C, a
 * closed console, a dropped SSH session), so nothing this command did has to be put back.
 */
import { constants, copyFileSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { win32 } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import { movedImageName, sameWindowsPath } from "./runtime";
import type { WindowsDesktopInstall } from "./install";

const MOVEFILE_DELAY_UNTIL_REBOOT = 4;
/** Images earlier runs moved aside, and copies a run killed mid-swap left behind. */
const LEFTOVER_IMAGE_PATTERN = /^ocx\.exe\.\d+-\d+\.update-(?:old|new)$/i;

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

export interface OwnImageOptions {
  execPath?: string;
  pid?: number;
  now?: () => number;
  join?: (dir: string, name: string) => string;
  deleteAtReboot?: (path: string) => void;
}

export function ownImageMover(install: WindowsDesktopInstall, options: OwnImageOptions = {}) {
  const join = options.join ?? win32.join;
  const scheduleDelete = options.deleteAtReboot ?? deleteAtReboot;
  return {
    moveAsideOwnImage: () => {
      if (!sameWindowsPath(options.execPath ?? process.execPath, install.ocxExe)) return null;
      const name = movedImageName(options.pid ?? process.pid, (options.now ?? Date.now)());
      const moved = join(install.dir, name);
      const copy = join(install.dir, name.replace(/\.update-old$/, ".update-new"));
      // Copy first, then two renames back to back: the installed name is empty only between them.
      copyFileSync(install.ocxExe, copy, constants.COPYFILE_EXCL);
      try { renameSync(install.ocxExe, moved); }
      catch (error) { rmSync(copy, { force: true }); throw error; }
      try { renameSync(copy, install.ocxExe); }
      catch (error) {
        try { renameSync(moved, install.ocxExe); } catch { /* reported by the caller's restore */ }
        rmSync(copy, { force: true });
        throw error;
      }
      return moved;
    },
    restoreOwnImage: (moved: string) => {
      if (existsSync(install.ocxExe)) return true;
      try { renameSync(moved, install.ocxExe); return true; } catch { return false; }
    },
    retireMovedImages: (current: string | null) => {
      let names: string[] = [];
      try { names = readdirSync(install.dir); } catch { return; }
      for (const name of names) {
        const path = join(install.dir, name);
        if (!LEFTOVER_IMAGE_PATTERN.test(name) || path === current) continue;
        try { rmSync(path); } catch { /* still mapped by a process; a later run or a restart removes it */ }
      }
      if (current) scheduleDelete(current);
    },
  };
}

