import { describe, expect, test } from "bun:test";
import { resolveKiroCliExecutable } from "../../../src/oauth/kiro-credentials";

/**
 * Forced/add-account Kiro login still shells out to the local CLI. After #710 fixed Windows
 * SQLite discovery, Windows installs can import tokens while PATH still lacks `kiro-cli`.
 * The pure executable resolver covers that layout without launching the real binary.
 */
describe("kiro-cli executable resolution", () => {
  const WIN_HOME = "C:\\Users\\u";

  test("prefers canonical kiro-cli over short kiro in install directories", () => {
    const exists = (path: string) =>
      path === "C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe" ||
      path === "C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\kiro.exe";
    expect(resolveKiroCliExecutable({
      env: {
        PATH: "C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Windows\\System32"],
      exists,
    })).toBe("C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe");
  });

  test("does not execute arbitrary 'kiro' binary found on PATH to limit blast radius", () => {
    const exists = (path: string) => path === "C:\\Tools\\kiro.exe";
    expect(resolveKiroCliExecutable({
      env: {
        PATH: "C:\\Tools;C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Tools", "C:\\Windows\\System32"],
      exists,
    })).toBe("kiro-cli.exe");
  });

  test("prefers canonical kiro-cli on PATH before install directories", () => {
    const exists = (path: string) =>
      path === "C:\\Tools\\kiro-cli.exe" ||
      path === "C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\kiro.exe";
    expect(resolveKiroCliExecutable({
      env: {
        PATH: "C:\\Tools;C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Tools", "C:\\Windows\\System32"],
      exists,
    })).toBe("C:\\Tools\\kiro-cli.exe");
  });

  test("prefers canonical kiro-cli in system install dir over kiro in user-local dir", () => {
    // Canonical kiro-cli in all directories is exhausted before falling back to short 'kiro'.
    const exists = (path: string) =>
      path === "/usr/local/bin/kiro-cli" || path === "/home/u/.local/bin/kiro";
    expect(resolveKiroCliExecutable({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      home: "/home/u",
      pathEntries: ["/usr/bin"],
      exists,
    })).toBe("/usr/local/bin/kiro-cli");
  });

  test("win32 falls back to %LOCALAPPDATA%\\Kiro-Cli\\kiro.exe when kiro-cli.exe is absent", () => {
    const exists = (path: string) => path === "C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\kiro.exe";
    expect(resolveKiroCliExecutable({
      env: {
        PATH: "C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Windows\\System32"],
      exists,
    })).toBe("C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\kiro.exe");
  });

  test("win32 falls back to %LOCALAPPDATA%\\Kiro-Cli\\kiro-cli.exe", () => {
    const exists = (path: string) => path === "C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe";
    expect(resolveKiroCliExecutable({
      env: {
        PATH: "C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Windows\\System32"],
      exists,
    })).toBe("C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe");
  });

  test("win32 falls back to Program Files\\Kiro-Cli when LOCALAPPDATA binary is absent", () => {
    const exists = (path: string) => path === "C:\\Program Files\\Kiro-Cli\\kiro-cli.exe";
    expect(resolveKiroCliExecutable({
      env: {
        PATH: "C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Windows\\System32"],
      exists,
    })).toBe("C:\\Program Files\\Kiro-Cli\\kiro-cli.exe");
  });

  test("win32 falls back to Program Files\\Kiro-Cli\\kiro.exe when kiro-cli.exe is absent", () => {
    const exists = (path: string) => path === "C:\\Program Files\\Kiro-Cli\\kiro.exe";
    expect(resolveKiroCliExecutable({
      env: {
        PATH: "C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Windows\\System32"],
      exists,
    })).toBe("C:\\Program Files\\Kiro-Cli\\kiro.exe");
  });

  test("linux keeps PATH-first resolution and falls back to ~/.local/bin", () => {
    const exists = (path: string) => path === "/home/u/.local/bin/kiro-cli";
    expect(resolveKiroCliExecutable({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      home: "/home/u",
      pathEntries: ["/usr/bin"],
      exists,
    })).toBe("/home/u/.local/bin/kiro-cli");
  });

  test("linux does not resolve arbitrary kiro on PATH", () => {
    const exists = (path: string) => path === "/usr/bin/kiro";
    expect(resolveKiroCliExecutable({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      home: "/home/u",
      pathEntries: ["/usr/bin"],
      exists,
    })).toBe("kiro-cli");
  });

  test("linux falls back to ~/.local/bin/kiro when canonical kiro-cli is absent everywhere", () => {
    const exists = (path: string) => path === "/home/u/.local/bin/kiro";
    expect(resolveKiroCliExecutable({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      home: "/home/u",
      pathEntries: ["/usr/bin"],
      exists,
    })).toBe("/home/u/.local/bin/kiro");
  });

  test("linux falls back to /usr/local/bin/kiro when user-local binaries are absent", () => {
    const exists = (path: string) => path === "/usr/local/bin/kiro";
    expect(resolveKiroCliExecutable({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      home: "/home/u",
      pathEntries: ["/usr/bin"],
      exists,
    })).toBe("/usr/local/bin/kiro");
  });

  test("darwin falls back to ~/.local/bin/kiro when canonical kiro-cli is absent everywhere", () => {
    const exists = (path: string) => path === "/Users/u/.local/bin/kiro";
    expect(resolveKiroCliExecutable({
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      home: "/Users/u",
      pathEntries: ["/usr/bin"],
      exists,
    })).toBe("/Users/u/.local/bin/kiro");
  });

  test("darwin falls back to /usr/local/bin/kiro when user-local binaries are absent", () => {
    const exists = (path: string) => path === "/usr/local/bin/kiro";
    expect(resolveKiroCliExecutable({
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      home: "/Users/u",
      pathEntries: ["/usr/bin"],
      exists,
    })).toBe("/usr/local/bin/kiro");
  });

  test("darwin falls back to /opt/homebrew/bin/kiro when kiro-cli is absent", () => {
    const exists = (path: string) => path === "/opt/homebrew/bin/kiro";
    expect(resolveKiroCliExecutable({
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      home: "/Users/u",
      pathEntries: ["/usr/bin"],
      exists,
    })).toBe("/opt/homebrew/bin/kiro");
  });

  test("returns the bare command when no candidate exists so spawn can report the original error", () => {
    expect(resolveKiroCliExecutable({
      env: { PATH: "C:\\Windows\\System32" },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Windows\\System32"],
      exists: () => false,
    })).toBe("kiro-cli.exe");
  });

  test("skips a directory named kiro-cli and keeps looking", () => {
    // A directory passes existsSync, so without the isFile guard this resolves to
    // C:Toolskiro-cli and spawn() fails with EACCES at login time.
    const exists = (path: string) =>
      path === "C:\\Tools\\kiro-cli" || path === "C:\\Program Files\\Kiro-Cli\\kiro-cli.exe";
    const isFile = (path: string) => path !== "C:\\Tools\\kiro-cli";
    expect(resolveKiroCliExecutable({
      env: { PATH: "C:\\Tools", ProgramFiles: "C:\\Program Files" },
      platform: "win32",
      home: WIN_HOME,
      pathEntries: ["C:\\Tools"],
      exists,
      isFile,
    })).toBe("C:\\Program Files\\Kiro-Cli\\kiro-cli.exe");
  });

  test("parses PATH from the environment under both Windows casings", () => {
    // The resolver must read the env itself, not only an injected pathEntries array:
    // Windows exposes the variable as `Path`, POSIX as `PATH`.
    const exists = (path: string) => path === "C:\\Tools\\kiro-cli.exe";
    expect(resolveKiroCliExecutable({
      env: { Path: "C:\\Tools;C:\\Windows\\System32" },
      platform: "win32",
      home: WIN_HOME,
      exists,
    })).toBe("C:\\Tools\\kiro-cli.exe");
    expect(resolveKiroCliExecutable({
      env: { PATH: "C:\\Tools" },
      platform: "win32",
      home: WIN_HOME,
      exists,
    })).toBe("C:\\Tools\\kiro-cli.exe");
  });
});
