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
    for (const location of ["icloud-drive", "file-provider", "icloud-desktop-documents"] as const) {
      const text = syncedStateWarning(location).join("\n");
      expect(text).toContain("OPENCODEX_HOME");
      expect(text).not.toContain("/Users/");
    }
  });
});
