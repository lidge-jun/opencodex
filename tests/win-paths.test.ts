import { describe, expect, test } from "bun:test";
import { splitWindowsEnvPrefix, windowsEnvIndirectBatchPathList, windowsEnvIndirectBatchValue } from "../src/win-paths";

const escape = (value: string): string => value.replace(/%/g, "%%");

describe("splitWindowsEnvPrefix", () => {
  const env = {
    USERPROFILE: "C:\\Users\\한글사용자",
    APPDATA: "C:\\Users\\한글사용자\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\한글사용자\\AppData\\Local",
  };

  test("longest resolved prefix wins", () => {
    expect(splitWindowsEnvPrefix("C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\x.cmd", env)).toEqual({
      token: "%APPDATA%",
      rest: "\\npm\\x.cmd",
    });
    expect(splitWindowsEnvPrefix("C:\\Users\\한글사용자\\AppData\\Local\\bun\\bun.exe", env)).toEqual({
      token: "%LOCALAPPDATA%",
      rest: "\\bun\\bun.exe",
    });
    expect(splitWindowsEnvPrefix("C:\\Users\\한글사용자\\.codex\\config.toml", env)).toEqual({
      token: "%USERPROFILE%",
      rest: "\\.codex\\config.toml",
    });
  });

  test("prefix comparison is case-insensitive (Windows paths)", () => {
    expect(splitWindowsEnvPrefix("c:\\users\\한글사용자\\file.txt", env).token).toBe("%USERPROFILE%");
  });

  test("only whole path components match — no partial-component prefixes", () => {
    const shortEnv = { USERPROFILE: "C:\\Users\\jun" };
    expect(splitWindowsEnvPrefix("C:\\Users\\junk\\file.txt", shortEnv)).toEqual({
      token: "",
      rest: "C:\\Users\\junk\\file.txt",
    });
    expect(splitWindowsEnvPrefix("C:\\Users\\jun\\file.txt", shortEnv).token).toBe("%USERPROFILE%");
    expect(splitWindowsEnvPrefix("C:\\Users\\jun", shortEnv)).toEqual({ token: "%USERPROFILE%", rest: "" });
  });

  test("no matching prefix or empty env passes the path through", () => {
    expect(splitWindowsEnvPrefix("D:\\elsewhere\\file.txt", env)).toEqual({ token: "", rest: "D:\\elsewhere\\file.txt" });
    expect(splitWindowsEnvPrefix("C:\\Users\\other\\file.txt", {})).toEqual({ token: "", rest: "C:\\Users\\other\\file.txt" });
  });

  test("trailing separators on env values are ignored", () => {
    expect(splitWindowsEnvPrefix("C:\\Users\\jun\\x", { USERPROFILE: "C:\\Users\\jun\\" }).token).toBe("%USERPROFILE%");
  });
});

describe("windowsEnvIndirectBatchValue", () => {
  test("keeps the env token verbatim while escaping only the literal suffix", () => {
    const env = { APPDATA: "C:\\Users\\한글사용자\\AppData\\Roaming" };
    const rendered = windowsEnvIndirectBatchValue("C:\\Users\\한글사용자\\AppData\\Roaming\\npm\\100%tool", escape, env);
    expect(rendered).toBe("%APPDATA%\\npm\\100%%tool");
  });

  test("falls back to plain escaping when no prefix applies", () => {
    expect(windowsEnvIndirectBatchValue("C:\\plain\\100%tool", escape, {})).toBe("C:\\plain\\100%%tool");
  });
});

describe("windowsEnvIndirectBatchPathList", () => {
  test("applies indirection per PATH entry", () => {
    const env = { APPDATA: "C:\\Users\\한글사용자\\AppData\\Roaming" };
    const value = "C:\\Users\\한글사용자\\AppData\\Roaming\\npm;C:\\Windows\\System32;";
    expect(windowsEnvIndirectBatchPathList(value, escape, env)).toBe("%APPDATA%\\npm;C:\\Windows\\System32;");
  });
});
