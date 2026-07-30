import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { resolveKiroCliNativeSessionEntries } from "../src/oauth/kiro-credentials";

/**
 * Issue #710: `ocx login kiro` could not import an existing Windows Kiro CLI session because the
 * native-store candidate list only covered macOS and Linux. The reporter verified the real path is
 * `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` (and that pointing KIROCLI_DB_PATH there made the import
 * succeed), so the reader and token selector already worked — only discovery was short.
 *
 * These drive the pure resolver directly, so the win32 branch and each of its env fallback rungs are
 * exercised on any host: `process.platform` is stubbable in this repo, but `os.platform()` does not
 * follow it under Bun, so a platform-sniffing implementation could not be covered from macOS/Linux.
 */
describe("kiro-cli native session store resolution", () => {
  const WIN_HOME = "C:\\Users\\u";

  test("win32 uses %LOCALAPPDATA%\\Kiro-Cli\\data.sqlite3 (the path verified on issue #710)", () => {
    const entries = resolveKiroCliNativeSessionEntries({
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      platform: "win32",
      home: WIN_HOME,
    });

    expect(entries).toEqual([
      { location: "kiro-cli-windows-data", path: "C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\data.sqlite3" },
    ]);
  });

  // Middle rung of the win32 chain (LOCALAPPDATA -> USERPROFILE -> injected home). A blank
  // LOCALAPPDATA must fall THROUGH rather than produce a rootless `\AppData\Local\...` path.
  test("win32 falls back to %USERPROFILE%\\AppData\\Local when LOCALAPPDATA is blank", () => {
    const entries = resolveKiroCliNativeSessionEntries({
      env: { LOCALAPPDATA: "   ", USERPROFILE: "C:\\Users\\u" },
      platform: "win32",
      home: "D:\\injected-home",
    });

    expect(entries).toEqual([
      { location: "kiro-cli-windows-data", path: "C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\data.sqlite3" },
    ]);
  });

  test("win32 falls back to the injected home when no Windows env var is usable", () => {
    for (const env of [{}, { LOCALAPPDATA: "" }, { LOCALAPPDATA: "", USERPROFILE: "" }]) {
      const entries = resolveKiroCliNativeSessionEntries({ env, platform: "win32", home: WIN_HOME });

      expect(entries).toEqual([
        { location: "kiro-cli-windows-data", path: "C:\\Users\\u\\AppData\\Local\\Kiro-Cli\\data.sqlite3" },
      ]);
    }
  });

  test("darwin keeps the Application Support store", () => {
    const entries = resolveKiroCliNativeSessionEntries({
      env: {},
      platform: "darwin",
      home: "/Users/x",
    });

    expect(entries).toEqual([
      { location: "kiro-cli-data", path: "/Users/x/Library/Application Support/kiro-cli/data.sqlite3" },
    ]);
  });

  test("linux keeps the XDG-style share store", () => {
    const entries = resolveKiroCliNativeSessionEntries({
      env: {},
      platform: "linux",
      home: "/home/u",
    });

    expect(entries).toEqual([
      { location: "kiro-cli-linux-data", path: "/home/u/.local/share/kiro-cli/data.sqlite3" },
    ]);
  });

  // The list also feeds forced-login snapshot/rollback, which must never touch a foreign platform's
  // database: exactly one entry per platform, and Windows env vars never leak into POSIX resolution.
  test("resolution is one native store per platform and ignores foreign env vars", () => {
    const windowsEnv = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u" };

    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(resolveKiroCliNativeSessionEntries({ env: windowsEnv, platform, home: "/home/u" })).toHaveLength(1);
    }

    expect(resolveKiroCliNativeSessionEntries({ env: windowsEnv, platform: "linux", home: "/home/u" })).toEqual([
      { location: "kiro-cli-linux-data", path: "/home/u/.local/share/kiro-cli/data.sqlite3" },
    ]);
  });

  // #718: the darwin/linux branches used the platform-agnostic `join`, so on a Windows HOST they
  // emitted backslashes and every POSIX expectation in this file failed while macOS CI stayed
  // green. The separator is a property of the RESOLVED platform, not of the machine running the
  // suite, so the implementation must pin `posix.join` exactly as the win32 branch pins
  // `win32.join`.
  //
  // Asserting on the returned string cannot catch this from a POSIX host — there `join` and
  // `posix.join` are the same function, so a reverted fix still passes. The regression is only
  // observable by reading which joiner the source uses, so that is what this checks.
  test("darwin and linux branches pin posix.join so a Windows host cannot flip the separator", () => {
    const source = readFileSync(
      new URL("../src/oauth/kiro-credentials.ts", import.meta.url),
      "utf-8",
    );
    const resolver = source.slice(source.indexOf("export function resolveKiroCliNativeSessionEntries"));
    const body = resolver.slice(0, resolver.indexOf("\n}"));

    const darwinLine = body.split("\n").find(line => line.includes("kiro-cli-data"))!;
    const linuxLine = body.split("\n").find(line => line.includes("kiro-cli-linux-data"))!;

    expect(darwinLine).toContain("posix.join(");
    expect(linuxLine).toContain("posix.join(");
    // A bare `join(` on those branches is the #718 defect.
    expect(/[^.]\bjoin\(/.test(darwinLine.replace("posix.join(", "posix_join("))).toBe(false);
    expect(/[^.]\bjoin\(/.test(linuxLine.replace("posix.join(", "posix_join("))).toBe(false);
  });
});
