import { expect, test, describe } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { startServer } from "../src/server";
import {
  claudeDesktopConfigLibraryDir,
  resolveConfigLibraryDir,
  resolveElectronUserData,
  resolveUserDataDir,
} from "../src/claude/desktop-3p-paths";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * GitHub #539. Claude Desktop derives its configLibrary through `GE()`, which has
 * three branches; opencodex only implemented the third and hardcoded the macOS
 * shape, so `CLAUDE_USER_DATA_DIR` users and every Windows user got a path Desktop
 * never reads.
 *
 * Branch coverage goes through the PURE functions on purpose: stubbing
 * `process.platform` does not propagate to `os.platform()` under Bun, so a
 * platform-sniffing implementation could not be exercised off-host. The final test
 * proves the runtime wrapper is really wired to these functions.
 */
const HOME = "/home/tester";

describe("Claude Desktop configLibrary resolution", () => {
  test("CLAUDE_USER_DATA_DIR drops the -3p suffix entirely", () => {
    const dir = resolveConfigLibraryDir({
      env: { CLAUDE_USER_DATA_DIR: "/custom/user-data" },
      platform: "darwin",
      home: HOME,
    });
    expect(dir).toBe(posix.join("/custom/user-data", "configLibrary"));
    expect(dir).not.toContain("-3p");
  });

  test("the macOS default stays Claude-3p (regression guard for existing users)", () => {
    const dir = resolveConfigLibraryDir({ env: {}, platform: "darwin", home: HOME });
    expect(dir).toBe(posix.join(HOME, "Library", "Application Support", "Claude-3p", "configLibrary"));
  });

  test("win32 with LOCALAPPDATA resolves under LOCALAPPDATA, not the macOS tree", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" };
    const win = resolveConfigLibraryDir({ env, platform: "win32", home: HOME });
    const mac = resolveConfigLibraryDir({ env, platform: "darwin", home: HOME });

    expect(win).toBe(win32.join("C:\\Users\\tester\\AppData\\Local", "Claude-3p", "configLibrary"));
    // The defect was returning the macOS path on Windows: prove the branch diverges.
    expect(win).not.toBe(mac);
    expect(win).not.toContain("Application Support");
  });

  test("win32 without LOCALAPPDATA falls back to APPDATA + the -3p suffix", () => {
    const dir = resolveUserDataDir({
      env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
      platform: "win32",
      home: HOME,
    });
    expect(dir).toBe(`${win32.join("C:\\Users\\tester\\AppData\\Roaming", "Claude")}-3p`);
  });

  test("linux uses XDG_CONFIG_HOME when set, otherwise ~/.config", () => {
    expect(resolveElectronUserData({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", home: HOME }))
      .toBe(posix.join("/xdg", "Claude"));
    expect(resolveConfigLibraryDir({ env: {}, platform: "linux", home: HOME }))
      .toBe(posix.join(HOME, ".config", "Claude-3p", "configLibrary"));
  });

  test("a userData root already ending in -3p is not double-suffixed", () => {
    const dir = resolveUserDataDir({
      env: { LOCALAPPDATA: "C:\\local" },
      platform: "win32",
      home: HOME,
    });
    expect(dir.endsWith("-3p")).toBe(true);
    expect(dir).not.toContain("-3p-3p");
  });

  test("OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR wins over every branch and is used verbatim", () => {
    // Returned without join(): tests point this straight at a temp dir.
    const dir = resolveConfigLibraryDir({
      env: {
        OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: "/tmp/ocx-override",
        CLAUDE_USER_DATA_DIR: "/custom/user-data",
        LOCALAPPDATA: "C:\\local",
      },
      platform: "win32",
      home: HOME,
    });
    expect(dir).toBe("/tmp/ocx-override");
  });

  test("the runtime wrapper delegates to the pure resolver (wiring proof)", () => {
    // Without this, the pure functions could pass while the wrapper kept the old
    // hardcoded path.
    expect(claudeDesktopConfigLibraryDir()).toBe(
      resolveConfigLibraryDir({ env: process.env, platform: process.platform, home: homedir() }),
    );
  });
});

/**
 * Desktop reads ONLY the profile named by `_meta.json`'s appliedId, so an opencodex
 * entry that merely exists is not proof that Desktop is using it. Before this,
 * /api/claude-desktop/status matched on entry name alone and reported "applied"
 * while Desktop served someone else's profile.
 */
describe("Claude Desktop status reports whether our profile is the active one", () => {
  async function statusWithMeta(meta: unknown): Promise<{ activeProfile: boolean | null }> {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-active-"));
    const previous = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = dir;
    if (meta !== undefined) writeFileSync(join(dir, "_meta.json"), JSON.stringify(meta));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/claude-desktop/status", server.url));
      return await res.json() as { activeProfile: boolean | null };
    } finally {
      server.stop(true);
      if (previous === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previous;
      removeTreeWithRetry(dir);
    }
  }

  test("appliedId pointing at another profile reports activeProfile false", async () => {
    const body = await statusWithMeta({
      appliedId: "11111111-1111-4111-8111-111111111111",
      entries: [
        { id: "11111111-1111-4111-8111-111111111111", name: "Default" },
        { id: "22222222-2222-4222-8222-222222222222", name: "opencodex" },
      ],
    });
    expect(body.activeProfile).toBe(false);
  });

  test("appliedId pointing at our entry reports activeProfile true", async () => {
    const body = await statusWithMeta({
      appliedId: "22222222-2222-4222-8222-222222222222",
      entries: [
        { id: "11111111-1111-4111-8111-111111111111", name: "Default" },
        { id: "22222222-2222-4222-8222-222222222222", name: "opencodex" },
      ],
    });
    expect(body.activeProfile).toBe(true);
  });

  test("a readable appliedId with no opencodex entry is a known false, not unknown", async () => {
    // The distinction matters: null renders the same as "no metadata at all", which
    // would preserve the silent false report this change exists to remove.
    const body = await statusWithMeta({
      appliedId: "11111111-1111-4111-8111-111111111111",
      entries: [{ id: "11111111-1111-4111-8111-111111111111", name: "Default" }],
    });
    expect(body.activeProfile).toBe(false);
  });

  test("missing metadata leaves activeProfile undeterminable", async () => {
    expect((await statusWithMeta(undefined)).activeProfile).toBe(null);
  });

  test("metadata without appliedId leaves activeProfile undeterminable", async () => {
    const body = await statusWithMeta({
      entries: [{ id: "22222222-2222-4222-8222-222222222222", name: "opencodex" }],
    });
    expect(body.activeProfile).toBe(null);
  });
});
