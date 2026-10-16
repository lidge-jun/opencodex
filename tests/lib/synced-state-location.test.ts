import { describe, expect, test } from "bun:test";
import {
  syncedStateLocation,
  syncedStateWarning,
  type SyncedStateLocationProbe,
} from "../../src/lib/synced-state-location";

const HOME = "/Users/example";
const probe = (overrides: Partial<SyncedStateLocationProbe> = {}): SyncedStateLocationProbe => ({
  platform: "darwin",
  home: HOME,
  realpath: (path) => path,
  entryExists: () => false,
  ...overrides,
});
const desktopDocumentsSynced = (path: string): boolean =>
  path === `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Documents`
  || path === `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Desktop`;

describe("synced state directory detection (#6314)", () => {
  test("the default state directory is not synced", () => {
    expect(syncedStateLocation(`${HOME}/.opencodex`, probe({ entryExists: desktopDocumentsSynced }))).toBeUndefined();
  });

  test("iCloud Drive and File Provider folders are recognized", () => {
    expect(syncedStateLocation(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/ocx`, probe())).toBe("icloud-drive");
    expect(syncedStateLocation(`${HOME}/Library/CloudStorage/Dropbox/ocx`, probe())).toBe("file-provider");
  });

  test("Documents counts only when iCloud Desktop & Documents sync appears to be on", () => {
    const dir = `${HOME}/Documents/ocx-trial/state`;
    expect(syncedStateLocation(dir, probe())).toBeUndefined();
    expect(syncedStateLocation(dir, probe({ entryExists: desktopDocumentsSynced }))).toBe("icloud-desktop-documents");
    expect(syncedStateLocation(`${HOME}/Desktop/state`, probe({ entryExists: desktopDocumentsSynced }))).toBe("icloud-desktop-documents");
  });

  test("the resolved path decides, so a symlink into iCloud Drive is caught", () => {
    const realpath = (path: string): string => path === `${HOME}/state` ? `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/state` : path;
    expect(syncedStateLocation(`${HOME}/state`, probe({ realpath }))).toBe("icloud-drive");
  });

  test("case differences do not hide a synced folder", () => {
    expect(syncedStateLocation(`${HOME}/library/mobile documents/x`, probe())).toBe("icloud-drive");
  });

  test("a sibling with a shared prefix is not inside the folder", () => {
    expect(syncedStateLocation(`${HOME}/Documents-local/state`, probe({ entryExists: desktopDocumentsSynced }))).toBeUndefined();
  });

  test("a directory that does not exist yet is still classified", () => {
    const realpath = (): string => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    expect(syncedStateLocation(`${HOME}/Library/CloudStorage/OneDrive/ocx`, probe({ realpath }))).toBe("file-provider");
  });

  test("other platforms are never classified", () => {
    expect(syncedStateLocation(`${HOME}/Library/Mobile Documents/x`, probe({ platform: "linux" }))).toBeUndefined();
    expect(syncedStateLocation(`${HOME}/Library/Mobile Documents/x`, probe({ platform: "win32" }))).toBeUndefined();
  });

  test("the warning names the location kind and never a path", () => {
    for (const location of ["icloud-drive", "file-provider", "icloud-desktop-documents", "google-drive-desktop-documents"] as const) {
      const text = syncedStateWarning(location).join("\n");
      expect(text).toContain("OPENCODEX_HOME");
      expect(text).not.toContain("/Users/");
    }
    expect(syncedStateWarning("google-drive-desktop-documents").join("\n")).toContain("Google Drive");
  });

  test("Documents or Desktop counts when Google Drive for desktop is present (#6314)", () => {
    const driveFs = `${HOME}/Library/Application Support/Google/DriveFS`;
    const withDriveFs = probe({ entryExists: (path) => path === driveFs });
    expect(syncedStateLocation(`${HOME}/Documents/ocx-trial/state`, withDriveFs)).toBe("google-drive-desktop-documents");
    expect(syncedStateLocation(`${HOME}/Desktop/state`, withDriveFs)).toBe("google-drive-desktop-documents");
    expect(syncedStateLocation(`${HOME}/.opencodex`, withDriveFs)).toBeUndefined();
    expect(syncedStateLocation(`${HOME}/Documents-local/state`, withDriveFs)).toBeUndefined();

    const listed = probe({
      listEntries: (dir) => dir.endsWith("/CloudStorage") ? ["Dropbox", "GoogleDrive-user@example.com"] : [],
    });
    expect(syncedStateLocation(`${HOME}/Documents/state`, listed)).toBe("google-drive-desktop-documents");
    expect(syncedStateLocation(`${HOME}/documents/state`, listed)).toBe("google-drive-desktop-documents");
  });

  test("a CloudStorage folder that is not Google Drive does not mark Documents as synced", () => {
    const listed = probe({ listEntries: () => ["Dropbox", "OneDrive-work"] });
    expect(syncedStateLocation(`${HOME}/Documents/state`, listed)).toBeUndefined();
    const folded = probe({ listEntries: () => ["googledrive-work"] });
    expect(syncedStateLocation(`${HOME}/Desktop/state`, folded)).toBe("google-drive-desktop-documents");
  });

  test("iCloud Desktop & Documents still wins when Google Drive is also present", () => {
    const driveFs = `${HOME}/Library/Application Support/Google/DriveFS`;
    const entryExists = (path: string): boolean => desktopDocumentsSynced(path) || path === driveFs;
    expect(syncedStateLocation(`${HOME}/Documents/state`, probe({ entryExists }))).toBe("icloud-desktop-documents");
  });

  test("an unreadable Google Drive marker does not throw and does not warn", () => {
    const entryExists = (path: string): boolean => {
      if (path.endsWith("/Google/DriveFS")) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      return false;
    };
    const listEntries = (): readonly string[] => {
      throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    };
    expect(syncedStateLocation(`${HOME}/Documents/state`, probe({ entryExists, listEntries }))).toBeUndefined();
  });

  test("Google Drive markers are ignored off macOS", () => {
    const driveFs = `${HOME}/Library/Application Support/Google/DriveFS`;
    const marked = probe({ platform: "linux", entryExists: (path) => path === driveFs });
    expect(syncedStateLocation(`${HOME}/Documents/state`, marked)).toBeUndefined();
  });

  test("classification uses macOS path rules whatever host runs it", () => {
    // The probe says darwin while this may run on Windows: no separator or drive-letter handling
    // from the host may reach the paths being compared.
    const seen: string[] = [];
    const entryExists = (path: string): boolean => {
      seen.push(path);
      return desktopDocumentsSynced(path);
    };
    expect(syncedStateLocation(`${HOME}/Documents/state`, probe({ entryExists }))).toBe("icloud-desktop-documents");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((path) => path.startsWith(`${HOME}/`) && !path.includes("\\"))).toBe(true);
  });
});
