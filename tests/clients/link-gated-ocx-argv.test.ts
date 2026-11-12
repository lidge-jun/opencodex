import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { LinkSshArgumentError, remoteGatedOcxArgv, remotePinnedSyncArgv } from "../../src/link/ssh-argv";
import { POWERSHELL_ENCODED_MAX, windowsScriptData } from "../../src/link/remote-windows";
import { classifyUpdateApply, classifyUpdatePlanProbe, readGatedFraming, remoteUpdateApplyArgv, remoteUpdatePlanArgv } from "../../src/link/child-gated-ocx";
import { classifySyncResult as linkClassifySyncResult } from "../../src/link/sync-fanout-classify";
import { classifySyncResult as cliClassifySyncResult, runHomeFanout } from "../../src/cli/sync-fanout";
import { recordServingRuntime } from "../../src/config/serving-runtimes";
import type { LinkRecord } from "../../src/link/store";

const LINK = "lnk_0123456789abcdef";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-";
const posix = test.skipIf(process.platform === "win32");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** The shipped script with the machine's own install locations swapped for missing paths. */
function isolated(argv: string[]): string[] {
  const copy = [...argv];
  copy[2] = copy[2]!.replace('export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"', 'export PATH="$PATH"')
    .replace('"/Applications/OpenCodex.app/Contents/MacOS/ocx"', '"$HOME/missing-app"').replace('"/usr/bin/ocx"', '"$HOME/missing-system"');
  return copy;
}
function fixture(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix)); dirs.push(home);
  const bin = join(home, "bin"); mkdirSync(bin);
  for (const command of ["sh", "uname", "mktemp", "sleep", "cat", "awk", "dd", "wc", "rm", "date"]) {
    const executable = Bun.which(command);
    if (!executable) throw new Error("Required test tool not found on PATH: " + command);
    symlinkSync(executable, join(bin, command));
  }
  return { home, bin };
}
/** A fake executable that logs its arguments and answers --version with the given text. */
function fakeOcx(path: string, version: string, extra = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/calls\"\n" + extra + "if [ \"$1\" = --version ]; then printf '%s\\n' '" + version + "'; exit 0; fi\nprintf 'ran\\n'\n", { mode: 0o755 });
}
function runIn(home: string, bin: string, argv: string[]) {
  const proc = Bun.spawnSync(isolated(argv), { env: { HOME: home, OPENCODEX_HOME: join(home, "ocx-home"), CODEX_HOME: join(home, "codex-home"), TMPDIR: home, PATH: bin }, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(),
    calls: existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "",
    remaining: readdirSync(home).filter(name => name.startsWith("ocx-fanout.")) };
}
function desktopRun(version: string, argv: string[]) {
  const { home, bin } = fixture("ocx-gated-");
  fakeOcx(join(home, ".opencodex-desktop", "bin", "ocx"), version);
  return runIn(home, bin, argv);
}
function childFixture() {
  const { home, bin } = fixture("ocx-gated-child-");
  fakeOcx(join(home, ".local", "bin", "ocx-child"), "opencodex 2.98.0");
  mkdirSync(join(home, "ocx-home", "child"), { recursive: true });
  writeFileSync(join(home, "ocx-home", "child", "state.json"), "{}");
  return { home, bin };
}
function inflated(argv: string[]): string {
  const outer = Buffer.from(argv[5]!, "base64").toString("utf16le");
  const packed = /\$ocxPacked='([^']+)'/.exec(outer)?.[1];
  if (!packed) throw new Error("not a packed PowerShell command");
  return inflateRawSync(Buffer.from(Array.from(packed, ch => ch.charCodeAt(0) - 256))).toString("utf8");
}
const planArgv = () => remoteUpdatePlanArgv("2.100.0", "posix");
const applyArgv = (planToken = TOKEN) => remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken, notAfter: 1_900_000_000_000, viaLauncher: false }, "posix");

describe("update gate on fake executables", () => {
  posix("update gate never sends update to 2.96.0", () => {
    for (const argv of [planArgv(), applyArgv()]) {
      const result = desktopRun("2.96.0", argv);
      expect(result.code).toBe(121);
      expect(result.stderr).toBe("ocx-fanout:child-ocx-lacks-orchestrated-update\n");
      expect(result.calls).toBe("--version\n");
      expect(result.remaining).toEqual([]);
    }
  });

  posix("update gate refuses 2.97.0-preview.1", () => {
    const result = desktopRun("2.97.0-preview.1", planArgv());
    expect(result.code).toBe(121);
    expect(result.stderr).toBe("ocx-fanout:child-ocx-lacks-orchestrated-update\n");
    expect(result.calls).toBe("--version\n");
  });

  posix.each(["2.97.0", "2.100.0+build.1"])("update gate accepts %s", version => {
    const result = desktopRun(version, planArgv());
    expect(result.code).toBe(0);
    expect(result.calls).toBe("--version\nupdate --plan --json --version 2.100.0\n");
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines.slice(0, 2)).toEqual(["ocx-fanout:selected:" + version, "ocx-fanout:entry:binary"]);
    expect(result.stdout).toBe("ocx-fanout:stdout-begin\nran\n");
  });

  posix("apply argv carries the plan token and deadline", () => {
    const result = desktopRun("2.97.0", applyArgv());
    expect(result.code).toBe(0);
    expect(result.calls).toBe("--version\nupdate --yes --json --version 2.100.0 --expect-plan " + TOKEN + " --not-after 1900000000000\n");
    expect(result.stderr).toBe("ocx-fanout:selected:2.97.0\nocx-fanout:entry:binary\n");
  });

  posix("a Desktop handoff cannot answer the version probe for the selected launcher", () => {
    const { home, bin } = fixture("ocx-gated-handoff-");
    const launcher = join(home, ".opencodex-desktop", "bin", "ocx");
    mkdirSync(join(launcher, ".."), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/calls\"\nif [ \"$1\" = --version ]; then if [ -z \"$OCX_NO_DESKTOP_HANDOFF\" ]; then echo 2.99.0; else echo 2.93.0; fi; exit 0; fi\necho ran\n", { mode: 0o755 });
    const result = runIn(home, bin, planArgv());
    expect(result.code).toBe(121);
    expect(result.stderr).toBe("ocx-fanout:child-ocx-lacks-orchestrated-update\n");
    expect(result.calls).toBe("--version\n");
  });

  posix("served package pair reports entry:pair", () => {
    const { home, bin } = fixture("ocx-gated-served-");
    const pkg = join(home, "npm prefix", "opencodex"); mkdirSync(pkg, { recursive: true });
    const bun = join(pkg, "bun"), cli = join(pkg, "index.ts");
    writeFileSync(bun, "#!/bin/sh\nprintf 'served %s\\n' \"$*\" >> \"$HOME/calls\"\nif [ \"$2\" = --version ]; then printf 'opencodex 2.98.0\\n'; exit 0; fi\nprintf 'ran\\n'\n", { mode: 0o755 });
    writeFileSync(cli, "// entry\n");
    recordServingRuntime({ command: [bun, cli], version: "2.98.0", servedAt: "2026-11-09T00:00:00.000Z" }, join(home, "ocx-home"));
    const result = runIn(home, bin, planArgv());
    expect(result.code).toBe(0);
    expect(result.calls).toBe("served " + cli + " --version\nserved " + cli + " update --plan --json --version 2.100.0\n");
    expect(result.stderr.split("\n").slice(0, 2)).toEqual(["ocx-fanout:selected:2.98.0", "ocx-fanout:entry:pair"]);
  });

  posix("update gate refuses a selected ocx-child", () => {
    const { home, bin } = childFixture();
    for (const argv of [planArgv(), applyArgv()]) {
      rmSync(join(home, "calls"), { force: true });
      const result = runIn(home, bin, argv);
      expect(result.code).toBe(121);
      expect(result.stderr).toBe("ocx-fanout:child-ocx-ephemeral\n");
      expect(result.calls).toBe("--version\n");
      expect(result.remaining).toEqual([]);
    }
  });

  posix("sync gate still runs ocx-child", () => {
    const { home, bin } = childFixture();
    const result = runIn(home, bin, remotePinnedSyncArgv(LINK, "posix"));
    expect(result.code).toBe(0);
    expect(result.calls).toBe("--version\nsync --expect-link " + LINK + " --json\n");
    expect(result.stderr).toBe("ocx-fanout:selected:2.98.0\n");
  });
});

describe("pinned sync options", () => {
  posix.each([["app-server", "--restart-app-server-only"], ["codex", "--restart-codex"]] as const)("restart %s adds exactly one flag", (restart, flag) => {
    const result = desktopRun("2.93.0", remotePinnedSyncArgv(LINK, "posix", { restart }));
    expect(result.code).toBe(0);
    expect(result.calls).toBe("--version\nsync --expect-link " + LINK + " --json " + flag + "\n");
    expect(() => remotePinnedSyncArgv(LINK, "windows", { restart })).toThrow(new LinkSshArgumentError("unsupported:windows-restart"));
  });

  posix("no option leaves the sync arguments unchanged", () => {
    expect(desktopRun("2.93.0", remotePinnedSyncArgv(LINK, "posix", {})).calls).toBe("--version\nsync --expect-link " + LINK + " --json\n");
    expect(windowsScriptData(Buffer.from(remotePinnedSyncArgv(LINK, "windows")[5]!, "base64").toString("utf16le")))
      .toEqual({ args: ["sync", "--expect-link", LINK, "--json"] });
  });

  posix("selected kind is reported only for a restarting sync that selects ocx-child", () => {
    const { home, bin } = childFixture();
    const restarting = runIn(home, bin, remotePinnedSyncArgv(LINK, "posix", { restart: "app-server" }));
    expect(restarting.stderr).toBe("ocx-fanout:selected:2.98.0\nocx-fanout:selected-kind:ocx-child\n");
    expect(linkClassifySyncResult({ code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.\n", stderr: restarting.stderr }, { expectSelectedKind: true }))
      .toEqual({ state: "synced", reason: null, executable: "ocx-child" });
    const plain = runIn(home, bin, remotePinnedSyncArgv(LINK, "posix"));
    expect(plain.stderr).toBe("ocx-fanout:selected:2.98.0\n");
    expect(desktopRun("2.93.0", remotePinnedSyncArgv(LINK, "posix", { restart: "codex" })).stderr).toBe("ocx-fanout:selected:2.93.0\n");
  });

  test("classifySyncResult refuses two selected-kind lines", () => {
    const stderr = "ocx-fanout:selected:2.98.0\nocx-fanout:selected-kind:ocx-child\nocx-fanout:selected-kind:ocx-child\n";
    expect(linkClassifySyncResult({ code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.\n", stderr }, { expectSelectedKind: true }))
      .toEqual({ state: "failed", reason: "child-output-invalid" });
  });

  test.each(["ocx-child", "other", "ocx-child\nocx-fanout:selected-kind:ocx-child"])("a plain sync ignores a selected-kind:%s line", kind => {
    const verdict = linkClassifySyncResult({ code: 0, stdout: "ocx-fanout:stdout-begin\nRemote Link Home catalog synchronized.",
      stderr: "ocx-fanout:selected:2.95.0\nocx-fanout:selected-kind:" + kind + "\n" });
    expect(verdict).toEqual({ state: "synced", reason: null });
    expect(Object.hasOwn(verdict, "executable")).toBe(false);
  });

  test("the public fan-out row never carries executable", async () => {
    const link: LinkRecord = { id: LINK, alias: "host1", direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 25000,
      apiKeyId: "key1", createdAt: "2026-01-01T00:00:00Z", remotePlatform: "posix" };
    const result = await runHomeFanout({
      home: { state: "synced", exit: 0 }, catalogCurrent: true,
      readStore: () => ({ version: 1, listenerPort: 27000, links: [link] }),
      readLinkStatus: async () => ({ role: "home", listener: { state: "listening", port: 27000 }, child: null, links: [{ ...link, state: "connected", since: link.createdAt,
        reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null }] }),
      runChild: async () => ({ state: "synced", reason: null, exit: 0, executable: "ocx-child" }) as never,
    });
    expect(result.children).toEqual([{ linkId: LINK, alias: "host1", state: "synced", reason: null, exit: 0 }]);
    expect(Object.hasOwn(result.children[0]!, "executable")).toBe(false);
  });

  test("classifier move keeps one function", () => {
    expect(cliClassifySyncResult).toBe(linkClassifySyncResult);
  });
});

describe("Windows scripts", () => {
  test("Windows update script", () => {
    const argv = remoteUpdatePlanArgv("2.100.0", "windows");
    expect(argv[5]!.length).toBeLessThanOrEqual(POWERSHELL_ENCODED_MAX);
    expect(windowsScriptData(Buffer.from(argv[5]!, "base64").toString("utf16le"))).toEqual({ args: ["update", "--plan", "--json", "--version", "2.100.0"] });
    const script = inflated(argv);
    expect(script).toContain("$b=@('2','97','0')");
    expect(script).toContain("ocx-fanout:child-ocx-lacks-orchestrated-update");
    expect(script).toContain("if($x -match '(^|[\\\\/])ocx-child[^\\\\/]*$'){[Console]::Error.WriteLine('ocx-fanout:child-ocx-ephemeral');exit 121}");
    // Windows reads no census, so the Home infers entry "binary" and the script prints no entry marker.
    expect(script).not.toContain("ocx-fanout:entry:");
    expect(script).toContain("$env:OCX_NO_DESKTOP_HANDOFF='1'");
  });

  test.each(["2.100.0", "2.100.0-preview.20261111", "9999.9999.9999-preview.20261111.12345678"])("the Windows plan probe fits for Home %s", version => {
    const argv = remoteUpdatePlanArgv(version, "windows");
    expect(argv[5]!.length).toBeLessThanOrEqual(POWERSHELL_ENCODED_MAX);
    expect(windowsScriptData(Buffer.from(argv[5]!, "base64").toString("utf16le"))).toEqual({ args: ["update", "--plan", "--json", "--version", version] });
  });

  test("a Windows command over the budget throws the named error", () => {
    const version = "1.0.0-a" + createHash("sha512").update("x").digest("hex").slice(0, 120);
    expect(version.length).toBeLessThanOrEqual(128);
    expect(() => remoteUpdatePlanArgv(version, "windows")).toThrow(new LinkSshArgumentError("windows-command-too-long"));
  });

  test("the plan probe infers entry binary on Windows", () => {
    const plan = { schema: "ocx.update.plan/1", currentVersion: "2.97.0", targetVersion: "2.100.0", installer: "npm", runtimeOwner: "service",
      servingPath: "C:\\ocx", cliPath: "C:\\ocx", canApply: true, restartRequired: true, planToken: TOKEN, updateInFlight: false, mutationBoundMs: 900_000 };
    const verdict = classifyUpdatePlanProbe({ code: 0, stdout: "ocx-fanout:stdout-begin\n" + JSON.stringify(plan) + "\n", stderr: "ocx-fanout:selected:2.97.0\n" },
      { homeVersion: "2.100.0", desktopUpdateRequest: false, platform: "windows" });
    expect(verdict).toMatchObject({ kind: "plan", classification: { updateRoute: "orchestrated", installKind: "npm" } });
  });

  test("Windows restart and Windows apply are refused by the shipped builders", () => {
    expect(() => remotePinnedSyncArgv(LINK, "windows", { restart: "codex" })).toThrow(new LinkSshArgumentError("unsupported:windows-restart"));
    expect(() => remotePinnedSyncArgv(LINK, "windows", { restart: "app-server" })).toThrow(new LinkSshArgumentError("unsupported:windows-restart"));
    expect(() => remoteGatedOcxArgv({ minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: true, reportClock: false,
      launcher: "none", args: ["update", "--yes", "--json", "--version", "2.100.0"] }, "windows")).toThrow(new LinkSshArgumentError("unsupported:windows-apply"));
    expect(remotePinnedSyncArgv(LINK, "windows")[0]).toBe("powershell.exe");
  });

  test("a Windows update without --plan is refused whatever its other flags (Revision 5, item d)", () => {
    const gate = { minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: true, reportClock: false, launcher: "none" } as const;
    expect(() => remoteGatedOcxArgv({ ...gate, args: ["update", "--json", "--version", "2.100.0"] }, "windows")).toThrow(new LinkSshArgumentError("unsupported:windows-apply"));
    expect(() => remoteGatedOcxArgv({ ...gate, args: ["update", "--plan", "--yes", "--json"] }, "windows")).toThrow(new LinkSshArgumentError("unsupported:windows-apply"));
    expect(remoteUpdatePlanArgv("2.100.0", "windows")[0]).toBe("powershell.exe");
    expect(remoteGatedOcxArgv({ ...gate, args: ["update", "--json", "--version", "2.100.0"] }, "posix")[0]).toBe("sh");
  });

  test("the Windows sync script keeps its gate and also disables the handoff", () => {
    const script = inflated(remotePinnedSyncArgv(LINK, "windows"));
    expect(script).toContain("$b=@('2','93','0')");
    expect(script).not.toContain("ocx-fanout:child-ocx-ephemeral");
    expect(script).not.toContain("ocx-fanout:entry:");
    expect(script).toContain("$env:OCX_NO_DESKTOP_HANDOFF='1'");
  });

  test("Windows apply is refused in the builder", () => {
    expect(() => remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: TOKEN, notAfter: 1, viaLauncher: false }, "windows")).toThrow(new LinkSshArgumentError("unsupported:windows-apply"));
    expect(() => remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: TOKEN, notAfter: 1, viaLauncher: true }, "windows")).toThrow(new LinkSshArgumentError("unsupported:windows-apply"));
  });
});

describe("builders validate input", () => {
  test.each([
    ["bad link id", () => remotePinnedSyncArgv("lnk_XYZ", "posix")],
    ["bad restart", () => remotePinnedSyncArgv(LINK, "posix", { restart: "all" as never })],
    ["bad Home version", () => remoteUpdatePlanArgv("2.100", "posix")],
    ["long Home version", () => remoteUpdatePlanArgv("2.100.0-" + "a".repeat(130), "posix")],
    ["bad plan token", () => remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: "short", notAfter: 1, viaLauncher: false }, "posix")],
    ["bad deadline", () => remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: TOKEN, notAfter: 1.5, viaLauncher: false }, "posix")],
    ["zero deadline", () => remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: TOKEN, notAfter: 0, viaLauncher: false }, "posix")],
    ["non-boolean launcher route", () => remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: TOKEN, notAfter: 1, viaLauncher: "yes" as never }, "posix")],
    ["NUL argument", () => remoteGatedOcxArgv({ minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: false, reportClock: false, launcher: "none", args: ["a\0b"] })],
    ["unknown minimum", () => remoteGatedOcxArgv({ minVersion: "2.0.0" as never, lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: false, reportClock: false, launcher: "none", args: ["x"] })],
    ["unknown marker", () => remoteGatedOcxArgv({ minVersion: "2.97.0", lacksMarker: "x'; rm -rf /" as never, acceptEphemeral: false, reportEntry: false, reportClock: false, launcher: "none", args: ["x"] })],
    ["no arguments", () => remoteGatedOcxArgv({ minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: false, reportClock: false, launcher: "none", args: [] })],
    ["unknown launcher", () => remoteGatedOcxArgv({ minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: false, reportClock: false, launcher: "x; rm -rf /" as never, args: ["x"] })],
  ])("%s throws LinkSshArgumentError", (_name, build) => {
    expect(build).toThrow(LinkSshArgumentError);
  });

  test("an invalid launcher is reported after the version, marker and argument checks", () => {
    const bad = { minVersion: "2.97.0", lacksMarker: "child-ocx-lacks-orchestrated-update", acceptEphemeral: false, reportEntry: false, reportClock: false } as const;
    expect(() => remoteGatedOcxArgv({ ...bad, launcher: "x" as never, args: ["x"] })).toThrow(new LinkSshArgumentError("invalid gated ocx launcher"));
    expect(() => remoteGatedOcxArgv({ ...bad, launcher: "x" as never, args: [] })).toThrow(new LinkSshArgumentError("invalid gated ocx arguments"));
  });

  test("a plan token starting with - is not passed to --expect-plan", () => {
    const dashed = remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: "-" + TOKEN, notAfter: 5, viaLauncher: false }, "posix");
    expect(dashed.slice(4)).toEqual(["update", "--yes", "--json", "--version", "2.100.0", "--not-after", "5"]);
    const plain = remoteUpdateApplyArgv({ homeVersion: "2.100.0", planToken: TOKEN, notAfter: 5, viaLauncher: false }, "posix");
    expect(plain.slice(4)).toEqual(["update", "--yes", "--json", "--version", "2.100.0", "--expect-plan", TOKEN, "--not-after", "5"]);
  });
});

describe("framing", () => {
  const ran = (stderr: string, stdout = "ocx-fanout:stdout-begin\n{}\n", code = 0) => readGatedFraming({ code, stdout, stderr });
  test.each([
    [255, "", { kind: "transport", reason: "ssh-failed" }],
    [127, "", { kind: "transport", reason: "child-ocx-not-found" }],
    [126, "", { kind: "transport", reason: "child-ocx-not-contained" }],
    [125, "", { kind: "transport", reason: "child-platform-unsupported" }],
    [121, "ocx-fanout:child-ocx-lacks-orchestrated-update\n", { kind: "refused", reason: "child-ocx-lacks-orchestrated-update" }],
    [121, "ocx-fanout:child-ocx-lacks-expect-link\n", { kind: "refused", reason: "child-ocx-lacks-expect-link" }],
    [121, "ocx-fanout:child-ocx-version-unknown\n", { kind: "refused", reason: "child-ocx-version-unknown" }],
    [121, "ocx-fanout:child-ocx-ephemeral\n", { kind: "refused", reason: "child-ocx-ephemeral" }],
    [121, "ocx-fanout:selected:2.98.0\nocx-fanout:entry:pair\nocx-fanout:child-node-unavailable\n", { kind: "refused", reason: "child-node-unavailable" }],
    [121, "something else\n", { kind: "refused", reason: "child-gate-failed" }],
  ] as const)("exit %d with %j", (code, stderr, expected) => {
    expect(readGatedFraming({ code, stdout: "", stderr })).toEqual(expected);
  });

  test("selection, entry and clock are read once", () => {
    expect(ran("login noise\nocx-fanout:selected:2.97.0\nocx-fanout:entry:pair\nocx-fanout:child-now:1900000000000\n", "motd\nocx-fanout:stdout-begin\n{\"a\":1}\n"))
      .toEqual({ kind: "ran", code: 0, selectedVersion: "2.97.0", entry: "pair", childNowMs: 1_900_000_000_000, launcher: null, payload: "{\"a\":1}", lastStderrLine: "ocx-fanout:child-now:1900000000000" });
    expect(ran("ocx-fanout:selected:2.97.0\n")).toMatchObject({ kind: "ran", entry: null, childNowMs: null, launcher: null });
    for (const value of ["available", "unavailable", "exec"] as const) {
      expect(ran("ocx-fanout:selected:2.97.0\nocx-fanout:entry:pair\nocx-fanout:launcher:" + value + "\n")).toMatchObject({ kind: "ran", launcher: value });
    }
  });

  test.each([
    ["two selection markers", "ocx-fanout:selected:2.97.0\nocx-fanout:selected:2.97.0\n", "ocx-fanout:stdout-begin\n"],
    ["missing delimiter", "ocx-fanout:selected:2.97.0\n", "{}\n"],
    ["two delimiters", "ocx-fanout:selected:2.97.0\n", "ocx-fanout:stdout-begin\nocx-fanout:stdout-begin\n"],
    ["two entry lines", "ocx-fanout:selected:2.97.0\nocx-fanout:entry:pair\nocx-fanout:entry:binary\n", "ocx-fanout:stdout-begin\n"],
    ["two clock markers", "ocx-fanout:selected:2.97.0\nocx-fanout:child-now:1900000000000\nocx-fanout:child-now:1900000000001\n", "ocx-fanout:stdout-begin\n"],
    ["a 17-digit clock", "ocx-fanout:selected:2.97.0\nocx-fanout:child-now:19000000000000000\n", "ocx-fanout:stdout-begin\n"],
    ["a non-numeric clock", "ocx-fanout:selected:2.97.0\nocx-fanout:child-now:soon\n", "ocx-fanout:stdout-begin\n"],
    ["two launcher lines", "ocx-fanout:selected:2.97.0\nocx-fanout:launcher:available\nocx-fanout:launcher:exec\n", "ocx-fanout:stdout-begin\n"],
    ["an unknown launcher line", "ocx-fanout:selected:2.97.0\nocx-fanout:launcher:maybe\n", "ocx-fanout:stdout-begin\n"],
    ["an invalid selected version", "ocx-fanout:selected:2.97\n", "ocx-fanout:stdout-begin\n"],
  ])("%s is invalid", (_name, stderr, stdout) => {
    expect(readGatedFraming({ code: 0, stdout, stderr })).toEqual({ kind: "invalid" });
  });

  test("an exit after selection is a run, whatever its code", () => {
    for (const code of [126, 127, 255, 121, 3]) {
      expect(ran("ocx-fanout:selected:2.97.0\nocx-fanout:entry:binary\n", "ocx-fanout:stdout-begin\n", code)).toMatchObject({ kind: "ran", code });
      expect(classifyUpdateApply({ code, stdout: "ocx-fanout:stdout-begin\n", stderr: "ocx-fanout:selected:2.97.0\n" }))
        .toMatchObject({ state: "uncertain", reobserve: true });
    }
  });

  test("apply verdicts from framing", () => {
    expect(classifyUpdateApply({ code: 255, stdout: "", stderr: "" })).toEqual({ state: "uncertain", reason: "ssh-failed", suppressTarget: false, reobserve: true });
    expect(classifyUpdateApply({ code: 127, stdout: "", stderr: "" })).toEqual({ state: "failed", reason: "child-ocx-not-found", suppressTarget: false, reobserve: false });
    expect(classifyUpdateApply({ code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-lacks-orchestrated-update\n" })).toEqual({ state: "owner-action", reason: "legacy-ocx", suppressTarget: false, reobserve: false });
    expect(classifyUpdateApply({ code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-ephemeral\n" })).toEqual({ state: "unsupported", reason: "ephemeral", suppressTarget: false, reobserve: false });
    expect(classifyUpdateApply({ code: 121, stdout: "", stderr: "ocx-fanout:selected:2.98.0\nocx-fanout:entry:pair\nocx-fanout:child-node-unavailable\n" }))
      .toEqual({ state: "owner-action", reason: "launcher-node-missing", suppressTarget: false, reobserve: false });
    expect(classifyUpdateApply({ code: 0, stdout: "x", stderr: "ocx-fanout:selected:2.97.0\nocx-fanout:selected:2.97.0\n" })).toEqual({ state: "uncertain", reason: "child-output-invalid", suppressTarget: false, reobserve: true });
  });

  test("plan probe verdicts from framing", () => {
    const ctx = { homeVersion: "2.100.0", desktopUpdateRequest: false };
    expect(classifyUpdatePlanProbe({ code: 255, stdout: "", stderr: "" }, ctx)).toEqual({ kind: "offline", reason: "ssh-failed" });
    expect(classifyUpdatePlanProbe({ code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-version-unknown\n" }, ctx)).toEqual({ kind: "legacy", reason: "child-ocx-version-unknown" });
    expect(classifyUpdatePlanProbe({ code: 121, stdout: "", stderr: "ocx-fanout:child-ocx-ephemeral\n" }, ctx)).toEqual({ kind: "ephemeral" });
    expect(classifyUpdatePlanProbe({ code: 64, stdout: "ocx-fanout:stdout-begin\n{\"error\":\"usage\"}\n", stderr: "ocx-fanout:selected:2.97.0\n" }, ctx)).toEqual({ kind: "failed", reason: "contract-usage" });
  });
});

describe("Child clock marker", () => {
  posix("only the plan probe prints the Child's clock", () => {
    const before = Date.now();
    const plan = desktopRun("2.97.0", planArgv());
    const clocks = plan.stderr.split("\n").filter(line => line.startsWith("ocx-fanout:child-now:"));
    expect(clocks).toHaveLength(1);
    expect(plan.stderr.split("\n").indexOf(clocks[0]!)).toBe(2);
    const value = Number(clocks[0]!.slice("ocx-fanout:child-now:".length));
    expect(Math.abs(value - before)).toBeLessThan(2000);
    expect(desktopRun("2.97.0", applyArgv()).stderr).not.toContain("child-now");
    expect(desktopRun("2.93.0", remotePinnedSyncArgv(LINK, "posix")).stderr).not.toContain("child-now");
    const framing = readGatedFraming({ code: plan.code ?? -1, stdout: plan.stdout, stderr: plan.stderr });
    expect(framing).toMatchObject({ kind: "ran", childNowMs: value, entry: "binary" });
  });

  test("the Windows plan script reads the clock and the sync script does not", () => {
    expect(inflated(remoteUpdatePlanArgv("2.100.0", "windows"))).toContain("ToUnixTimeMilliseconds");
    expect(inflated(remotePinnedSyncArgv(LINK, "windows"))).not.toContain("ToUnixTimeMilliseconds");
  });

  test("the plan verdict carries the Child clock", () => {
    const plan = { schema: "ocx.update.plan/1", currentVersion: "2.97.0", targetVersion: "2.100.0", installer: "bun", runtimeOwner: "service",
      servingPath: "/opt/ocx", cliPath: "/opt/ocx", canApply: true, restartRequired: true, planToken: TOKEN, updateInFlight: false, mutationBoundMs: 900_000 };
    const verdict = classifyUpdatePlanProbe({ code: 0, stdout: "ocx-fanout:stdout-begin\n" + JSON.stringify(plan) + "\n",
      stderr: "ocx-fanout:selected:2.97.0\nocx-fanout:entry:binary\nocx-fanout:child-now:1900000000000\n" }, { homeVersion: "2.100.0", desktopUpdateRequest: false });
    expect(verdict).toMatchObject({ kind: "plan", selectedVersion: "2.97.0", childNowMs: 1_900_000_000_000, classification: { updateRoute: "orchestrated", installKind: "bun", planToken: TOKEN } });
  });
});

