import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as serviceState from "../../src/service/state";
import { buildPlist, buildUnit, buildWindowsServiceScript } from "../../src/service";
import { windowsEnvIndirectBatchValue } from "../../src/lib/win-paths";
import { serviceApiTokenFilePath } from "../../src/lib/service-secrets";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Pinned service-home cases, split from service.test.ts to keep that file under its line cap.
const TEST_DIR = join(import.meta.dir, ".tmp-service-pinned-homes-test");
const previousOpenCodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiAuthToken;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

function pathVariants(path: string): string[] {
  const batchPath = windowsEnvIndirectBatchValue(path, windowsBatchValue);
  return [...new Set([
    path,
    path.replace(/\\/g, "\\\\"),
    batchPath,
    batchPath.replace(/\\/g, "\\\\"),
  ])];
}

function expectTextToContainPath(text: string, path: string): void {
  expect(pathVariants(path).some(candidate => text.includes(candidate))).toBe(true);
}

describe("systemd service unit", () => {
  test("pins resolved homes after login-shell initialization with shell-safe quoting", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldCodexSqliteHome = process.env.CODEX_SQLITE_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldApiAuthToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    const oldHome = process.env.HOME;
    const profileHome = join(TEST_DIR, "login-home");
    const codexHome = join(TEST_DIR, "pinned-codex's-home");
    const opencodexHome = join(TEST_DIR, "pinned-opencodex-home");
    try {
      mkdirSync(profileHome, { recursive: true });
      // `/bin/sh -lc` sources this login profile. It deliberately disagrees with the
      // service install; the command's final pin must win, including a quote in the path.
      writeFileSync(join(profileHome, ".profile"), "export CODEX_HOME=/profile/codex\nexport OPENCODEX_HOME=/profile/opencodex\n");
      process.env.HOME = profileHome;
      process.env.CODEX_HOME = codexHome;
      process.env.CODEX_SQLITE_HOME = join(TEST_DIR, "pinned-sqlite-home");
      process.env.OPENCODEX_HOME = opencodexHome;
      process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
      const plist = buildPlist();
      const unit = buildUnit();
      const pinned = `CODEX_HOME='${codexHome.replace(/'/g, "'\\''")}' OPENCODEX_HOME='${opencodexHome}' export CODEX_HOME OPENCODEX_HOME;`;
      // launchd XML escapes shell punctuation (&apos; and &amp;), while systemd quotes
      // the complete shell command. Both emitted commands keep the pin after `-lc`.
      expect(plist).toContain("CODEX_HOME=&apos;");
      expect(plist).toContain("export CODEX_HOME OPENCODEX_HOME;");
      const launchdCommand = /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/bin\/sh<\/string>\s*<string>-lc<\/string>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
      expect(launchdCommand).toBeDefined();
      expect(launchdCommand).toContain("exec ");
      expect(launchdCommand!.indexOf("export CODEX_HOME OPENCODEX_HOME;")).toBeLessThan(launchdCommand!.indexOf("exec "));
      // systemd doubles backslashes inside the ExecStart string.
      expect(unit).toContain(pinned.replace(/\\/g, "\\\\"));
      const systemdCommand = /^ExecStart=(.*)$/m.exec(unit)?.[1];
      expect(systemdCommand).toBeDefined();
      expect(systemdCommand).toContain("exec ");
      expect(systemdCommand!.indexOf(pinned.replace(/\\/g, "\\\\"))).toBeLessThan(systemdCommand!.indexOf("exec "));
      const systemdEscapes: Record<string, string> = { "\\": "\\\\", '"': '\\"', "%": "%%", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
      const sqliteHome = join(TEST_DIR, "pinned-sqlite-home").replace(/[\\"%\n\r\t]/g, ch => systemdEscapes[ch]!);
      expect(unit).toContain('Environment="CODEX_SQLITE_HOME=' + sqliteHome + '"');
      expect(unit).not.toContain("local-secret");
      expect(unit).not.toContain('Environment="OPENCODEX_API_AUTH_TOKEN=');

      // This is the actual `-lc` behavior used by both service definitions: the profile
      // runs first, then the baked assignment must survive to the child environment.
      if (process.platform !== "win32") {
        const command = `${pinned} printf '%s\\n%s\\n' "$CODEX_HOME" "$OPENCODEX_HOME"`;
        const output = execFileSync("/bin/sh", ["-lc", command], {
          env: { ...process.env, CODEX_HOME: "/manager/codex", OPENCODEX_HOME: "/manager/opencodex" },
          encoding: "utf8",
        });
        expect(output.trim().split("\n")).toEqual([codexHome, opencodexHome]);
      }

      expectTextToContainPath(unit, serviceApiTokenFilePath());
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = oldCodexSqliteHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldApiAuthToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
      else process.env.OPENCODEX_API_AUTH_TOKEN = oldApiAuthToken;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  test("resolves each home once so Environment= and ExecStart agree", () => {
    // The default Codex home follows filesystem state, so two resolutions can disagree.
    // Return a different value on every call: a unit built from one resolution stays consistent.
    let codexCalls = 0;
    let opencodexCalls = 0;
    const codex = spyOn(serviceState, "currentCodexHome").mockImplementation(() => `/resolved/codex-${++codexCalls}`);
    const opencodex = spyOn(serviceState, "currentOpenCodexHome").mockImplementation(() => `/resolved/opencodex-${++opencodexCalls}`);
    try {
      const unit = buildUnit([], { launcher: "/usr/local/bin/ocx" });
      expect(codexCalls).toBe(1);
      expect(opencodexCalls).toBe(1);
      expect(unit).toContain('Environment="CODEX_HOME=/resolved/codex-1"');
      expect(unit).toContain('Environment="OPENCODEX_HOME=/resolved/opencodex-1"');
      expect(unit).toContain("CODEX_HOME='/resolved/codex-1' OPENCODEX_HOME='/resolved/opencodex-1' export CODEX_HOME OPENCODEX_HOME;");
      expect(unit).not.toContain("codex-2");
    } finally {
      codex.mockRestore();
      opencodex.mockRestore();
    }
  });
});

describe("Windows service task", () => {
  test("keeps install-time home paths literal when Task Scheduler changes its environment", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    const oldUserProfile = process.env.USERPROFILE;
    const oldAppData = process.env.APPDATA;
    const oldLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.CODEX_HOME = "C:\\Users\\한글사용자\\.codex";
      process.env.OPENCODEX_HOME = join(TEST_DIR, "install-opencodex-home-한글");
      process.env.USERPROFILE = "C:\\Users\\TaskUser";
      process.env.APPDATA = "C:\\Users\\TaskUser\\AppData\\Roaming";
      process.env.LOCALAPPDATA = "C:\\Users\\TaskUser\\AppData\\Local";
      const script = buildWindowsServiceScript();
      expect(script).toContain('set "CODEX_HOME=C:\\Users\\한글사용자\\.codex"');
      expect(script).toContain(`set "OPENCODEX_HOME=${join(TEST_DIR, "install-opencodex-home-한글")}"`);
      expect(script.indexOf("chcp 65001 >nul")).toBeLessThan(script.indexOf('set "CODEX_HOME='));
      expect(script).not.toContain('set "CODEX_HOME=%USERPROFILE%');
      expect(script).not.toContain('set "CODEX_HOME=%APPDATA%');
      expect(script).not.toContain('set "OPENCODEX_HOME=%USERPROFILE%');
      expect(script).not.toContain('set "OPENCODEX_HOME=%APPDATA%');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = oldAppData;
      if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = oldLocalAppData;
    }
  });
});

describe("launchd service plist", () => {
  test("bakes resolved CODEX_HOME and OPENCODEX_HOME into service definitions even when unset in process.env", () => {
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOpenCodexHome = process.env.OPENCODEX_HOME;
    try {
      delete process.env.CODEX_HOME;
      process.env.OPENCODEX_HOME = TEST_DIR;
      const plist = buildPlist();
      expect(plist).toContain("<key>CODEX_HOME</key><string>");
      expect(plist).toContain("<key>OPENCODEX_HOME</key><string>");
      const unit = buildUnit();
      expect(unit).toContain('Environment="CODEX_HOME=');
      expect(unit).toContain('Environment="OPENCODEX_HOME=');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      if (oldOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOpenCodexHome;
    }
  });
});
