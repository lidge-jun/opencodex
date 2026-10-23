import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { inspectBatchDispatcher } from "../../src/adapters/coding-agent/batch-dispatcher";
import { clearCodingAgentBinaryCache, resolveCodingAgentBinary, whichFromPath } from "../../src/adapters/coding-agent/profile";
import type { SpawnFn } from "../../src/adapters/coding-agent/turn";
import { createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { QODER_CN_PROFILE, QODER_GLOBAL_PROFILE } from "../../src/adapters/qoder/profiles";
import { CLAUDE_CLI_PROFILE } from "../../src/adapters/claude-cli/profiles";
import { createClaudeCliAdapter } from "../../src/adapters/claude-cli/adapter";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// #7518: the official Qoder CN installer puts entry\qodercn.cmd (a PowerShell dispatcher) and
// bin\qoderclicn\qoderclicn.exe on PATH. The dispatcher drops empty argv entries, so
// --setting-sources "" swallowed --max-turns and every turn failed.
const VENDOR_DISPATCHER = '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0qodercn-dispatcher.ps1" -- %*\r\n';
const NPM_CMD_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join("\r\n");

function windowsFs(files: readonly string[]) {
  const present = new Set(files.map(file => file.toLowerCase()));
  return (path: string) => present.has(path.toLowerCase());
}

describe("whichFromPath on Windows", () => {
  const env = { PATH: "C:\\entry;C:\\bin" };

  test("a same-stem .exe beats the .cmd beside it", () => {
    const exists = windowsFs(["C:\\entry\\qoder.cmd", "C:\\entry\\qoder.exe"]);
    expect(whichFromPath("qoder", { env, platform: "win32", exists })).toBe("C:\\entry\\qoder.exe");
  });

  test("PATH order owns the choice between competing directories", () => {
    const exists = windowsFs(["C:\\entry\\qoder.cmd", "C:\\bin\\qoder.exe"]);
    expect(whichFromPath("qoder", { env, platform: "win32", exists })).toBe("C:\\entry\\qoder.cmd");
    expect(whichFromPath("qoder", { env: { PATH: "C:\\bin;C:\\entry" }, platform: "win32", exists })).toBe("C:\\bin\\qoder.exe");
  });

  test("POSIX lookup is unchanged and never appends Windows extensions", () => {
    const probed: string[] = [];
    const exists = (path: string) => { probed.push(path); return path === "/usr/local/bin/qoder"; };
    expect(whichFromPath("qoder", { env: { PATH: "/usr/bin:/usr/local/bin" }, platform: "linux", exists })).toBe("/usr/local/bin/qoder");
    expect(probed).toEqual(["/usr/bin/qoder", "/usr/local/bin/qoder"]);
  });
});

describe("resolveCodingAgentBinary profile resolution", () => {
  beforeEach(() => clearCodingAgentBinaryCache());

  function lookup(files: readonly string[], PATH: string) {
    const exists = windowsFs(files);
    const calls: string[] = [];
    const which = (candidate: string) => { calls.push(candidate); return whichFromPath(candidate, { env: { PATH }, platform: "win32", exists }); };
    return { which, calls };
  }

  test("CN aliases: the vendor dispatcher qodercn.cmd yields to the native qoderclicn.exe", () => {
    const { which } = lookup(["C:\\q\\entry\\qodercn.cmd", "C:\\q\\bin\\qoderclicn\\qoderclicn.exe"], "C:\\q\\entry;C:\\q\\bin\\qoderclicn");
    expect(resolveCodingAgentBinary(QODER_CN_PROFILE, which)).toBe("C:\\q\\bin\\qoderclicn\\qoderclicn.exe");
  });

  test("Global aliases resolve the same way", () => {
    const { which } = lookup(["C:\\q\\entry\\qoder.cmd", "C:\\q\\bin\\qodercli\\qodercli.exe"], "C:\\q\\entry;C:\\q\\bin\\qodercli");
    expect(resolveCodingAgentBinary(QODER_GLOBAL_PROFILE, which)).toBe("C:\\q\\bin\\qodercli\\qodercli.exe");
  });

  test("a native first candidate is returned without probing the others", () => {
    const { which, calls } = lookup(["C:\\q\\qodercn.exe", "C:\\q\\qoderclicn.exe"], "C:\\q");
    expect(resolveCodingAgentBinary(QODER_CN_PROFILE, which)).toBe("C:\\q\\qodercn.exe");
    expect(calls).toEqual(["qodercn"]);
  });

  test("a dispatcher-only install returns the first dispatcher", () => {
    const { which } = lookup(["C:\\q\\entry\\qodercn.cmd", "C:\\npm\\qoderclicn.cmd"], "C:\\q\\entry;C:\\npm");
    expect(resolveCodingAgentBinary(QODER_CN_PROFILE, which)).toBe("C:\\q\\entry\\qodercn.cmd");
  });

  test("an explicit resolver selection is used as returned", () => {
    expect(resolveCodingAgentBinary(QODER_CN_PROFILE, () => "D:\\chosen\\qodercn.exe")).toBe("D:\\chosen\\qodercn.exe");
    clearCodingAgentBinaryCache();
    expect(resolveCodingAgentBinary(CLAUDE_CLI_PROFILE, () => "D:\\npm\\claude.cmd")).toBe("D:\\npm\\claude.cmd");
  });

  test("cached discovery: a dispatcher-only result is not pinned, a native hit is", () => {
    const files = ["C:\\q\\entry\\qodercn.cmd"];
    const exists = (path: string) => windowsFs(files)(path);
    const which = (candidate: string) => whichFromPath(candidate, { env: { PATH: "C:\\q\\entry;C:\\q\\bin" }, platform: "win32", exists });
    expect(resolveCodingAgentBinary(QODER_CN_PROFILE, which)).toBe("C:\\q\\entry\\qodercn.cmd");
    // The native build is installed after the first turn; the next turn finds it without a restart.
    files.push("C:\\q\\bin\\qoderclicn.exe");
    expect(resolveCodingAgentBinary(QODER_CN_PROFILE, which)).toBe("C:\\q\\bin\\qoderclicn.exe");
    // Positive native hits stay cached until an explicit re-check.
    files.length = 0;
    expect(resolveCodingAgentBinary(QODER_CN_PROFILE, which)).toBe("C:\\q\\bin\\qoderclicn.exe");
    clearCodingAgentBinaryCache();
    expect(resolveCodingAgentBinary(QODER_CN_PROFILE, which)).toBeUndefined();
  });
});

describe("inspectBatchDispatcher", () => {
  test("a PowerShell hop cannot carry empty arguments", () => {
    expect(inspectBatchDispatcher("x.cmd", () => VENDOR_DISPATCHER)).toEqual({ preservesEmptyArguments: false, reason: "powershell_hop" });
    expect(inspectBatchDispatcher("x.cmd", () => '@"%~dp0pwsh" -File a.ps1 %*')).toEqual({ preservesEmptyArguments: false, reason: "powershell_hop" });
  });

  test("an npm cmd-shim and a comment that merely names PowerShell forward %* intact", () => {
    expect(inspectBatchDispatcher("x.cmd", () => NPM_CMD_SHIM)).toEqual({ preservesEmptyArguments: true });
    expect(inspectBatchDispatcher("x.cmd", () => 'REM not a powershell hop\r\n:: pwsh.exe either\r\n"%~dp0real.exe" %*')).toEqual({ preservesEmptyArguments: true });
  });

  test("an unreadable dispatcher is not trusted", () => {
    expect(inspectBatchDispatcher("x.cmd", () => { throw new Error("EACCES"); })).toEqual({ preservesEmptyArguments: false, reason: "unreadable" });
  });
});

describe("inspectBatchDispatcher with real files", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-dispatcher-chain-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: string) => { const path = join(dir, name); writeFileSync(path, body); return path; };

  test("a PowerShell hop past the read bound is refused as incomplete", () => {
    const padded = write("padded.cmd", "REM " + "x".repeat(64 * 1024) + "\r\npowershell.exe -File \"%~dp0d.ps1\" -- %*\r\n");
    expect(inspectBatchDispatcher(padded)).toEqual({ preservesEmptyArguments: false, reason: "incomplete" });
    const oversizedClean = write("big.cmd", "REM " + "x".repeat(64 * 1024) + "\r\n\"%~dp0real.exe\" %*\r\n");
    expect(inspectBatchDispatcher(oversizedClean)).toEqual({ preservesEmptyArguments: false, reason: "incomplete" });
    expect(inspectBatchDispatcher(write("small.cmd", NPM_CMD_SHIM))).toEqual({ preservesEmptyArguments: true });
  });

  test("a hop to another batch file is followed, and its PowerShell forward is found", () => {
    write("inner.cmd", VENDOR_DISPATCHER);
    expect(inspectBatchDispatcher(write("outer.cmd", '@call "%~dp0inner.cmd" %*\r\n'))).toEqual({ preservesEmptyArguments: false, reason: "powershell_hop" });
    expect(inspectBatchDispatcher(write("direct.cmd", '@"%~dp0inner.cmd" %*\r\n'))).toEqual({ preservesEmptyArguments: false, reason: "powershell_hop" });
  });

  test("a verified chain that ends in a native image keeps the empty values", () => {
    write("inner.cmd", '@"%~dp0real.exe" %*\r\n');
    expect(inspectBatchDispatcher(write("outer.cmd", '@call "%~dp0inner.cmd" %*\r\n'))).toEqual({ preservesEmptyArguments: true });
    expect(inspectBatchDispatcher(write("exe.cmd", '@call "%~dp0real.exe" %*\r\n'))).toEqual({ preservesEmptyArguments: true });
  });

  test("an unverifiable or missing hop is refused", () => {
    expect(inspectBatchDispatcher(write("var.cmd", "@call %LAUNCHER% %*\r\n"))).toEqual({ preservesEmptyArguments: false, reason: "indirect_launch" });
    expect(inspectBatchDispatcher(write("rel.cmd", '@call "inner.cmd" %*\r\n'))).toEqual({ preservesEmptyArguments: false, reason: "indirect_launch" });
    expect(inspectBatchDispatcher(write("missing.cmd", '@call "%~dp0absent.cmd" %*\r\n'))).toEqual({ preservesEmptyArguments: false, reason: "unreadable" });
  });

  test("a self-reference is not re-read, and a chain deeper than the bound is refused", () => {
    expect(inspectBatchDispatcher(write("self.cmd", '@if "%1"=="" "%~dp0self.cmd" --help\r\n@"%~dp0real.exe" %*\r\n'))).toEqual({ preservesEmptyArguments: true });
    for (let index = 0; index < 5; index++) write("hop" + index + ".cmd", '@call "%~dp0hop' + (index + 1) + '.cmd" %*\r\n');
    write("hop5.cmd", '@"%~dp0real.exe" %*\r\n');
    expect(inspectBatchDispatcher(join(dir, "hop0.cmd"))).toEqual({ preservesEmptyArguments: false, reason: "indirect_launch" });
  });
});

function resultChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { killed: boolean; exitCode: number | null };
  const stdout = new PassThrough();
  stdout.end('{"type":"result","subtype":"success","is_error":false}\n');
  child.stdout = stdout;
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = 0; child.emit("close", 0); }, 2);
  return child;
}

describe("Windows turn preflight for empty isolation arguments", () => {
  let dir: string;
  beforeEach(() => {
    clearCodingAgentBinaryCache();
    dir = mkdtempSync(join(tmpdir(), "ocx-dispatcher-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const parsed = { modelId: "Qwen3.8-Flash", stream: true, options: {}, context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] } } as unknown as OcxParsedRequest;
  const qoderCn = { adapter: "qoder", baseUrl: "https://qoder.cn", apiKey: "cn-pat" } as OcxProviderConfig;

  async function run(adapter: ReturnType<typeof createQoderAdapter>) {
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    return events;
  }

  test("a .cmd-only Qoder CN install is refused before spawn", async () => {
    const dispatcher = join(dir, "qodercn.cmd");
    writeFileSync(dispatcher, VENDOR_DISPATCHER);
    let spawned = 0;
    const events = await run(createQoderAdapter(qoderCn, {
      platform: "win32",
      which: candidate => candidate === "qodercn" ? dispatcher : undefined,
      spawn: () => { spawned++; return resultChild(); },
    }));
    expect(spawned).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "cli_dispatcher_drops_empty_args", retryable: false });
    const message = (events[0] as { message: string }).message;
    expect(message).toContain("qodercn.cmd");
    expect(message).toContain("qodercn.exe or qoderclicn.exe");
    expect(message).not.toContain(dir);
  });

  test("with the native executable on PATH the turn spawns it directly with both empty values", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const spawn: SpawnFn = (file, args) => { calls.push({ file, args }); return resultChild(); };
    await run(createQoderAdapter(qoderCn, {
      platform: "win32",
      which: candidate => candidate === "qodercn" ? "C:\\q\\entry\\qodercn.cmd" : "C:\\q\\bin\\qoderclicn.exe",
      readDispatcher: () => { throw new Error("the native executable must not need a dispatcher read"); },
      spawn,
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("C:\\q\\bin\\qoderclicn.exe");
    const args = calls[0]!.args;
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 2]).toBe("--max-turns");
  });

  test("an npm cmd-shim Claude CLI install keeps launching through cmd.exe", async () => {
    const shim = join(dir, "claude.cmd");
    writeFileSync(shim, NPM_CMD_SHIM);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const adapter = createClaudeCliAdapter({ adapter: "claude-cli", baseUrl: CLAUDE_CLI_PROFILE.canonicalBaseUrl } as OcxProviderConfig, {
      platform: "win32",
      which: () => shim,
      usageAdmission: async () => ({ state: "available", checkedAt: 0 }),
      spawn: (file, args) => { calls.push({ file, args }); return resultChild(); },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!({ ...parsed, modelId: "claude-sonnet-4-6" } as OcxParsedRequest, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events.find(event => event.type === "error" && (event as { code?: string }).code === "cli_dispatcher_drops_empty_args")).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  });
});


