import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultCodexHome } from "../../src/codex/home";

// An existing WSL user can have a local ~/.codex directory that Codex never used while running
// against the discovered Windows Codex home. Only local Codex state keeps the local home (#5441's
// fresh install); a bare directory must not move that user to an empty home on upgrade.
const usersRoot = ["/mnt/c", "Users"].join("/");
const linuxCodexHome = join("/home/example", ".codex");
const windowsCodexHome = [usersRoot, "windows-user", ".codex"].join("/");

function enoent(): never {
  throw Object.assign(new Error("absent"), { code: "ENOENT" });
}

function resolveWith(localEntries: Record<string, "present" | "absent" | "denied">, env: NodeJS.ProcessEnv = { WSL_DISTRO_NAME: "Ubuntu" }): string {
  return defaultCodexHome({
    env,
    platform: "linux",
    homedir: () => "/home/example",
    usersRoot,
    existsSync: (path: string) => path === usersRoot || path === `${windowsCodexHome}/config.toml`,
    readdirSync: () => ["windows-user"],
    statSync: ((path: string) => {
      if (path === linuxCodexHome) return { isDirectory: () => true };
      if (path.startsWith(`${linuxCodexHome}/`) || path.startsWith(`${linuxCodexHome}\\`)) {
        const entry = path.slice(linuxCodexHome.length + 1);
        const state = localEntries[entry] ?? "absent";
        if (state === "absent") enoent();
        if (state === "denied") throw Object.assign(new Error("denied"), { code: "EACCES" });
        return { isDirectory: () => entry === "sessions" };
      }
      return { isDirectory: () => true };
    }) as never,
    realpathSync: (path: string) => path,
  });
}

describe("WSL Codex home with a local ~/.codex directory", () => {
  test("a bare local directory keeps the discovered Windows home", () => {
    expect(resolveWith({})).toBe(windowsCodexHome);
  });

  test("a local home Codex has logged into stays the home before config.toml exists", () => {
    expect(resolveWith({ "auth.json": "present" })).toBe(linuxCodexHome);
  });

  test("local sessions or history keep the local home", () => {
    expect(resolveWith({ sessions: "present" })).toBe(linuxCodexHome);
    expect(resolveWith({ "history.jsonl": "present" })).toBe(linuxCodexHome);
  });

  test("a local config.toml keeps the local home", () => {
    expect(resolveWith({ "config.toml": "present" })).toBe(linuxCodexHome);
  });

  test("an unreadable state entry keeps the local home rather than switching", () => {
    expect(resolveWith({ "auth.json": "denied" })).toBe(linuxCodexHome);
  });

  test("outside WSL a bare local directory is still the home", () => {
    expect(resolveWith({}, {})).toBe(linuxCodexHome);
  });
});

