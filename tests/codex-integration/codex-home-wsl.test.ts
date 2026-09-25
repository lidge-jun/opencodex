import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCodexHome, wslAutomountRoot, listWslWindowsCodexHomes } from "../../src/codex/home";
import { isWindowsInteropDir } from "../../src/codex/shim";
import { currentServiceHomes, serviceCodexHomeMatchesInstall } from "../../src/service";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

describe("wsl.conf automount root", () => {
  test("loads and expands the home resolver first in a fresh WSL-like process", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-wsl-import-"));
    try {
      const child = Bun.spawn([process.execPath, "--eval", `
        const { wslAutomountRoot, resolveCodexHomeDir } = await import("./src/codex/home.ts");
        console.log(wslAutomountRoot({ wslConf: null }));
        console.log(resolveCodexHomeDir());
      `], {
        cwd: repoPath(),
        env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: "~/.codex", WSL_DISTRO_NAME: "Ubuntu" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.trim().split(/\r?\n/)).toEqual(["/mnt", join(home, ".codex")]);
    } finally {
      removeTreeWithRetry(home);
    }
  }, 15_000);

  test("defaults to /mnt when wsl.conf is absent or silent", () => {
    expect(wslAutomountRoot({ wslConf: null })).toBe("/mnt");
    expect(wslAutomountRoot({ wslConf: "[boot]\nsystemd=true\n" })).toBe("/mnt");
    expect(wslAutomountRoot({ wslConf: "[automount]\nenabled = true\n" })).toBe("/mnt");
  });

  test("parses a custom root with quotes, comments, and trailing slashes", () => {
    expect(wslAutomountRoot({ wslConf: "[automount]\nroot = /custom\n" })).toBe("/custom");
    expect(wslAutomountRoot({ wslConf: "[automount]\nroot = \"/custom/\"  # comment\n" })).toBe("/custom");
    expect(wslAutomountRoot({ wslConf: "[automount]\nroot = '/'\n" })).toBe("/");
    // root outside [automount] is ignored
    expect(wslAutomountRoot({ wslConf: "[boot]\nroot = /nope\n" })).toBe("/mnt");
    // relative values are invalid -> default
    expect(wslAutomountRoot({ wslConf: "[automount]\nroot = mnt\n" })).toBe("/mnt");
  });

  test("isWindowsInteropDir follows the custom root", () => {
    expect(isWindowsInteropDir("/custom/c/Users/example", "/custom")).toBe(true);
    expect(isWindowsInteropDir("/mnt/c/Users/example", "/custom")).toBe(false);
    expect(isWindowsInteropDir("/c/Users/example", "/")).toBe(true);
    expect(isWindowsInteropDir("/home/example", "/")).toBe(false);
  });

  test("listWslWindowsCodexHomes derives Users root from the automount root", () => {
    const seen: string[] = [];
    const homes = listWslWindowsCodexHomes({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      wslConf: "[automount]\nroot = /win\n",
      existsSync: (p: string) => {
        seen.push(p);
        return p === "/win/c/Users" || p === "/win/c/Users/example/.codex/config.toml";
      },
      readdirSync: () => ["example"],
      statSync: (() => ({ isDirectory: () => true })) as never,
      realpathSync: (p: string) => p,
    });
    expect(seen[0]).toBe("/win/c/Users");
    expect(homes).toEqual(["/win/c/Users/example/.codex"]);
  });

  test("defaultCodexHome keeps a fresh Linux home before config.toml exists", () => {
    const usersRoot = ["/mnt/c", "Users"].join("/");
    // Native join: defaultCodexHome builds the local home with the host path module.
    const linuxCodexHome = join("/home/example", ".codex");
    const windowsCodexHome = [usersRoot, "windows-user", ".codex"].join("/");
    // Fresh and in use: Codex has logged in (auth.json) but not written config.toml yet.
    const localState = new Set([linuxCodexHome, join(linuxCodexHome, "auth.json")]);

    expect(defaultCodexHome({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => "/home/example",
      usersRoot,
      existsSync: (path: string) => path === usersRoot
        || path === linuxCodexHome
        || path === `${windowsCodexHome}/config.toml`,
      readdirSync: () => ["windows-user"],
      statSync: ((path: string) => {
        if (path.startsWith(linuxCodexHome) && !localState.has(path)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
        return { isDirectory: () => true };
      }) as never,
      realpathSync: (path: string) => path,
    })).toBe(linuxCodexHome);
  });

  test("defaultCodexHome still discovers the Windows home when the local ~/.codex is a regular file", () => {
    const usersRoot = ["/mnt/c", "Users"].join("/");
    // Native join: defaultCodexHome builds the local home with the host path module.
    const linuxCodexHome = join("/home/example", ".codex");
    const windowsCodexHome = [usersRoot, "windows-user", ".codex"].join("/");

    expect(defaultCodexHome({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => "/home/example",
      usersRoot,
      existsSync: (path: string) => path === usersRoot
        || path === linuxCodexHome
        || path === `${windowsCodexHome}/config.toml`,
      readdirSync: () => ["windows-user"],
      statSync: ((path: string) => ({ isDirectory: () => path !== linuxCodexHome })) as never,
      realpathSync: (path: string) => path,
    })).toBe(windowsCodexHome);
  });

  test("defaultCodexHome keeps an unreadable local home rather than switching homes", () => {
    const usersRoot = ["/mnt/c", "Users"].join("/");
    // Native join: defaultCodexHome builds the local home with the host path module.
    const linuxCodexHome = join("/home/example", ".codex");
    const windowsCodexHome = [usersRoot, "windows-user", ".codex"].join("/");

    expect(defaultCodexHome({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => "/home/example",
      usersRoot,
      existsSync: (path: string) => path === usersRoot
        || path === linuxCodexHome
        || path === `${windowsCodexHome}/config.toml`,
      readdirSync: () => ["windows-user"],
      statSync: ((path: string) => {
        if (path === linuxCodexHome) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return { isDirectory: () => true };
      }) as never,
      realpathSync: (path: string) => path,
    })).toBe(linuxCodexHome);
  });

  test("service ownership uses the same discovered Windows Codex home as the runtime", () => {
    const usersRoot = ["/mnt/c", "Users"].join("/");
    const windowsCodexHome = [usersRoot, "windows-user", ".codex"].join("/");
    const homes = currentServiceHomes({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => "/home/example",
      usersRoot,
      existsSync: (path: string) => path === usersRoot
        || path === `${windowsCodexHome}/config.toml`,
      readdirSync: () => ["windows-user"],
      statSync: ((path: string) => {
        if (path === join("/home/example", ".codex")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
        return { isDirectory: () => true };
      }) as never,
      realpathSync: (path: string) => path,
    });

    expect(homes.codexHome).toBe(windowsCodexHome);
    expect(homes.codexHome).not.toBe("/home/example/.codex");
  });

  test("service ownership rejects a legacy Linux home when WSL now discovers Windows Codex", () => {
    const usersRoot = ["/mnt/c", "Users"].join("/");
    const windowsCodexHome = [usersRoot, "windows-user", ".codex"].join("/");
    const deps = {
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      homedir: () => "/home/example",
      usersRoot,
      existsSync: (path: string) => path === usersRoot
        || path === `${windowsCodexHome}/config.toml`,
      readdirSync: () => ["windows-user"],
      statSync: ((path: string) => {
        if (path === join("/home/example", ".codex")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
        return { isDirectory: () => true };
      }) as never,
      realpathSync: (path: string) => path,
    };

    expect(serviceCodexHomeMatchesInstall("/home/example/.codex", deps)).toBe(false);
    expect(serviceCodexHomeMatchesInstall(windowsCodexHome, deps)).toBe(true);
    expect(serviceCodexHomeMatchesInstall("/home/other/.codex", deps)).toBe(false);
    expect(serviceCodexHomeMatchesInstall("/home/example/.codex", {
      ...deps,
      env: { ...deps.env, CODEX_HOME: windowsCodexHome },
    })).toBe(false);
  });
});
