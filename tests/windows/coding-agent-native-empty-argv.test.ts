import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCodingAgentBinaryCache } from "../../src/adapters/coding-agent/profile";
import { createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { commandInvocation } from "../../src/lib/win-exec";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// #7518 on a real Windows host: the official Qoder CN layout, a native receiver that records the
// argv it was actually given, and real PATH resolution and spawn. Linux quoting fixtures cannot
// show what CreateProcess, cmd.exe and PowerShell deliver, so this file only runs on win32.
const ISOLATION_ARGS = ["--tools", "", "--strict-mcp-config", "--setting-sources", "", "--max-turns", "1"];

let root = "";
let entryDir = "";
let binDir = "";
let argvFile = "";

function containsRun(argv: readonly string[], run: readonly string[]): boolean {
  return argv.some((_, start) => run.every((value, offset) => argv[start + offset] === value));
}

function receivedArgv(): string[] {
  expect(existsSync(argvFile)).toBe(true);
  return JSON.parse(readFileSync(argvFile, "utf8")) as string[];
}

function runDispatcher(dispatcher: string, args: readonly string[]): void {
  const invocation = commandInvocation(dispatcher, args, "win32");
  const result = spawnSync(invocation.file, invocation.args, { ...invocation.options, env: process.env, windowsHide: true, encoding: "utf8" });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
}

describe.skipIf(process.platform !== "win32")("Windows coding-agent empty argv (native receiver)", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ocx-empty-argv-"));
    entryDir = join(root, "entry");
    binDir = join(root, "bin", "qoderclicn");
    mkdirSync(entryDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    argvFile = join(binDir, "argv.json");
    const source = join(root, "receiver.ts");
    writeFileSync(source, [
      'import { writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'writeFileSync(join(dirname(process.execPath), "argv.json"), JSON.stringify(process.argv.slice(2)));',
      'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\\n");',
    ].join("\n"));
    const build = await Bun.build({ entrypoints: [source], compile: { target: "bun-windows-x64", outfile: join(binDir, "qoderclicn.exe") } });
    if (!build.success) throw new Error("receiver compile failed: " + build.logs.map(log => log.message).join("\n"));
    // The vendor's dispatcher shape: cmd -> powershell -File <dispatcher>.ps1 -- %* -> native CLI.
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    writeFileSync(join(entryDir, "qodercn.cmd"), '@echo off\r\n"' + powershell + '" -NoProfile -ExecutionPolicy Bypass -File "%~dp0qodercn-dispatcher.ps1" -- %*\r\n');
    writeFileSync(join(entryDir, "qodercn-dispatcher.ps1"), '& "' + join(binDir, "qoderclicn.exe") + '" @args\r\nexit $LASTEXITCODE\r\n');
    // An npm cmd-shim shape: cmd forwards %* straight to the native image.
    writeFileSync(join(entryDir, "shimcn.cmd"), '@ECHO off\r\n"' + join(binDir, "qoderclicn.exe") + '" %*\r\n');
  });

  afterAll(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* a just-exited image can hold the directory briefly */ }
  });

  beforeEach(() => {
    clearCodingAgentBinaryCache();
    rmSync(argvFile, { force: true });
  });

  const parsed = { modelId: "Qwen3.8-Flash", stream: true, options: {}, context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] } } as unknown as OcxParsedRequest;
  const qoderCn = { adapter: "qoder", baseUrl: "https://qoder.cn", apiKey: "cn-pat" } as OcxProviderConfig;

  async function runTurnWithPath(pathValue: string): Promise<AdapterEvent[]> {
    const previous = process.env.PATH;
    process.env.PATH = pathValue;
    try {
      const events: AdapterEvent[] = [];
      await createQoderAdapter(qoderCn).runTurn!(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
      return events;
    } finally {
      process.env.PATH = previous;
    }
  }

  test("control: the vendor-shaped PowerShell dispatcher drops the empty values", () => {
    runDispatcher(join(entryDir, "qodercn.cmd"), ISOLATION_ARGS);
    const argv = receivedArgv();
    expect(argv).toContain("--max-turns");
    expect(argv).not.toContain("");
  });

  test("control: a dispatcher that forwards %* directly keeps them through cmd.exe", () => {
    runDispatcher(join(entryDir, "shimcn.cmd"), ISOLATION_ARGS);
    const argv = receivedArgv();
    expect(containsRun(argv, ["--tools", ""])).toBe(true);
    expect(containsRun(argv, ["--setting-sources", "", "--max-turns", "1"])).toBe(true);
  });

  test("a turn with the dispatcher first on PATH launches the native executable and delivers both empty values", async () => {
    // Only the fixture directories: a Qoder CLI already installed on the host must not be found.
    const events = await runTurnWithPath([entryDir, binDir].join(";"));
    expect(events.filter(event => event.type === "error")).toEqual([]);
    const argv = receivedArgv();
    expect(containsRun(argv, ["--tools", ""])).toBe(true);
    expect(containsRun(argv, ["--setting-sources", "", "--max-turns", "1"])).toBe(true);
  });

  test("a dispatcher-only install is refused before anything is spawned", async () => {
    const events = await runTurnWithPath(entryDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "cli_dispatcher_drops_empty_args" });
    expect(existsSync(argvFile)).toBe(false);
  });
});

