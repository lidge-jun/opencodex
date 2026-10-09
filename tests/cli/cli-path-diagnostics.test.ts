import { describe, expect, test } from "bun:test";
import { chmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCliPathDiagnostics, formatCliCommandLine, formatCliStatusHealthLabel, cliCommandDoctorChecks, type CliPathDiagnosticOptions, type CliPathObservation } from "../../src/cli/cli-path-diagnostics";
import { readDesktopCliRecord, desktopCliRecordPath, DESKTOP_CLI_RECORD_MAX_BYTES, type DesktopCliRecordDeps, type DesktopCliRecordRead } from "../../src/lib/desktop-cli-record.mjs";
import { repoPath } from "../helpers/repo-root";

// The pending-cleanup case reads a macOS record on every CI host. NTFS reports POSIX
// owner/mode bits the reader rejects, and only macOS ships the `ls -lde` ACL probe,
// so non-mac hosts substitute the safe stats a real macOS record directory would have.
const macRecordOnHost: DesktopCliRecordDeps = {
  ...(process.platform === "win32" ? {
    euid: 0,
    lstat: (path: string) => { const stat = lstatSync(path); stat.uid = 0; stat.mode = stat.isDirectory() ? 0o40700 : 0o100600; return stat; },
    fstat: (fd: number) => { const stat = fstatSync(fd); stat.uid = 0; stat.mode = 0o100600; return stat; },
  } : {}),
  ...(process.platform === "darwin" ? {} : { checkAcl: () => true }),
};

function record(platform: NodeJS.Platform, target: string): DesktopCliRecordRead {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new Error("Unsupported fixture platform");
  return { state: "ready", path: "fixture", record: { platform, kind: platform === "win32" ? "windows-install" : platform === "darwin" ? "macos-app" : "linux-deb", cliExecutable: target } };
}
function fixture(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, files: string[], extra: Partial<CliPathDiagnosticOptions> = {}) {
  const windows = platform === "win32";
  const normalize = (path: string) => windows ? path.toLowerCase() : path;
  const present = new Set(files.map(normalize));
  let observations = 0;
  const observe = (path: string): CliPathObservation => { observations++; return present.has(normalize(path)) ? { kind: "usable", realpath: path } : { kind: "missing" }; };
  const result = collectCliPathDiagnostics({ platform, env, cwd: windows ? "C:\\work" : "/work", home: windows ? "C:\\Users\\example" : "/Users/example", recordRead: record(platform, windows ? "C:\\App\\ocx.exe" : "/Applications/OpenCodex.app/Contents/MacOS/ocx"), observe, ...extra });
  return { result, observations };
}
const desktopBin = "/Users/example" + "/.opencodex-desktop/bin";
const shim = desktopBin + "/ocx";
const target = "/Applications/OpenCodex.app/Contents/MacOS/ocx";
describe("observed ocx PATH selection", () => {
  test("POSIX Desktop shim first, npm later; never executes candidates", () => {
    const { result } = fixture("darwin", { PATH: `${desktopBin}:/npm/bin` }, [shim, target, "/npm/bin/ocx"]);
    expect(result.pathFirst?.path).toBe(shim); expect(result.expectedExecutable).toBe(shim);
    expect(result.desktopFirstOnPath).toBe(true); expect(result.shellResolution).toBe("unobserved"); expect(result.issues).toEqual([]);
    const source = readFileSync(repoPath("src", "cli", "cli-path-diagnostics.ts"), "utf8");
    expect(source).not.toMatch(/child_process|Bun\.spawn|execSync|spawnSync/);
  });
  test("npm first is an issue even if that launcher can hand off", () => {
    const { result } = fixture("linux", { PATH: `/npm/bin:${desktopBin}` }, ["/npm/bin/ocx", shim, target]);
    expect(result.pathFirst?.path).toBe("/npm/bin/ocx"); expect(result.desktopFirstOnPath).toBe(false); expect(result.issues).toContain("path-first-not-desktop");
    expect(cliCommandDoctorChecks(result)[0]!.level).toBe("WARN");
  });
  test("POSIX empty and relative PATH elements resolve against cwd; absent PATH differs", () => {
    for (const path of [":/bin", ".:/bin", "tools:/bin"]) {
      const { result } = fixture("linux", { PATH: path }, ["/work/ocx", "/work/tools/ocx", "/bin/ocx", shim, target]);
      expect(result.pathFirst?.path).toBe(path.startsWith("tools") ? "/work/tools/ocx" : "/work/ocx");
    }
    expect(fixture("linux", {}, ["/work/ocx", shim, target]).result.pathFirst).toBeNull();
    expect(fixture("linux", { PATH: "" }, ["/work/ocx", shim, target]).result.pathFirst?.path).toBe("/work/ocx");
  });
  test("Windows PATHEXT order, case-insensitive Path, quotes and bundled expected exe", () => {
    const { result } = fixture("win32", { Path: '"C:\\App";C:\\npm', PathExt: ".CMD;.EXE" }, ["C:\\App\\ocx.exe", "C:\\App\\ocx.cmd", "C:\\npm\\ocx.cmd"]);
    expect(result.pathFirst?.extension).toBe(".cmd"); expect(result.expectedExecutable).toBe("C:\\App\\ocx.exe"); expect(result.issues).toContain("path-first-not-desktop");
    const selected = fixture("win32", { PATH: "c:\\app", PATHEXT: ".EXE;.CMD" }, ["C:\\App\\ocx.exe"]).result;
    expect(selected.desktopFirstOnPath).toBe(true);
    expect(selected.packageHandoff).toBe("disabled-on-windows");
    expect(selected.handoffTarget).toBeNull();
    expect(formatCliCommandLine(selected)).toContain("package handoff=disabled on Windows");
    expect(formatCliCommandLine(selected)).toContain("PATH first=c:\\app\\ocx.exe");
  });
  test("Windows empty entry and cmd cwd candidate remain distinct from PATH first", () => {
    const row = fixture("win32", { PATH: "C:\\App", PATHEXT: ".EXE" }, ["C:\\App\\ocx.exe", "C:\\work\\ocx.exe"]).result;
    expect(row.pathFirst?.path).toBe("C:\\App\\ocx.exe"); expect(row.currentDirectoryCandidate?.path).toBe("C:\\work\\ocx.exe"); expect(row.issues).toContain("windows-current-directory-shadow");
    expect(fixture("win32", { PATH: ";C:\\App", PATHEXT: ".EXE" }, ["C:\\work\\ocx.exe", "C:\\App\\ocx.exe"]).result.pathFirst?.path).toBe("C:\\work\\ocx.exe");
  });
  test("invalid PATHEXT entries ignored; extensionless last; missing PATH and bounded scan", () => {
    const row = fixture("win32", { PATH: "C:\\npm", PATHEXT: ".EXE;bad;../evil;.CMD" }, ["C:\\npm\\ocx", "C:\\App\\ocx.exe"]).result;
    expect(row.pathFirst?.extension).toBe("");
    expect(fixture("linux", {}, [shim, target]).result.issues).toContain("path-missing");
    const long = fixture("linux", { PATH: Array(257).fill("/missing").join(":") }, [shim, target]);
    expect(long.result.issues).toContain("path-scan-truncated"); expect(long.observations).toBe(258); expect(long.result.desktopFirstOnPath).toBeNull();
    const extensions = Array.from({ length: 33 }, (_, i) => `.x${i}`).join(";");
    expect(fixture("win32", { PATH: "C:\\App", PATHEXT: extensions }, ["C:\\App\\ocx.exe"]).result.issues).toContain("path-scan-truncated");
  });
  test("missing or disabled Desktop is informational; bad records and missing target fail", () => {
    for (const state of ["missing", "disabled"] as const) {
      const row = fixture("linux", { PATH: "/npm" }, ["/npm/ocx"], { recordRead: state === "disabled" ? { state, path: "fixture", cleanupPending: false } : { state, path: "fixture" } }).result;
      expect(row.desktopFirstOnPath).toBeNull(); expect(cliCommandDoctorChecks(row)[0]!.level).toBe("OK");
    }
    for (const issue of ["record-invalid", "record-too-large", "record-pending", "record-unreadable", "record-unsafe"] as const) {
      const row = fixture("linux", {}, [], { recordRead: { state: issue === "record-unreadable" ? "unreadable" : "invalid", path: "fixture", issue } }).result;
      expect(row.issues).toContain(issue); expect(cliCommandDoctorChecks(row)[0]!.level).toBe("FAIL");
    }
    const missing = fixture("linux", { PATH: "/npm" }, ["/npm/ocx"]).result;
    expect(missing.issues).toContain("desktop-target-missing"); expect(missing.issues).toContain("expected-command-missing");
  });
  test("disabled pending cleanup warns without selecting a target; enabled pending fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-pending-"));
    try {
      const path = desktopCliRecordPath({ platform: process.platform, home: root });
      mkdirSync(join(root, ".opencodex-desktop"), { mode: 0o700 });
      for (const [name, issue, level] of [
        ["disabled-with-pending", "cleanup-pending", "WARN"],
        ["pending-enabled", "record-pending", "FAIL"],
        ["first-pending", "record-pending", "FAIL"],
      ] as const) {
        writeFileSync(path, readFileSync(repoPath("tests", "fixtures", "desktop-cli-record", `${name}.json`)), { mode: 0o600 });
        const read = readDesktopCliRecord({ platform: "darwin", home: root, recordPath: path }, macRecordOnHost);
        if (issue === "cleanup-pending") expect(read).toEqual({ state: "disabled", path, cleanupPending: true });
        else expect(read).toEqual({ state: "invalid", path, issue });
        const row = collectCliPathDiagnostics({ platform: "darwin", home: root, cwd: root, env: { PATH: "" }, observe: () => ({ kind: "missing" }), recordRead: process.platform === "darwin" ? undefined : read });
        expect(row.configured).toBe(false);
        expect(row.handoffTarget).toBeNull();
        expect(row.expectedExecutable).toBeNull();
        expect(row.desktopFirstOnPath).toBeNull();
        expect(row.issues).toEqual([issue]);
        const check = cliCommandDoctorChecks(row)[0]!;
        expect(check.level).toBe(level);
        if (level === "FAIL") {
          expect(check.message).toContain("Open OpenCodex Desktop to repair the terminal command");
          expect(check.message).toContain("OCX_NO_DESKTOP_HANDOFF=1");
          expect(check.message).not.toMatch(/delet|remov/i);
        } else expect(check.message).toContain("finish terminal-command cleanup");
      }
      writeFileSync(path, "x".repeat(DESKTOP_CLI_RECORD_MAX_BYTES + 1), { mode: 0o600 });
      const tooLargeRead = process.platform === "darwin" ? undefined : readDesktopCliRecord({ platform: "darwin", home: root, recordPath: path }, macRecordOnHost);
      const tooLarge = collectCliPathDiagnostics({ platform: "darwin", home: root, cwd: root, env: {}, observe: () => ({ kind: "missing" }), recordRead: tooLargeRead });
      expect(tooLarge.issues).toEqual(["record-too-large"]);
      expect(cliCommandDoctorChecks(tooLarge)[0]!.message).toContain(`${DESKTOP_CLI_RECORD_MAX_BYTES} bytes`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("unusable/unreadable observations have named codes and no false OK", () => {
    const row = fixture("linux", { PATH: "/bad" }, [], { observe: path => path === target ? { kind: "unusable" } : path === shim ? { kind: "unusable" } : { kind: "unreadable" } }).result;
    expect(row.issues).toEqual(expect.arrayContaining(["desktop-target-unusable", "expected-command-unusable", "path-unreadable"]));
    expect(row.desktopFirstOnPath).toBeNull();
    expect(cliCommandDoctorChecks(row)[0]!.level).toBe("FAIL");
  });
  test("realpath alias of owned command compares physically and output stays one safe line", () => {
    const row = fixture("linux", { PATH: "/alias" }, [], { observe: path => ({ kind: "usable", realpath: path === target ? target : shim }) }).result;
    expect(row.desktopFirstOnPath).toBe(true);
    const line = formatCliCommandLine(row); expect(line).toContain("shell=unobserved"); expect(line).not.toContain("\n");
    const unsafe = { ...row, pathFirst: { ...row.pathFirst!, path: "/fixture/line\nbreak/ocx" } };
    expect(formatCliCommandLine(unsafe)).not.toContain("\n");
  });
  test("connected status adapter renders one command line and preserves local labels", () => {
    const row = fixture("linux", { PATH: "/npm" }, ["/npm/ocx", shim, target]).result;
    for (const connected of [false, true]) {
      const rendered = `Health: ${formatCliStatusHealthLabel("healthy", row, connected)}${connected ? " (local)" : ""}`;
      const lines = rendered.split("\n"); expect(lines).toHaveLength(2);
      for (const line of lines) expect(line.includes(" (local)")).toBe(connected);
      expect(lines[1]).toContain("ocx command:");
    }
    const json = JSON.parse(JSON.stringify({ proxy: { health: { message: "healthy" } }, cliCommand: row }));
    expect(json.proxy.health.message).toBe("healthy");
  });
  (process.platform === "win32" ? test.skip : test)("default observer rejects directory/non-executable and observes physical symlink without execution", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-observe-"));
    try {
      const bin = join(root, ".opencodex-desktop", "bin"); mkdirSync(bin, { recursive: true });
      const target = join(root, "ocx-target"); writeFileSync(target, "fixture; never executed"); chmodSync(target, 0o755);
      const shimPath = join(bin, "ocx"); symlinkSync(target, shimPath);
      const platform = process.platform;
      const options = { platform, home: root, cwd: root, recordRead: record(platform, target), env: { PATH: bin } };
      expect(collectCliPathDiagnostics(options).desktopFirstOnPath).toBe(true);
      rmSync(shimPath); mkdirSync(shimPath);
      expect(collectCliPathDiagnostics(options).issues).toContain("expected-command-unusable");
      rmSync(shimPath, { recursive: true }); writeFileSync(shimPath, "fixture"); chmodSync(shimPath, 0o600);
      expect(collectCliPathDiagnostics(options).issues).toContain("expected-command-unusable");
      expect(collectCliPathDiagnostics({ ...options, env: { PATH: target } }).pathFirst).toBeNull();
      rmSync(shimPath); symlinkSync(shimPath, shimPath);
      expect(collectCliPathDiagnostics(options).issues).toContain("path-unreadable");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("status JSON field and human line, doctor independent registration, root dispatcher untouched", () => {
    const status = readFileSync(repoPath("src", "cli", "status.ts"), "utf8");
    expect(status).toContain("cliCommand: CliPathDiagnostics;"); expect(status).toContain("      cliCommand,");
    expect(status).toContain("formatCliStatusHealthLabel(health.label, cliCommand, remoteHub.connected)");
    const doctor = readFileSync(repoPath("src", "cli", "doctor.ts"), "utf8");
    expect(doctor).toContain('console.log("\\nocx command selection")'); expect(doctor).toContain('if (check.level === "FAIL") recordDoctorFailure()');
    expect(doctor.indexOf('console.log("Paths")')).toBeLessThan(doctor.indexOf('console.log("\\nocx command selection")'));
    expect(doctor.indexOf('console.log("\\nocx command selection")')).toBeLessThan(doctor.indexOf('console.log("\\nResponse-state temp files")'));
    expect(doctor.indexOf('console.log("\\nocx command selection")')).toBeLessThan(doctor.indexOf('console.log("\\nCodex runtime selection")'));
    const json = JSON.parse(JSON.stringify(fixture("linux", { PATH: "/npm" }, ["/npm/ocx", shim, target]).result));
    expect(json.pathFirst.path).toBe("/npm/ocx"); expect(json.shellResolution).toBe("unobserved");
  });

  (process.platform === "win32" ? test.skip : test)("unsafe record is a doctor FAIL with its path and no configured target", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-unsafe-"));
    try {
      mkdirSync(join(root, ".opencodex-desktop"), { mode: 0o700 });
      const path = desktopCliRecordPath({ home: root });
      writeFileSync(path, '{"version":1,"enabled":false}', { mode: 0o600 });
      chmodSync(path, 0o644);
      const row = collectCliPathDiagnostics({ home: root, cwd: root, env: { PATH: "" }, observe: () => ({ kind: "missing" }) });
      expect(row.issues).toEqual(["record-unsafe"]);
      expect(row.configured).toBe(false);
      expect(row.handoffTarget).toBeNull();
      const check = cliCommandDoctorChecks(row)[0]!;
      expect(check.level).toBe("FAIL");
      expect(check.message).toContain(path);
      expect(check.message).toContain("OCX_NO_DESKTOP_HANDOFF=1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("Windows unsafe records still report a PATH first candidate with handoff disabled", () => {
    const row = fixture("win32", { PATH: "C:\\npm", PATHEXT: ".CMD" }, ["C:\\npm\\ocx.cmd"], {
      recordRead: { state: "invalid", path: "C:\\Desktop\\cli.json", issue: "record-unsafe" },
    }).result;
    expect(row.pathFirst?.path).toBe("C:\\npm\\ocx.cmd");
    expect(row.packageHandoff).toBe("disabled-on-windows");
    expect(row.handoffTarget).toBeNull();
    expect(row.issues).toContain("record-unsafe");
    const check = cliCommandDoctorChecks(row)[0]!;
    expect(check.level).toBe("FAIL");
    expect(check.message).toContain("package handoff=disabled on Windows");
    expect(check.message).not.toContain("OCX_NO_DESKTOP_HANDOFF=1");
  });
});
