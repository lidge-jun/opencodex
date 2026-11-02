import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remotePinnedSyncArgv } from "../../src/link/ssh-argv";
import { POWERSHELL_ENCODED_MAX, powershellArgv, windowsScriptData, windowsScriptHelperSource } from "../../src/link/remote-windows";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function isolatedArgv(): string[] {
  const argv = remotePinnedSyncArgv("lnk_0123456789abcdef", "posix");
  argv[2] = argv[2]!.replace('export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"', 'export PATH="$PATH"').replace('"/Applications/OpenCodex.app/Contents/MacOS/ocx"', '"$HOME/missing-app"').replace('"/usr/bin/ocx"', '"$HOME/missing-system"');
  return argv;
}
function toolDir(home: string): string {
  const bin = join(home, "bin"); mkdirSync(bin);
  for (const command of ["sh", "uname", "mktemp", "sleep", "cat", "awk", "rm"]) symlinkSync(`/usr/bin/${command}`, join(bin, command));
  return bin;
}
function run(version: string) {
  const home = mkdtempSync(join(tmpdir(), "ocx-fanout-test-")); dirs.push(home);
  const bin = toolDir(home);
  const dir = join(home, ".opencodex-desktop", "bin"); mkdirSync(dir, { recursive: true });
  const executable = join(dir, "ocx");
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/calls"\nif [ "$1" = --version ]; then printf '%s\\n' '${version}'; exit 0; fi\nprintf 'synced\\n'\n`);
  chmodSync(executable, 0o755);
  const started = Date.now();
  const proc = Bun.spawnSync(isolatedArgv(), { env: { HOME: home, OPENCODEX_HOME: join(home, "ocx-home"), CODEX_HOME: join(home, "codex-home"), TMPDIR: home, PATH: bin }, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), calls: readFileSync(join(home, "calls"), "utf8"), elapsed: Date.now() - started, remaining: readdirSync(home).filter(name => name.startsWith("ocx-fanout.")) };
}
test.skipIf(process.platform === "win32").each(["2.93.0", "2.93.0+build.5"])("pins the selected %s executable", version => {
  const result = run(version);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe(`ocx-fanout:selected:${version}\n`);
  expect(result.calls).toBe("--version\nsync --expect-link lnk_0123456789abcdef --json\n");
  expect(result.elapsed).toBeLessThan(2000);
  expect(result.remaining).toEqual([]);
});
test.skipIf(process.platform === "win32").each(["2.92.9+build", "2.93.0-preview.1"])("refuses %s before sync", version => {
  const result = run(version);
  expect(result.code).toBe(121);
  expect(result.stderr.trim()).toBe("ocx-fanout:child-ocx-lacks-expect-link");
  expect(result.calls).toBe("--version\n");
  expect(result.remaining).toEqual([]);
});
test.skipIf(process.platform === "win32")("rejects unknown versions and preserves the executable's prefix", () => {
  const invalid = run("2.93.0-01");
  expect(invalid.code).toBe(121);
  expect(invalid.stderr.trim()).toBe("ocx-fanout:child-ocx-version-unknown");
  expect(invalid.calls).toBe("--version\n");
  expect(run("opencodex 2.93.0+build.5").stderr).toBe("ocx-fanout:selected:2.93.0+build.5\n");
});
test("Windows pinned script fits the SSH budget and carries the contained argv", () => {
  const argv = remotePinnedSyncArgv("lnk_0123456789abcdef", "windows");
  expect(argv[5]!.length).toBeLessThanOrEqual(POWERSHELL_ENCODED_MAX);
  const script = Buffer.from(argv[5]!, "base64").toString("utf16le");
  expect(windowsScriptData(script)).toEqual({ args: ["sync", "--expect-link", "lnk_0123456789abcdef", "--json"] });
  expect(windowsScriptHelperSource(script)).toContain("public static string V(");
});

test.skipIf(process.platform !== "win32")("Windows bounds version probes and runs the selected pinned command", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-fanout-windows-")); dirs.push(home);
  const dir = join(home, ".opencodex-desktop", "bin"); mkdirSync(dir, { recursive: true });
  const executable = join(dir, "ocx.exe");
  const source = 'using System;using System.IO;using System.Reflection;using System.Threading;public static class Program{public static int Main(string[] a){string p=Assembly.GetExecutingAssembly().Location,m=Environment.GetEnvironmentVariable("OCX_FIXTURE_MODE"),log=Environment.GetEnvironmentVariable("OCX_FIXTURE_LOG");File.AppendAllText(log,p+"|"+string.Join("|",a)+"\\n");bool first=p.IndexOf(".opencodex-desktop",StringComparison.OrdinalIgnoreCase)>=0;if(a.Length==1&&a[0]=="--version"){if(first&&m=="broken")return 17;if(first&&m=="hang"){Thread.Sleep(30000);return 1;}if(first&&m=="overflow"){Console.Write(new string(\u0027x\u0027,256));Console.Out.Flush();Thread.Sleep(100);Console.Write("x");Console.Out.Flush();Thread.Sleep(30000);return 1;}if(first&&m=="fragment"){Console.Write("2.93.");Console.Out.Flush();Thread.Sleep(30);Console.WriteLine("0");return 0;}Console.WriteLine(Environment.GetEnvironmentVariable("OCX_FIXTURE_VERSION"));return 0;}Console.WriteLine(string.Join("|",a));return 0;}}';
  const compile = Bun.spawn(powershellArgv(`Add-Type -TypeDefinition '${source.replaceAll("'", "''")}' -OutputAssembly '${executable.replaceAll("'", "''")}' -OutputType ConsoleApplication`), { stdout: "pipe", stderr: "pipe" });
  const [compiled, compileErr] = await Promise.all([compile.exited, new Response(compile.stderr).text(), new Response(compile.stdout).text()]);
  expect({ compiled, compileErr }).toEqual({ compiled: 0, compileErr: "" });
  const managed = join(home, ".local", "share", "goat", "opencodex", "current", "ocx.exe");
  mkdirSync(join(home, ".local", "share", "goat", "opencodex", "current"), { recursive: true });
  copyFileSync(executable, managed);
  const run = async (version: string, mode = "") => {
    const log = join(home, "calls"); writeFileSync(log, "");
    const started = Date.now();
    const child = Bun.spawn(remotePinnedSyncArgv("lnk_0123456789abcdef", "windows"), {
      env: { ...process.env, USERPROFILE: home, LOCALAPPDATA: home, ProgramFiles: home, PATH: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"), OPENCODEX_HOME: join(home, "ocx-home"), CODEX_HOME: join(home, "codex-home"), OCX_FIXTURE_VERSION: version, OCX_FIXTURE_MODE: mode, OCX_FIXTURE_LOG: log },
      stdout: "pipe", stderr: "pipe",
    });
    const [actual, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { actual, out: out.trim(), err: err.trim(), calls: readFileSync(log, "utf8"), elapsed: Date.now() - started };
  };
  for (const [version, code, stderr, stdout] of [
    ["2.93.0+build.5", 0, "ocx-fanout:selected:2.93.0+build.5", "sync|--expect-link|lnk_0123456789abcdef|--json"],
    ["2.92.9+build", 121, "ocx-fanout:child-ocx-lacks-expect-link", ""],
  ] as const) {
    const { actual, out, err } = await run(version);
    expect({ actual, out, err }).toEqual({ actual: code, out: stdout, err: stderr });
  }
  const fragmented = await run("2.93.0", "fragment");
  expect(fragmented).toMatchObject({ actual: 0, err: "ocx-fanout:selected:2.93.0", out: "sync|--expect-link|lnk_0123456789abcdef|--json" });
  for (const mode of ["broken", "overflow", "hang"]) {
    const result = await run("2.93.0", mode);
    expect(result).toMatchObject({ actual: 0, err: "ocx-fanout:selected:2.93.0", out: "sync|--expect-link|lnk_0123456789abcdef|--json" });
    expect(result.calls).toContain(`${executable}|--version`);
    expect(result.calls).not.toContain(`${executable}|sync`);
    expect(result.calls).toContain(`${managed}|sync|--expect-link|lnk_0123456789abcdef|--json`);
    expect(result.elapsed).toBeLessThan(mode === "hang" ? 20000 : 9000);
  }
}, 60000);

test.skipIf(process.platform === "win32")("a version command that exits nonzero falls through without being synced", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-fanout-fallthrough-")); dirs.push(home);
  const desktop = join(home, ".opencodex-desktop", "bin"), bin = toolDir(home); mkdirSync(desktop, { recursive: true });
  writeFileSync(join(desktop, "ocx"), '#!/bin/sh\necho "$*" >> "$HOME/first"\necho 2.93.0\nexit 17\n', { mode: 0o755 });
  writeFileSync(join(bin, "ocx"), '#!/bin/sh\necho "$*" >> "$HOME/second"\nif [ "$1" = --version ]; then echo 2.93.0; else echo synced; fi\n', { mode: 0o755 });
  const child = Bun.spawn(isolatedArgv(), { env: { HOME: home, OPENCODEX_HOME: join(home, "ocx-home"), CODEX_HOME: join(home, "codex-home"), TMPDIR: home, PATH: bin }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "synced\n", stderr: "ocx-fanout:selected:2.93.0\n" });
  expect(readFileSync(join(home, "first"), "utf8")).toBe("--version\n");
  expect(readFileSync(join(home, "second"), "utf8")).toBe("--version\nsync --expect-link lnk_0123456789abcdef --json\n");
});

test.skipIf(process.platform === "win32")("a version writer ignoring signals is killed and the next candidate is selected", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-fanout-watchdog-")); dirs.push(home);
  const desktop = join(home, ".opencodex-desktop", "bin"), bin = toolDir(home);
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(desktop, "ocx"), '#!/bin/sh\nprintf "%s" $$ > "$HOME/writer.pid"\ntrap "" PIPE XFSZ\nwhile :; do printf "01234567890123456789"; done\n', { mode: 0o755 });
  writeFileSync(join(bin, "ocx"), '#!/bin/sh\nif [ "$1" = --version ]; then echo 2.93.0; else echo synced; fi\n', { mode: 0o755 });
  const child = Bun.spawn(isolatedArgv(), { env: { HOME: home, OPENCODEX_HOME: join(home, "ocx-home"), CODEX_HOME: join(home, "codex-home"), TMPDIR: home, PATH: bin }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "ocx-fanout:selected:2.93.0\n" });
  expect(stdout).toBe("synced\n");
  const pid = Number(readFileSync(join(home, "writer.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(readdirSync(home).filter(name => name.startsWith("ocx-fanout."))).toEqual([]);
}, 15000);
