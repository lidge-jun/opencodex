import { describe, expect, test } from "bun:test";
import { escapeCmdArg, escapeCmdCommand } from "../src/lib/win-exec";
import { codexExecInvocation, isSpawnableCodexCandidate } from "../src/codex/catalog";

describe("codexExecInvocation", () => {
  test("routes Windows .cmd/.bat through ComSpec with escaped args (no shell:true)", () => {
    const spaced = "C:\\Users\\John Doe\\AppData\\Roaming\\npm\\codex.cmd";
    const invocation = codexExecInvocation(spaced, ["--version"], "win32", {
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    const line = [escapeCmdCommand(spaced), escapeCmdArg("--version")].join(" ");
    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsVerbatimArguments: true },
    });
    expect(codexExecInvocation("C:\\npm\\codex.CMD", ["debug", "models"], "win32").file.toLowerCase()).toContain("cmd");
    expect(codexExecInvocation("C:\\npm\\codex.bat", ["--version"], "win32").args[0]).toBe("/d");
  });

  test("keeps Windows .exe and bare names as direct spawns", () => {
    expect(codexExecInvocation("C:\\Tools\\codex.exe", ["--version"], "win32")).toEqual({
      file: "C:\\Tools\\codex.exe",
      args: ["--version"],
      options: {},
    });
    expect(codexExecInvocation("codex", ["--version"], "win32", { env: { PATH: "", PATHEXT: ".EXE" } })).toEqual({
      file: "codex",
      args: ["--version"],
      options: {},
    });
  });

  test("does not special-case .cmd on POSIX", () => {
    expect(codexExecInvocation("/usr/local/bin/codex", ["--version"], "darwin")).toEqual({
      file: "/usr/local/bin/codex",
      args: ["--version"],
      options: {},
    });
    expect(codexExecInvocation("/weird/codex.cmd", ["--version"], "linux")).toEqual({
      file: "/weird/codex.cmd",
      args: ["--version"],
      options: {},
    });
  });

  test("rejects non-spawnable Windows launchers before exec", () => {
    expect(isSpawnableCodexCandidate("C:\\Tools\\codex.exe", "win32")).toBe(true);
    expect(isSpawnableCodexCandidate("C:\\Tools\\codex.cmd", "win32")).toBe(true);
    expect(isSpawnableCodexCandidate("C:\\Tools\\codex", "win32")).toBe(false);
    expect(isSpawnableCodexCandidate("/usr/local/bin/codex", "linux")).toBe(true);
  });

  test("escapes cmd metacharacters in Windows batch paths", () => {
    const evil = "C:\\Users\\x&whoami\\codex.cmd";
    const invocation = codexExecInvocation(evil, ["--version"], "win32", {
      env: { ComSpec: "cmd.exe" },
    });
    expect(invocation.file).toBe("cmd.exe");
    expect(invocation.args[3]).toContain("x^&whoami");
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
  });
});
