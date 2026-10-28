import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { windowsOcxArgv, windowsNativeArgv, windowsChildHttpArgv, powershellArgv, windowsScriptData, windowsScriptHelperSource, OCX_JOB_SOURCE, WINDOWS_CONTAINMENT_EXIT } from "../../src/link/remote-windows";
import { quoteRemote, REMOTE_OCX_SCRIPT, remoteOcxArgv } from "../../src/link/ssh-argv";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const roots: string[] = [];
// Keep any fixture whose child or inherited output pipes have not settled.
const activeRoots = new Set<string>();
afterEach(() => {
  for (const root of roots.splice(0)) if (!activeRoots.has(root)) removeTreeWithRetry(root);
});

function executable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function fixture(platform = "Darwin") {
  const home = mkdtempSync(join(tmpdir(), "ocx-ssh discovery-"));
  roots.push(home);
  const paths = [
    join(home, ".opencodex-desktop/bin/ocx"),
    join(home, "Applications/OpenCodex.app/Contents/MacOS/ocx"),
    join(home, "usr/bin/ocx"),
    join(home, "remote-bin/ocx"),
    join(home, "second-bin/ocx"),
    join(home, ".bun/bin/ocx"),
    join(home, ".local/bin/ocx"),
    join(home, "homebrew/bin/ocx"),
    join(home, "local/bin/ocx"),
  ];
  executable(join(home, "remote-bin/uname"), `printf '%s\\n' '${platform}'`);
  symlinkSync("/bin/sh", join(home, "remote-bin/sh"));
  const script = REMOTE_OCX_SCRIPT
    .replaceAll("/Applications/OpenCodex.app/Contents/MacOS/ocx", paths[1]!)
    .replaceAll("/usr/bin/ocx", paths[2]!)
    .replaceAll("/opt/homebrew/bin", join(home, "homebrew/bin"))
    .replaceAll("/usr/local/bin", join(home, "local/bin"));
  return {
    home, paths,
    async run(args = ["link", "port"]) {
      const argv = remoteOcxArgv(args);
      argv[2] = script;
      // Real candidate probes need a live parent loop and a separate reap budget.
      activeRoots.add(home);
      const result = await spawnTestChild(["/bin/sh", "-c", quoteRemote(argv)], {
        cwd: home,
        env: { HOME: home, PATH: `${home}/remote-bin:${home}/second-bin` },
        deadlineMs: 15_000,
      });
      if (result.reaped && result.pipesClosed) activeRoots.delete(home);
      expect(result.timedOut).toBe(false);
      expect(result.reaped).toBe(true);
      expect(result.pipesClosed).toBe(true);
      expect(result.signal).toBeNull();
      return result;
    },
    install(index: number, fails = false) {
      executable(paths[index]!, fails
        ? "if [ \"$1\" = --version ]; then printf 'env: node: missing\\n' >&2; exit 127; fi\nprintf 'broken candidate ran\\n'; exit 1"
        : `if [ "$1" = --version ]; then printf 'ocx 2.84.0\\n'; exit 0; fi\nprintf '%s\\n' '${index}'\nprintf '%s\\0' "$@"`);
    },
  };
}

test.skipIf(process.platform === "win32").each([0, 1, 2, 3, 4, 5, 6, 7, 8])("remote sh chooses candidate %i in Desktop/system/PATH order, skipping failed versions", async winner => {
    const f = fixture(winner % 2 ? "Linux" : "Darwin");
    for (let index = 0; index < 9; index++) f.install(index, index < winner);
    const args = ["link", "issue", "--alias", "it's x", "two\nlines", "火🔥", "x;$(echo no)", "", "--json"];
    const result = await f.run(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${winner}\n${args.join("\0")}\0`);
    expect(result.stderr).toBe("");
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform === "win32")("remote sh skips absent and non-executable Desktop candidates", async () => {
  const f = fixture();
  mkdirSync(dirname(f.paths[0]!), { recursive: true });
  writeFileSync(f.paths[0]!, "unusable", { mode: 0o644 });
  f.install(2);
  const result = await f.run();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("2\nlink\0port\0");
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform === "win32").each([["absent", false], ["broken", true]] as const)("remote sh reports missing when candidates are %s", async (_label, broken) => {
  const f = fixture();
  if (broken) for (let index = 0; index < 9; index++) f.install(index, true);
  const result = await f.run();
  expect(result.exitCode).toBe(127);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform === "win32").each(["Windows_NT", "MSYS_NT-10.0-22631", "MINGW64_NT-10.0", "MINGW32_NT-6.1", "CYGWIN_NT-10.0"])("remote sh refuses %s before invoking any ocx candidate", async platform => {
    const f = fixture(platform);
    for (const path of f.paths) executable(path, "printf 'ocx must not run\\n' >&2; exit 1");
    const result = await f.run(["--version"]);
    expect(result.exitCode).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform !== "win32")("Windows native execution preserves spaces quotes Unicode empty arguments and stdin bytes", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-windows-native-")); roots.push(home);
  const script = join(home, "echo arguments.ts");
  writeFileSync(script, 'const input = await Bun.stdin.text(); console.log(JSON.stringify({args:process.argv.slice(2),input})); process.exit(23);');
  const args = ["space and 'quote'", 'double"quote', "", "雪🔥", "x;$(echo bad)&%OS%", "tail\\"];
  const child = Bun.spawn(windowsNativeArgv(process.execPath, [script, ...args]), {
    stdin: new Blob(["fixture-key-stdin\n"]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(code).toBe(23);
  expect(JSON.parse(stdout)).toEqual({ args, input: "fixture-key-stdin\n" });
});

test.skipIf(process.platform !== "win32")("Windows discovery selects Desktop before the managed current junction before a legacy executable", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-windows-discovery-")); roots.push(home);
  const prefix = join(home, ".local", "share", "goat", "opencodex");
  const version = join(prefix, "fixture-win32-x64");
  const desktop = join(home, ".opencodex-desktop", "bin", "ocx.exe");
  const managed = join(version, "ocx.exe");
  const legacy = join(home, ".local", "bin", "ocx.exe");
  for (const executable of [desktop, managed, legacy]) {
    mkdirSync(dirname(executable), { recursive: true });
    copyFileSync(process.execPath, executable);
  }
  symlinkSync(version, join(prefix, "current"), "junction");
  for (const expected of [desktop, managed, legacy]) {
    const child = Bun.spawn(windowsOcxArgv(["-e", 'console.log(require("node:fs").realpathSync(process.execPath)); console.log(await Bun.stdin.text());']), {
      env: { ...process.env, USERPROFILE: home }, stdin: new Blob(["fixture-key-stdin"]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(stderr).toBe("");
    // The child reports its long path; the runner's temp root is an 8.3 short name.
    expect(stdout.trim().split(/\r?\n/u)).toEqual([realpathSync.native(expected), "fixture-key-stdin"]);
    if (expected === managed) rmSync(join(prefix, "current"));
    else rmSync(expected);
  }
});

test("encoded Windows commands enforce argument and HTTP boundaries before launch", () => {
  expect(() => windowsNativeArgv("x", ["\0"])).toThrow();
  expect(() => powershellArgv("x".repeat(20_000))).toThrow();
  expect(() => quoteRemote(["powershell.exe", "-Command", "x"])).toThrow();
  expect(() => windowsChildHttpArgv(0, "healthz", 100)).toThrow();
  expect(() => windowsChildHttpArgv(10100, "healthz", Number.NaN)).toThrow();
});

for (const scenario of ["success", "redirect", "oversize", "invalid UTF-8", "stalled body"] as const) {
  test.skipIf(process.platform !== "win32")(`Windows Child HTTP handles ${scenario} without proxying or following redirects`, async () => {
    let redirected = 0, proxied = 0;
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { proxied++; return new Response("unexpected proxy", { status: 502 }); } });
    let release: (() => void) | undefined;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/unexpected") { redirected++; return new Response("unexpected"); }
      if (scenario === "redirect") return new Response(null, { status: 302, headers: { location: "/unexpected" } });
      if (scenario === "oversize") return new Response(new Uint8Array(4 * 1024 * 1024 + 1));
      if (scenario === "invalid UTF-8") return new Response(new Uint8Array([0xff]));
      if (scenario === "stalled body") return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        // A cancelled stream rejects close with TypeError; any other failure is a real fixture bug.
        release = () => { try { controller.close(); } catch (error) { if (!(error instanceof TypeError)) throw error; } };
      } }));
      return Response.json({ models: [] });
    } });
    try {
      const child = Bun.spawn(windowsChildHttpArgv(server.port!, "v1/catalog", 250), {
        env: { ...process.env, HTTP_PROXY: proxy.url.toString(), HTTPS_PROXY: proxy.url.toString(), ALL_PROXY: proxy.url.toString(), NO_PROXY: "" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      await new Response(child.stderr).text();
      expect(code).toBe(scenario === "success" ? 0 : 1);
      if (scenario === "success") expect(stdout).toBe('{"models":[]}\n200');
      expect(redirected).toBe(0); expect(proxied).toBe(0);
    } finally { release?.(); server.stop(true); proxy.stop(true); }
  });
}

test("encoded Windows ocx commands keep argument data inert and reject NUL", () => {
  const argv = remoteOcxArgv(["connect", "--key-stdin", "space and 'quotes' & $() 雪"], "windows");
  expect(argv.slice(0, 5)).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  expect(quoteRemote(argv)).toBe(argv.join(" "));
  expect(quoteRemote(argv)).not.toContain("space and");
  expect(() => remoteOcxArgv(["bad\0argument"], "windows")).toThrow();
});

test.skipIf(process.platform !== "win32")("closing the SSH channel terminates the remote ocx and its PowerShell host", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-windows-job-")); roots.push(home);
  const script = join(home, "hold.ts");
  const pidFile = join(home, "child.pid");
  writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);");
  // The SSH server ends a dropped channel by terminating the host it started; do the same.
  const host = Bun.spawn(windowsNativeArgv(process.execPath, [script, pidFile]), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const deadline = performance.now() + 30_000;
  while (!existsSync(pidFile) && performance.now() < deadline) await Bun.sleep(25);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  host.kill();
  await host.exited;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (alive() && performance.now() < deadline) await Bun.sleep(25);
  expect(alive()).toBe(false);
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform !== "win32")("a Windows ocx that cannot be contained in a kill-on-close job is refused before it runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-windows-refuse-")); roots.push(home);
  const marker = join(home, "ran");
  const script = join(home, "mark.ts");
  writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], 'ran');");
  // Constrained Language Mode blocks Add-Type, so the Job helper cannot exist; the session enters
  // it before the unchanged script runs.
  const native = windowsNativeArgv(process.execPath, [script, marker]);
  const constrained = powershellArgv("$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'\n" + Buffer.from(native.at(-1)!, "base64").toString("utf16le"));
  const child = Bun.spawn(constrained, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  expect(code).toBe(WINDOWS_CONTAINMENT_EXIT);
  expect(existsSync(marker)).toBe(false);
}, SPAWN_BUDGET_MS);

// Required native release gate: set OCX_WINDOWS_OPENSSH_FIXTURE to a key-authenticated SSH alias of a
// disposable Windows x64 OpenSSH host (cmd.exe or PowerShell default shell). Never a real user host.
const OPENSSH_FIXTURE = process.env.OCX_WINDOWS_OPENSSH_FIXTURE;
test.skipIf(!OPENSSH_FIXTURE)("dropping a real OpenSSH channel kills the contained remote process", async () => {
  const alias = OPENSSH_FIXTURE!;
  const ssh = (argv: string[]) => ["ssh", "-o", "BatchMode=yes", "--", alias, quoteRemote(argv)];
  const remote = async (script: string) => {
    const child = Bun.spawn(ssh(powershellArgv(script)), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return stdout.trim();
  };
  const pidFile = "$env:TEMP\\ocx-job-fixture.pid";
  await remote(`Remove-Item "${pidFile}" -EA 0`);
  const held = Bun.spawn(ssh(windowsNativeArgv("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-Command", `$PID|Set-Content "${pidFile}";Start-Sleep 600`])), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const deadline = performance.now() + 60_000;
  let pid = "";
  while (!/^\d+$/.test(pid) && performance.now() < deadline) {
    pid = await remote(`Get-Content "${pidFile}" -EA 0`);
    if (!/^\d+$/.test(pid)) await Bun.sleep(500);
  }
  expect(pid).toMatch(/^\d+$/);
  held.kill();
  await held.exited;
  let state = "alive";
  while (state !== "gone" && performance.now() < deadline) {
    state = await remote(`if(Get-Process -Id ${pid} -EA 0){'alive'}else{'gone'}`);
    if (state !== "gone") await Bun.sleep(500);
  }
  expect(state).toBe("gone");
}, 90_000);

test("the shared fixture decoder reads back exactly the arguments the Windows builders encode", () => {
  const args = ["connect", "--link", "--key-stdin", "--tunnel-port", "2200", "--link-id", "lnk_0123456789abcdef", "", "space 'q' \"d\" 雪"];
  const script = (argv: string[]) => Buffer.from(argv[5]!, "base64").toString("utf16le");
  expect(windowsScriptData(script(windowsOcxArgv(args)))).toEqual({ args });
  expect(windowsScriptData(script(windowsNativeArgv("C:\\fixture\\ocx.exe", args)))).toEqual({ executable: "C:\\fixture\\ocx.exe", args });
  expect(windowsScriptData(script(windowsChildHttpArgv(10100, "healthz", 100)))).toBeUndefined();
});

test("the Windows command carries the containment helper source intact", () => {
  const script = Buffer.from(windowsOcxArgv(["--version"])[5]!, "base64").toString("utf16le");
  expect(windowsScriptHelperSource(script)).toBe(OCX_JOB_SOURCE);
  expect(OCX_JOB_SOURCE).toContain("0x2000D");
  expect(OCX_JOB_SOURCE).not.toContain("ResumeThread");
});
