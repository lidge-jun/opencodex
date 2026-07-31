import { describe, expect, test } from "bun:test";
import { resolveKiroCliExecutable } from "../src/oauth/kiro-credentials";

/**
 * Forced/add-account Kiro login still shells out to the local CLI. After #710 fixed Windows
 * SQLite discovery, Windows installs can import tokens while PATH still lacks `kiro-cli`.
 * The pure executable resolver covers that layout without launching the real binary.
 */
describe("kiro-cli executable resolution", () => {
  const WIN_HOME = "C:\\Users\\u";

  test("prefers the first PATH hit before install-directory fallbacks", () => {
    const exists = (path: string) => path === "C:\\Tools\\kiro-cli.exe";
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
    // C:\Tools\kiro-cli and spawn() fails with EACCES at login time.
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
