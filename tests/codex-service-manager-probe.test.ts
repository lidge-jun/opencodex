/**
 * The service-manager probe, and the ownership it feeds.
 *
 * Three ways this could pass while broken, each named by an audit and each
 * answered here rather than by care:
 *   - inspect only the disk definition and miss a stale LOADED one
 *   - report `present` for a definition whose homes could not be parsed
 *   - mutation-test the fixture's argv instead of the argv production emits
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectServiceManagerInstallation,
  type ProbeRunner,
  type RawProbeRunner,
} from "../src/service-manager-probe";
import { inspectNativeCodexOwnership } from "../src/integrations/native/ownership-preflight";
import { setTrustedWindowsSystemDirectoryResolverForTests } from "../src/lib/windows-elevation";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let home = "";
const cleanup: string[] = [];
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;
let trustedSystem32 = "";

/** Records exactly what production asked for, so the allowlist is observed. */
function recorder(reply: (file: string, args: readonly string[]) => Partial<ReturnType<ProbeRunner>>) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: ProbeRunner = (file, args) => {
    calls.push({ file, args });
    return { status: 0, stdout: "", stderr: "", timedOut: false, spawnFailed: false, ...reply(file, args) };
  };
  const runRaw: RawProbeRunner = (file, args) => {
    calls.push({ file, args });
    const r = { status: 0, stdout: "", stderr: "", timedOut: false, spawnFailed: false, ...reply(file, args) };
    return {
      status: r.status,
      stdout: Buffer.from(r.stdout, "utf8"),
      stderr: Buffer.from(r.stderr, "utf8"),
      timedOut: r.timedOut,
      spawnFailed: r.spawnFailed,
    };
  };
  return { run, runRaw, calls };
}

// Linux CI fakes win32 but has no kernel32/System32, so the trusted schtasks
// resolver throws unless pointed at a fake system directory with schtasks.exe
// present. Mirror windows-elevation.test.ts: wire the resolver seam for every
// test so the Windows chain-walk suites run anywhere.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-probe-"));
  cleanup.push(home);
  trustedSystem32 = join(home, "System32");
  mkdirSync(trustedSystem32, { recursive: true });
  writeFileSync(join(trustedSystem32, "schtasks.exe"), "");
  setTrustedWindowsSystemDirectoryResolverForTests(() => trustedSystem32);
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
});
afterEach(() => {
  setTrustedWindowsSystemDirectoryResolverForTests(null);
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  while (cleanup.length) removeTreeWithRetry(cleanup.pop()!);
});

function writePlist(codexHome: string | null, opencodexHome: string | null): string {
  const dir = join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "com.opencodex.proxy.plist");
  writeFileSync(path, [
    "<plist><dict><key>EnvironmentVariables</key><dict>",
    codexHome ? `<key>CODEX_HOME</key><string>${codexHome}</string>` : "",
    opencodexHome ? `<key>OPENCODEX_HOME</key><string>${opencodexHome}</string>` : "",
    "</dict></dict></plist>",
  ].join("\n"));
  return path;
}

function writeUnit(codexHome: string, opencodexHome: string): string {
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencodex-proxy.service");
  writeFileSync(path, [
    "[Service]",
    `Environment="CODEX_HOME=${codexHome}"`,
    `Environment="OPENCODEX_HOME=${opencodexHome}"`,
  ].join("\n"));
  return path;
}

describe("the probe only ever asks", () => {
  /**
   * The user's proxy is live under a service manager while this runs. A probe
   * that could start, stop or reload anything is not a probe — and asserting
   * that from the source text is not enough, because this unit has already
   * shipped a fix that was only a comment.
   */
  /**
   * Two calls, not one: `gui/<uid>` and `user/<uid>` are independent launchd
   * domains carrying separate service sets. Measured on macOS 27.0, the shipped
   * agent answers 0 under `gui` and 113 under `user` — so asking only one leaves
   * the other free to hold a job this probe would then report as absent.
   *
   * What the test is really pinning is that every call only ASKS.
   */
  test("macOS asks launchctl only with print, in both domains", () => {
    const { run, calls } = recorder(() => ({ status: 113 }));
    inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });

    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.args[1])).toEqual([
      "gui/501/com.opencodex.proxy",
      "user/501/com.opencodex.proxy",
    ]);
    for (const call of calls) {
      expect(call.file).toBe("/bin/launchctl");
      expect(call.args[0]).toBe("print");
      for (const verb of ["load", "unload", "bootstrap", "bootout", "kickstart", "start", "stop", "enable", "disable"]) {
        expect(call.args).not.toContain(verb);
      }
    }
  });

  test("a live job in the user domain is found even though gui answered first", () => {
    const { run } = recorder((_file, args) => (
      String(args[1]).startsWith("user/") ? { status: 0 } : { status: 113 }
    ));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    // The plist is absent in this fixture, so a loaded job with no file is the
    // interrupted-uninstall case rather than a clean absence.
    expect(result.kind).toBe("unknown");
  });

  test("Linux asks systemctl exactly once, with show", () => {
    const { run, calls } = recorder(() => ({
      stdout: "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nNeedDaemonReload=no\n",
    }));
    inspectServiceManagerInstallation({ run, platform: "linux", home });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("systemctl");
    expect(calls[0].args).toContain("show");
    expect(calls[0].args).toContain("--user");
    for (const verb of ["start", "stop", "restart", "reload", "daemon-reload", "enable", "disable", "kill"]) {
      expect(calls[0].args).not.toContain(verb);
    }
  });

  test("and it asks systemd for the stale-definition signal, not just the load state", () => {
    const { run, calls } = recorder(() => ({
      stdout: "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nNeedDaemonReload=no\n",
    }));
    inspectServiceManagerInstallation({ run, platform: "linux", home });
    // LoadState alone cannot say whether the LOADED bytes match the file.
    expect(calls[0].args).toContain("NeedDaemonReload");
  });
});

describe("absence has to be proven twice", () => {
  test("no registration and no definition is absent", () => {
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }))
      .toEqual({ kind: "absent" });
  });

  /**
   * The case a registration-only probe gets wrong: a logged-out macOS user has
   * the plist on disk with no GUI domain, so nothing is loaded while a foreign
   * definition sits right there.
   */
  test("no registration but a definition on disk is NOT absent", () => {
    const path = writePlist("/somewhere/.codex", "/somewhere/.opencodex");
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].registration).toBe("absent");
    expect(result.claims[0].definitionPath).toBe(path);
    expect(result.claims[0].homes).toEqual({ codexHome: "/somewhere/.codex", opencodexHome: "/somewhere/.opencodex" });
  });

  test("a registration with no definition file is unknown, not present", () => {
    const { run } = recorder(() => ({ status: 0, stdout: "state = running" }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("unknown");
  });
});

describe("could not ask is not an answer", () => {
  /**
   * Measured against real nonexistent targets: 113 is "no such service", 112 is
   * "no such domain". Only the first is an answer.
   */
  /**
   * 112 with nothing staged on disk is ABSENT, and this test asserted the
   * opposite until a review round showed what that costs: a fresh headless Mac
   * has no GUI domain and no installation either, so treating 112 as "could not
   * ask" refused every Codex write on it.
   *
   * The measurement that settles it (macOS 27.0): 112 is an answer about the
   * DOMAIN and is label-independent — `launchctl print gui/999999` with no
   * service name at all returns it — so an unreachable domain cannot be hiding a
   * job of ours. 113 stays service-scoped within a domain that answered.
   */
  test("exit 112 with no plist is absent — an unreachable domain holds nothing", () => {
    const { run } = recorder(() => ({ status: 112, stderr: "Could not find domain for user" }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("absent");
  });

  test("exit 112 WITH a plist staged is unknown", () => {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.opencodex.proxy.plist"), "<plist/>");
    const { run } = recorder(() => ({ status: 112, stderr: "Could not find domain for user" }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    // Something is staged to load and we could not see whether it did.
    expect(result.kind).not.toBe("absent");
  });

  /**
   * A dangling symlink at the plist path must not read as a clean machine.
   *
   * Worth stating plainly: this test does NOT distinguish `lstat` from
   * `existsSync`, and a mutation check proved it. Either way the probe ends at
   * `unknown` — with `lstat` because the entry exists and cannot be read, with
   * `existsSync` because the later `readFileSync` throws. The refusal is what
   * the caller depends on and the refusal is what is pinned here; which of the
   * two produced it is not observable from outside, so claiming to test it
   * would be claiming more than this proves.
   */
  // Windows without Developer Mode / elevated privileges cannot create
  // symlinks (EPERM). Detect once so this test reports a visible skip there
  // instead of a spurious failure. Mirrors the probe in claude-agents-inject.
  const canSymlink = (() => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-symlink-probe-"));
    try {
      symlinkSync(join(dir, "probe-target"), join(dir, "probe-link"));
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
      throw e;
    } finally {
      removeTreeWithRetry(dir);
    }
  })();

  test.skipIf(!canSymlink)("a dangling plist symlink does not read as a clean machine", () => {
    const agents = join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    symlinkSync(join(home, "nothing-here.plist"), join(agents, "com.opencodex.proxy.plist"));
    expect(existsSync(join(agents, "com.opencodex.proxy.plist"))).toBeFalse();

    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("unknown");
  });

  test("a launchctl timeout is unknown", () => {
    const { run } = recorder(() => ({ status: null, timedOut: true }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }).kind).toBe("unknown");
  });

  /**
   * systemd does NOT signal absence through the exit code — a missing unit
   * prints not-found and exits ZERO. A non-zero status means the question never
   * reached the bus, which is the opposite conclusion.
   */
  test("a non-zero systemctl status is unknown even though a missing unit exits zero", () => {
    // Amended for #2114, not deleted: the rule still holds for every non-zero exit whose
    // stderr does not prove the bus itself was unreachable. The bus-down family is handled
    // by reading the unit file instead, and is asserted separately below.
    const { run } = recorder(() => ({ status: 1, stderr: "Job for opencodex-proxy.service failed" }));
    expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).toBe("unknown");
  });

  test("NeedDaemonReload=yes is unknown — systemd is running something else", () => {
    writeUnit("/x/.codex", "/x/.opencodex");
    const { run } = recorder(() => ({
      stdout: "LoadState=loaded\nActiveState=active\nFragmentPath=/x/unit\nNeedDaemonReload=yes\n",
    }));
    const result = inspectServiceManagerInstallation({ run, platform: "linux", home });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("daemon-reload");
  });

  test("Windows refuses when the chain walk finds no definition", () => {
    // Nothing staged on disk, and the query is not asked (no run injected) —
    // the default spawn would fail on non-Windows, so this uses the injected
    // recorder to prove absence is only claimed when schtasks answers absent.
    const { runRaw, calls } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));
    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("absent");
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("/query");
  });
});

describe("a definition that cannot supply homes is not present", () => {
  test("an unreadable plist is unknown", () => {
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    // A directory where the plist should be: exists, cannot be read as a file.
    mkdirSync(join(dir, "com.opencodex.proxy.plist"));
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }).kind).toBe("unknown");
  });

  /**
   * An omitted key is not a disagreement: an install run without CODEX_HOME set
   * writes no such key at all, and `null` has to survive to the caller so the
   * comparison can skip it rather than compare against "".
   */
  test("an omitted home is null, not an empty string", () => {
    writePlist(null, "/somewhere/.opencodex");
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].homes.codexHome).toBeNull();
    expect(result.claims[0].homes.opencodexHome).toBe("/somewhere/.opencodex");
  });
});

describe("the Windows chain walk", () => {
  function writeWindowsTask(launcherPath: string): string {
    const dir = join(home, ".opencodex");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "opencodex-service-task.xml");
    writeFileSync(path, windowsTaskXmlFor(launcherPath));
    return path;
  }

  function windowsTaskXmlFor(launcherPath: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-16"?>',
      "<Task>",
      "  <Actions Context=\"Author\">",
      "    <Exec>",
      `      <Command>C:\\WINDOWS\\System32\\wscript.exe</Command>`,
      `      <Arguments>/b /nologo &quot;${launcherPath.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}&quot;</Arguments>`,
      "    </Exec>",
      "  </Actions>",
      "</Task>",
    ].join("\n");
  }

  function writeWindowsLauncher(wrapperPath: string): string {
    const path = join(home, ".opencodex", "opencodex-service-launcher.vbs");
    mkdirSync(join(home, ".opencodex"), { recursive: true });
    writeFileSync(path, [
      "Set shell = CreateObject(\"WScript.Shell\")",
      `shell.Run """${wrapperPath}""", 0, True`,
    ].join("\r\n"));
    return path;
  }

  function writeWindowsWrapper(codexHome?: string, opencodexHome?: string): string {
    const path = join(home, ".opencodex", "opencodex-service.cmd");
    mkdirSync(join(home, ".opencodex"), { recursive: true });
    const lines = ["@echo off", "setlocal"];
    if (codexHome) lines.push(`set "CODEX_HOME=${codexHome}"`);
    if (opencodexHome) lines.push(`set "OPENCODEX_HOME=${opencodexHome}"`);
    // The tail that `buildWindowsServiceScript` emits; the probe keys wrapper
    // validity on it so an empty/unrelated wrapper cannot read as an install
    // that deliberately omitted both homes.
    lines.push(
      'set "OCX_BUN=C:\\bun\\bun.exe"',
      'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
      ":loop",
      '>>"%OCX_SERVICE_LOG%" echo start',
      '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
    );
    writeFileSync(path, lines.join("\r\n"));
    return path;
  }

  test("the full chain is walked and the homes are extracted", () => {
    const wrapper = writeWindowsWrapper("C:\\Users\\ws\\.codex", "C:\\Users\\ws\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    const taskXml = writeWindowsTask(launcher);
    // The registered task points at the SAME launcher as the staged definition,
    // so the two chains agree and the staged homes are reported.
    const { runRaw, calls } = recorder(() => ({ status: 0, stdout: windowsTaskXmlFor(launcher) }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].backend).toBe("scheduler");
    expect(result.claims[0].definitionPath).toBe(taskXml);
    expect(result.claims[0].registration).toBe("present");
    expect(result.claims[0].homes).toEqual({
      codexHome: "C:\\Users\\ws\\.codex",
      opencodexHome: "C:\\Users\\ws\\.opencodex",
    });
    // One bounded query via the trusted System32 schtasks, nothing that mutates.
    expect(calls).toHaveLength(1);
    const schtasksPath = calls[0].file;
    expect(schtasksPath.toLowerCase().replace(/\\/g, "/")).toContain("system32/schtasks.exe");
    expect(calls[0].args).toEqual(["/query", "/tn", "opencodex-proxy", "/xml"]);
  });

  test("a registered task whose chain disagrees with the staged definition is unknown", () => {
    const wrapper = writeWindowsWrapper("C:\\Users\\ws\\.codex", "C:\\Users\\ws\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    // The registered task (from /query /xml) points at a COMPLETE foreign chain
    // whose homes differ from the staged on-disk definition — interrupted reinstall.
    const foreignWrapper = join(home, ".opencodex", "foreign-wrapper.cmd");
    writeFileSync(foreignWrapper, [
      "@echo off",
      "setlocal",
      'set "CODEX_HOME=C:\\foreign\\.codex"',
      'set "OCX_BUN=C:\\bun\\bun.exe"',
      'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
      ":loop",
      '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
    ].join("\r\n"));
    const foreignLauncher = join(home, ".opencodex", "foreign-launcher.vbs");
    writeFileSync(foreignLauncher, `shell.Run """${foreignWrapper}""", 0, True\r\n`);
    const registeredXml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      `<Arguments>/b /nologo &quot;${foreignLauncher}&quot;</Arguments>`,
    ].join("\n");
    const { runRaw } = recorder(() => ({ status: 0, stdout: registeredXml }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("different homes");
  });

  test("batch env-token homes are decoded before they are compared", () => {
    // The real builder emits `%USERPROFILE%\.codex` and doubles `%` as `%%`.
    const dir = join(home, ".opencodex");
    mkdirSync(dir, { recursive: true });
    const wrapper = join(dir, "opencodex-service.cmd");
    writeFileSync(wrapper, [
      "@echo off",
      "setlocal",
      'set "CODEX_HOME=%USERPROFILE%\\.codex"',
      'set "OPENCODEX_HOME=%%PROFILE_VAR%%\\custom"',
      'set "OCX_BUN=C:\\bun\\bun.exe"',
      'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
      ":loop",
      '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
    ].join("\r\n"));
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    // %USERPROFILE% expands to the test's real home; %% stays a literal %.
    const profile = process.env.USERPROFILE ?? "";
    expect(result.claims[0].homes.codexHome).toBe(`${profile}\\.codex`);
    expect(result.claims[0].homes.opencodexHome).toBe(`%PROFILE_VAR%\\custom`);
  });

  test("escaped and lowercase env tokens decode correctly with a controlled env", () => {
    const dir = join(home, ".opencodex");
    mkdirSync(dir, { recursive: true });
    const wrapper = join(dir, "opencodex-service.cmd");
    writeFileSync(wrapper, [
      "@echo off",
      "setlocal",
      'set "CODEX_HOME=%%USERPROFILE%%\\literal"',
      'set "OPENCODEX_HOME=%userprofile%\\lower"',
      'set "OCX_BUN=C:\\bun\\bun.exe"',
      'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
      ":loop",
      '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
    ].join("\r\n"));
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    // %%USERPROFILE%% is an escaped literal (stays %USERPROFILE%), while the
    // lowercase %userprofile% is a real token and expands (case-insensitive).
    expect(result.claims[0].homes.codexHome).toBe(`%USERPROFILE%\\literal`);
    expect(result.claims[0].homes.opencodexHome).toBe(`${process.env.USERPROFILE ?? ""}\\lower`);
  });

  test("a wrapper with :loop and rem bun is not a generated wrapper", () => {
    const dir = join(home, ".opencodex");
    mkdirSync(dir, { recursive: true });
    const wrapper = join(dir, "opencodex-service.cmd");
    writeFileSync(wrapper, [
      "@echo off",
      "setlocal",
      'set "CODEX_HOME=C:\\x\\.codex"',
      ":loop",
      "rem bun start --port 10100",
    ].join("\r\n"));
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
  });

  test("scheduler assets are located under the effective OPENCODEX_HOME", () => {
    // A decoy chain in the DEFAULT <home>/.opencodex location must NOT win over
    // the customized OPENCODEX_HOME passed as configDir.
    const decoyWrapper = writeWindowsWrapper("C:\\decoy\\.codex", "C:\\decoy\\.opencodex");
    const decoyLauncher = writeWindowsLauncher(decoyWrapper);
    writeWindowsTask(decoyLauncher);

    // The real custom config dir (customized OPENCODEX_HOME) holds the actual chain.
    const custom = join(home, "custom-home");
    const wrapper = join(custom, "opencodex-service.cmd");
    mkdirSync(custom, { recursive: true });
    writeFileSync(wrapper, [
      "@echo off",
      "setlocal",
      'set "CODEX_HOME=C:\\custom\\.codex"',
      'set "OCX_BUN=C:\\bun\\bun.exe"',
      'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
      ":loop",
      '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
    ].join("\r\n"));
    const launcher = join(custom, "opencodex-service-launcher.vbs");
    writeFileSync(launcher, `shell.Run """${wrapper}""", 0, True\r\n`);
    writeFileSync(join(custom, "opencodex-service-task.xml"), [
      '<?xml version="1.0" encoding="UTF-16"?>',
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
    ].join("\n"));
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent", configDir: custom });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    // The custom chain's homes win over the default-mirror decoy.
    expect(result.claims[0].homes.codexHome).toBe("C:\\custom\\.codex");
  });

  test("a malformed wrapper is unknown, not a deliberate omission", () => {
    // A truncated wrapper with set lines but no generated tail is NOT a
    // legitimate install that omitted the homes — it is residue.
    const dir = join(home, ".opencodex");
    mkdirSync(dir, { recursive: true });
    const wrapper = join(dir, "opencodex-service.cmd");
    writeFileSync(wrapper, "@echo off\r\nsetlocal\r\nset \"CODEX_HOME=C:\\x\\.codex\"");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason)
      .toContain("the launcher wrapper does not look like a generated opencodex service wrapper");
  });

  test("an empty wrapper is unknown, not absence", () => {
    const dir = join(home, ".opencodex");
    mkdirSync(dir, { recursive: true });
    const wrapper = join(dir, "opencodex-service.cmd");
    writeFileSync(wrapper, "");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
  });

  test("a staged task that was never registered is present but registration=absent", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex", "C:\\a\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].registration).toBe("absent");
  });

  test("an omitted home in the wrapper stays null, not empty", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].homes.codexHome).toBe("C:\\a\\.codex");
    expect(result.claims[0].homes.opencodexHome).toBeNull();
  });

  test("a broken link in the chain is unknown, not absence", () => {
    // Task XML points at a launcher that does not exist.
    const missing = join(home, ".opencodex", "no-such.vbs");
    writeWindowsTask(missing);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("launcher");
  });

  test("a UTF-16LE task XML on disk is decoded before the chain is walked", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex", "C:\\a\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    const xml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      "<Task>",
      "  <Actions Context=\"Author\">",
      "    <Exec>",
      `      <Arguments>/b /nologo &quot;${launcher.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}&quot;</Arguments>`,
      "    </Exec>",
      "  </Actions>",
      "</Task>",
    ].join("\n");
    writeFileSync(join(home, ".opencodex", "opencodex-service-task.xml"), Buffer.from(`\uFEFF${xml}`, "utf16le"));
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].homes).toEqual({ codexHome: "C:\\a\\.codex", opencodexHome: "C:\\a\\.opencodex" });
  });

  test("a UTF-16LE VBS launcher is decoded before the chain is walked", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex", "C:\\a\\.opencodex");
    // Overwrite the launcher with a UTF-16LE encoding, like the real install.
    const launcher = join(home, ".opencodex", "opencodex-service-launcher.vbs");
    writeFileSync(launcher, Buffer.from(
      `\uFEFF' launcher\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.Run """${wrapper}""", 0, True\r\n`,
      "utf16le",
    ));
    const xml = join(home, ".opencodex", "opencodex-service-task.xml");
    writeFileSync(xml, [
      '<?xml version="1.0" encoding="UTF-16"?>',
      `<Arguments>/b /nologo &quot;${launcher.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}&quot;</Arguments>`,
    ].join("\n"));
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].homes).toEqual({ codexHome: "C:\\a\\.codex", opencodexHome: "C:\\a\\.opencodex" });
  });

  test("a task registered but with no XML on disk is unknown", () => {
    const { runRaw } = recorder(() => ({ status: 0, stdout: "<Task/>" }));
    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("missing");
  });

  test("an unaskable schtasks is unknown even with a full chain", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex", "C:\\a\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: null, spawnFailed: true, stderr: "spawn ENOENT" }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
  });

  /*
   * schtasks exits 1 for BOTH "task not found" and "access denied"; only the
   * stderr message distinguishes them. A nonzero exit whose message does NOT
   * state the task is missing cannot be treated as absence — a locked-down Task
   * Scheduler would otherwise read as a clean machine and an unattended write
   * would proceed into a home another process owns.
   */
  test("an access-denied schtasks response is unknown, not absent", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex", "C:\\a\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: Access is denied. (0x80070005)" }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("could not be asked");
  });

  test("a null-status schtasks response with no stderr is unknown, not absent", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex", "C:\\a\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: null, stderr: "" }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
  });

  test("a timed-out schtasks response is unknown, not absent", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex", "C:\\a\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    const { runRaw } = recorder(() => ({ status: null, timedOut: true }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
  });

  test("a registered task whose launcher is missing is unknown", () => {
    const wrapper = writeWindowsWrapper("C:\\Users\\ws\\.codex", "C:\\Users\\ws\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    // The registered task points at a launcher that does not exist — the
    // registered definition cannot be trusted, so the probe fails closed.
    const missingLauncher = join(home, ".opencodex", "no-such.vbs");
    const { runRaw } = recorder(() => ({ status: 0, stdout: windowsTaskXmlFor(missingLauncher) }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "nonexistent" });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("launcher");
  });

  function writeWinswXml(dir: string, codexHome: string, opencodexHome: string): void {
    // The probe resolves the winsw dir under the effective config dir
    // (default <home>/.opencodex/winsw), matching winswDir() in src/lib/winsw.ts.
    const winswDir = join(dir, ".opencodex", "winsw");
    mkdirSync(winswDir, { recursive: true });
    // The exe must be present for the SCM claim to be verifiable (fail-closed).
    writeFileSync(join(winswDir, "opencodex-proxy-native.exe"), "placeholder");
    writeFileSync(join(winswDir, "opencodex-proxy-native.xml"), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<service>",
      "  <id>opencodex-proxy-native</id>",
      `  <env name="CODEX_HOME" value="${codexHome}"/>`,
      `  <env name="OPENCODEX_HOME" value="${opencodexHome}"/>`,
      '  <arguments>"C:\\cli\\index.ts" start --port 10100</arguments>',
      "</service>",
    ].join("\n"));
  }

  test("WinSW and Task Scheduler both present is a conflict", () => {
    const wrapper = writeWindowsWrapper("C:\\a\\.codex", "C:\\a\\.opencodex");
    const launcher = writeWindowsLauncher(wrapper);
    writeWindowsTask(launcher);
    writeWinswXml(home, "C:\\winsw\\.codex", "C:\\winsw\\.opencodex");
    const { runRaw } = recorder(() => ({ status: 0, stdout: windowsTaskXmlFor(launcher) }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "started" });
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    // The staged scheduler claim is real (not fabricated null homes) and
    // registered.
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0].backend).toBe("winsw");
    expect(result.claims[1].backend).toBe("scheduler");
    expect(result.claims[1].registration).toBe("present");
    expect(result.claims[1].homes).toEqual({ codexHome: "C:\\a\\.codex", opencodexHome: "C:\\a\\.opencodex" });
  });

  test("a broken scheduler chain alongside WinSW is unknown, not a fabricated conflict", () => {
    // WinSW is installed and a scheduler task is registered, but the staged
    // scheduler chain is broken (launcher missing). The probe must not
    // fabricate a null-homes scheduler claim — it fails closed.
    writeWindowsTask(join(home, ".opencodex", "no-such.vbs"));
    writeWinswXml(home, "C:\\winsw\\.codex", "C:\\winsw\\.opencodex");
    const { runRaw } = recorder(() => ({ status: 0, stdout: windowsTaskXmlFor(join(home, ".opencodex", "no-such.vbs")) }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "started" });
    expect(result.kind).toBe("unknown");
  });

  test("WinSW homes are parsed from the XML env entries", () => {
    writeWinswXml(home, "C:\\winsw\\.codex", "C:\\winsw\\.opencodex");
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "stopped" });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].backend).toBe("winsw");
    expect(result.claims[0].homes).toEqual({ codexHome: "C:\\winsw\\.codex", opencodexHome: "C:\\winsw\\.opencodex" });
  });

  test("WinSW with unverifiable SCM state is unknown", () => {
    writeWinswXml(home, "C:\\winsw\\.codex", "C:\\winsw\\.opencodex");
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "unknown" });
    expect(result.kind).toBe("unknown");
  });

  test("WinSW XML present but exe missing is unknown (fail closed)", () => {
    // Only the XML exists (no exe): the SCM claim cannot be verified, so the
    // probe must refuse rather than report an owned WinSW backend.
    const winswDir = join(home, ".opencodex", "winsw");
    mkdirSync(winswDir, { recursive: true });
    writeFileSync(join(winswDir, "opencodex-proxy-native.xml"), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<service>",
      "  <id>opencodex-proxy-native</id>",
      '  <env name="CODEX_HOME" value="C:\\winsw\\.codex"/>',
      '  <arguments>"C:\\cli\\index.ts" start --port 10100</arguments>',
      "</service>",
    ].join("\n"));
    const { runRaw } = recorder(() => ({ status: 1, stderr: "ERROR: The system cannot find the file specified." }));

    const result = inspectServiceManagerInstallation({ platform: "win32", home, runRaw, winswStatus: () => "stopped" });
    expect(result.kind).toBe("unknown");
  });
});

describe("ownership refuses what it cannot prove", () => {
  /*
   * The default state paths include the DEFAULT home mirror, resolved from
   * homedir(), which no test sandbox moves. Left alone, these fixtures would
   * read the developer's real installation and call their own machine foreign.
   */
  function own(extra: { run: ProbeRunner }) {
    const codexHome = join(home, ".codex");
    const opencodexHome = join(home, ".opencodex");
    return {
      ...extra,
      platform: "darwin" as const,
      uid: 501,
      home,
      statePaths: [join(opencodexHome, "service-state.json")],
      currentHomes: { codexHome, opencodexHome },
    };
  }

  function useHomes(): { codexHome: string; opencodexHome: string } {
    const codexHome = join(home, ".codex");
    const opencodexHome = join(home, ".opencodex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(opencodexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    process.env.OPENCODEX_HOME = opencodexHome;
    return { codexHome, opencodexHome };
  }

  // The darwin ownership tests drive a launchd claim; a launchd install writes
  // a v1 state file (no `backend` field — that is Windows-only). v2 without a
  // backend would be malformed, so this writes v1.
  function writeState(dir: string, codexHome: string, opencodexHome: string): void {
    writeFileSync(join(dir, "service-state.json"), JSON.stringify({
      version: 1, codexHome, opencodexHome,
    }));
  }

  test("a fresh home with no state and no service is owned", () => {
    useHomes();
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("owned");
  });

  test("state naming another home is foreign", () => {
    const { opencodexHome } = useHomes();
    writeState(opencodexHome, "/elsewhere/.codex", "/elsewhere/.opencodex");
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("foreign");
  });

  /*
   * THE interrupted reinstall. Installation writes the definition BEFORE the
   * state file, so a valid state for this home can sit beside a plist naming
   * another. Picking a winner unattended means guessing which half of a
   * half-finished operation to believe.
   */
  test("state says here, definition says elsewhere — unknown, not owned", () => {
    const { codexHome, opencodexHome } = useHomes();
    writeState(opencodexHome, codexHome, opencodexHome);
    writePlist("/elsewhere/.codex", "/elsewhere/.opencodex");
    const { run } = recorder(() => ({ status: 113 }));

    const result = inspectNativeCodexOwnership(own({ run }));
    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("different homes");
  });

  test("state and definition agreeing is owned", () => {
    const { codexHome, opencodexHome } = useHomes();
    writeState(opencodexHome, codexHome, opencodexHome);
    writePlist(codexHome, opencodexHome);
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("owned");
  });

  test("an installed definition that no state file accounts for is unknown", () => {
    const { codexHome, opencodexHome } = useHomes();
    writePlist(codexHome, opencodexHome);
    const { run } = recorder(() => ({ status: 0, stdout: "state = running" }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("unknown");
  });

  /*
   * The fail-open helper this replaces returns {ok:true} here, which is right
   * for a teardown route a human just invoked and wrong as authority for an
   * unattended write.
   */
  test("a malformed state file is unknown, where the teardown helper says fine", () => {
    const { opencodexHome } = useHomes();
    writeFileSync(join(opencodexHome, "service-state.json"), "{ not json");
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectNativeCodexOwnership(own({ run }));
    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("malformed");
  });

  /**
   * The property is "silence is not absence", and it needs a case that is
   * genuinely silent. Exit 112 no longer qualifies: it is an answer about the
   * domain, and with nothing staged on disk it proves absence — that is what
   * keeps a fresh headless Mac usable. A launchctl that will not run at all is
   * the real unaskable case, and it still refuses.
   */
  test("an unaskable service manager is unknown even with clean state", () => {
    const { codexHome, opencodexHome } = useHomes();
    writeState(opencodexHome, codexHome, opencodexHome);
    const { run } = recorder(() => ({ status: null, spawnFailed: true, stderr: "spawn EACCES" }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("unknown");
  });

  /**
   * The counterpart, and the one a refuse-everything design gets wrong: no state
   * file, no plist, and a domain that does not exist is a FRESH MACHINE. It has
   * to be usable.
   */
  test("a fresh headless machine is owned, not refused", () => {
    useHomes();
    const { run } = recorder(() => ({ status: 112, stderr: "Could not find domain for user" }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("owned");
  });

  /*
   * The interrupted-backend-switch case: a v2 state file records backend
   * "native" (WinSW) but the probe finds a scheduler task. The homes agree, but
   * the manager backend does not, so ownership cannot be proven.
   */
  test("a state backend that disagrees with the installed manager is unknown", () => {
    const { codexHome, opencodexHome } = useHomes();
    mkdirSync(opencodexHome, { recursive: true });
    writeFileSync(join(opencodexHome, "service-state.json"), JSON.stringify({
      version: 2, codexHome, opencodexHome, backend: "native",
    }));
    // A scheduler claim whose homes agree with the state.
    const wrapper = join(opencodexHome, "opencodex-service.cmd");
    writeFileSync(wrapper, [
      "@echo off",
      "setlocal",
      `set "CODEX_HOME=${codexHome}"`,
      `set "OPENCODEX_HOME=${opencodexHome}"`,
      'set "OCX_BUN=C:\\bun\\bun.exe"',
      'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
      ":loop",
      '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
    ].join("\r\n"));
    const launcher = join(opencodexHome, "opencodex-service-launcher.vbs");
    writeFileSync(launcher, `shell.Run """${wrapper}""", 0, True\r\n`);
    writeFileSync(join(opencodexHome, "opencodex-service-task.xml"), [
      '<?xml version="1.0" encoding="UTF-16"?>',
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
    ].join("\n"));

    const result = inspectNativeCodexOwnership({
      platform: "win32",
      home,
      runRaw: () => ({ status: 1, stderr: Buffer.from("ERROR: The system cannot find the file specified."), stdout: Buffer.alloc(0), timedOut: false, spawnFailed: false }),
      winswStatus: () => "nonexistent",
      statePaths: [join(opencodexHome, "service-state.json")],
      currentHomes: { codexHome, opencodexHome },
    });
    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("backend");
  });

  test("a state backend that agrees with the installed manager is owned", () => {
    const { codexHome, opencodexHome } = useHomes();
    mkdirSync(opencodexHome, { recursive: true });
    writeFileSync(join(opencodexHome, "service-state.json"), JSON.stringify({
      version: 2, codexHome, opencodexHome, backend: "scheduler",
    }));
    const wrapper = join(opencodexHome, "opencodex-service.cmd");
    writeFileSync(wrapper, [
      "@echo off",
      "setlocal",
      `set "CODEX_HOME=${codexHome}"`,
      `set "OPENCODEX_HOME=${opencodexHome}"`,
      'set "OCX_BUN=C:\\bun\\bun.exe"',
      'set "OCX_CLI=C:\\opencodex\\src\\cli\\index.ts"',
      ":loop",
      '"%OCX_BUN%" "%OCX_CLI%" start --port 10100',
    ].join("\r\n"));
    const launcher = join(opencodexHome, "opencodex-service-launcher.vbs");
    writeFileSync(launcher, `shell.Run """${wrapper}""", 0, True\r\n`);
    writeFileSync(join(opencodexHome, "opencodex-service-task.xml"), [
      '<?xml version="1.0" encoding="UTF-16"?>',
      `<Arguments>/b /nologo &quot;${launcher}&quot;</Arguments>`,
    ].join("\n"));

    const result = inspectNativeCodexOwnership({
      platform: "win32",
      home,
      runRaw: () => ({ status: 1, stderr: Buffer.from("ERROR: The system cannot find the file specified."), stdout: Buffer.alloc(0), timedOut: false, spawnFailed: false }),
      winswStatus: () => "nonexistent",
      statePaths: [join(opencodexHome, "service-state.json")],
      currentHomes: { codexHome, opencodexHome },
    });
    expect(result.ownership).toBe("owned");
  });
});

/*
 * #2114: systemctl exists and runs, but the user session bus does not answer.
 *
 * The old branch called every non-zero exit `unknown`, which fences native-main for the
 * whole process — the reporter's 503. But "the question never reached the bus" is evidence
 * about the BUS, not evidence that a foreign service owns this home.
 *
 * Widening the exit code alone would fail open, because with the bus down systemctl cannot
 * see a foreign unit either. So the classification asks the DISK, which needs no bus.
 */
describe("systemd probe: the bus is unreachable (#2114)", () => {
  const BUS_DOWN = "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined";

  test("no unit file on disk means nothing can own this home — absent, not fenced", () => {
    const { run } = recorder(() => ({ status: 1, stderr: BUS_DOWN }));

    expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).toBe("absent");
  });

  test("a unit naming THIS home is still ours, read off disk", () => {
    const definitionPath = writeUnit(join(home, ".codex"), join(home, ".opencodex"));
    const { run } = recorder(() => ({ status: 1, stderr: BUS_DOWN }));

    const result = inspectServiceManagerInstallation({ run, platform: "linux", home });

    expect(result.kind).toBe("present");
    // Registration is genuinely unknowable with the bus down; the claim must not invent it.
    expect(result.kind === "present" && result.claims[0]?.definitionPath).toBe(definitionPath);
    expect(result.kind === "present" && result.claims[0]?.homes.codexHome).toBe(join(home, ".codex"));
  });

  // The guard that keeps this fail-closed. A foreign unit is exactly the case the old
  // `unknown` existed to protect, and it must survive the widening.
  test("a unit naming a FOREIGN home still blocks", () => {
    writeUnit("/other/.codex", "/other/.opencodex");
    const { run } = recorder(() => ({ status: 1, stderr: BUS_DOWN }));

    const result = inspectServiceManagerInstallation({ run, platform: "linux", home });

    expect(result.kind).toBe("present");
    expect(result.kind === "present" && result.claims[0]?.homes.codexHome).toBe("/other/.codex");
  });

  test("a non-bus failure is untouched — it stays unknown", () => {
    const { run } = recorder(() => ({ status: 1, stderr: "Job for opencodex-proxy.service failed" }));

    expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).toBe("unknown");
  });
});

/*
 * #2108: a reboot leaves native-main fenced until `ocx restart`.
 *
 * One trigger is a timed-out `sc.exe query`. WinSW is an optional backend, and a
 * scheduler-only install has neither of its assets on disk — but a query that timed out
 * returns "unknown", which outranks the disk and fences the whole process.
 *
 * With BOTH assets absent there is nothing for a WinSW registration to belong to, so a
 * failed query is a question about a service that cannot exist.
 */
describe("WinSW probe: a timed-out query with no assets (#2108)", () => {
  test("no xml and no exe means absent, even when the query could not be asked", () => {
    // Only the WinSW query is unaskable. The scheduler answers absent for itself, so the
    // whole verdict turns on whether the WinSW half fences over assets that are not on disk.
    const { runRaw } = recorder((file, args) => args[0] === "/query"
      ? { status: 1, stderr: "ERROR: The system cannot find the file specified." }
      : { timedOut: true });

    const result = inspectServiceManagerInstallation({
      platform: "win32", home, runRaw,
      winswStatus: () => "unknown",
    });

    expect(result.kind).toBe("absent");
  });

  test("an unaskable query with WinSW assets present is still unknown", () => {
    const dir = join(home, ".opencodex", "winsw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencodex-proxy.xml"), "<service><id>opencodex-proxy</id></service>");
    writeFileSync(join(dir, "opencodex-proxy.exe"), "MZ");

    const { runRaw } = recorder(() => ({ timedOut: true }));

    const result = inspectServiceManagerInstallation({
      platform: "win32", home, runRaw,
      winswStatus: () => "unknown",
    });

    expect(result.kind).toBe("unknown");
  });
});

/*
 * The fail-open an audit caught in the first cut of the #2114 fix.
 *
 * systemd's user search path is not one directory: ~/.local/share/systemd/user and
 * $XDG_CONFIG_HOME/systemd/user are also live, and system-level units are never in the
 * user path at all. With the bus down, a foreign unit in any of those is invisible.
 *
 * Returning "absent" because ONE path was empty produced ownership: owned on a host a
 * foreign service owns — exactly the failure the disk check was supposed to prevent.
 */
describe("bus-down absence must mean absence everywhere systemd looks (#2114)", () => {
  const BUS_DOWN = "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined";

  test("a foreign unit in the other user search dir still blocks", () => {
    const dir = join(home, ".local", "share", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencodex-proxy.service"), [
      "[Service]",
      'Environment="CODEX_HOME=/other/.codex"',
      'Environment="OPENCODEX_HOME=/other/.opencodex"',
    ].join("\n"));
    const { run } = recorder(() => ({ status: 1, stderr: BUS_DOWN }));

    const result = inspectServiceManagerInstallation({ run, platform: "linux", home });

    expect(result.kind).not.toBe("absent");
  });

  test("XDG_CONFIG_HOME is honored the way systemd honors it", () => {
    const xdg = join(home, "xdg-config");
    const dir = join(xdg, "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencodex-proxy.service"), '[Service]\nEnvironment="CODEX_HOME=/other/.codex"');
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const { run } = recorder(() => ({ status: 1, stderr: BUS_DOWN }));

      expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).not.toBe("absent");
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  test("a genuinely empty disk is still absent", () => {
    const { run } = recorder(() => ({ status: 1, stderr: BUS_DOWN }));

    expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).toBe("absent");
  });

  // The multi-unit branch is a fail-closed decision that nothing pinned: ablating it left the
  // suite green. Two units on disk with the bus down is genuinely ambiguous — neither can be
  // confirmed as the live definition — so it must refuse rather than pick one.
  test("two units in different search dirs refuse rather than choose", () => {
    const a = join(home, ".config", "systemd", "user");
    const b = join(home, ".local", "share", "systemd", "user");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "opencodex-proxy.service"), `[Service]\nEnvironment="CODEX_HOME=${join(home, ".codex")}"`);
    writeFileSync(join(b, "opencodex-proxy.service"), '[Service]\nEnvironment="CODEX_HOME=/other/.codex"');
    const { run } = recorder(() => ({ status: 1, stderr: BUS_DOWN }));

    expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).toBe("unknown");
  });
});
