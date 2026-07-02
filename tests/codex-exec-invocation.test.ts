import { describe, expect, test } from "bun:test";
import { codexExecInvocation } from "../src/codex-catalog";

describe("codexExecInvocation", () => {
  test(".cmd/.bat on win32 route through the shell with a pre-quoted path (spaces survive)", () => {
    expect(codexExecInvocation("C:\\Users\\John Doe\\AppData\\Roaming\\npm\\codex.cmd", "win32")).toEqual({
      file: '"C:\\Users\\John Doe\\AppData\\Roaming\\npm\\codex.cmd"',
      shell: true,
    });
    expect(codexExecInvocation("C:\\npm\\codex.CMD", "win32").shell).toBe(true);
    expect(codexExecInvocation("C:\\npm\\codex.bat", "win32").shell).toBe(true);
  });

  test(".exe and bare names stay shell-less on win32", () => {
    expect(codexExecInvocation("C:\\Tools\\codex.exe", "win32")).toEqual({ file: "C:\\Tools\\codex.exe", shell: false });
    expect(codexExecInvocation("codex", "win32")).toEqual({ file: "codex", shell: false });
  });

  test("posix platforms never use the shell", () => {
    expect(codexExecInvocation("/usr/local/bin/codex", "darwin")).toEqual({ file: "/usr/local/bin/codex", shell: false });
    expect(codexExecInvocation("/weird/codex.cmd", "linux")).toEqual({ file: "/weird/codex.cmd", shell: false });
  });
});
