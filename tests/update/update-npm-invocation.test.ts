import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  npmInvocation,
  resolveNpmCommand,
} from "../../src/update/npm-invocation.mjs";

const cwd = "C:\\work\\untrusted-project";
const trustedNpm = "C:\\Program Files\\nodejs\\npm.cmd";
const systemCmd = "C:\\Windows\\System32\\cmd.exe";

describe("Windows npm update invocation", () => {
  test("ignores current-directory candidates and resolves npm from an absolute PATH entry", () => {
    const existing = new Set([
      `${cwd}\\npm.cmd`,
      trustedNpm,
    ]);
    const env = {
      PATH: `${cwd};.;C:\\Program Files\\nodejs`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd,
      exists: path => existing.has(path),
    })).toBe(trustedNpm);

    const invocation = npmInvocation(["view", "pkg@latest", "version"], "win32", env, {
      cwd,
      exists: path => existing.has(path),
    });
    expect(invocation).toMatchObject({
      file: systemCmd,
      args: ["/d", "/s", "/c", expect.stringContaining("nodejs\\npm.cmd")],
      options: { windowsVerbatimArguments: true },
    });
    expect(String(invocation?.args.at(-1) ?? "").includes(cwd)).toBe(false);
  });

  test("resolves the default global npm prefix when the cwd is its ancestor", () => {
    // Regression: excluding the whole cwd subtree (rather than the cwd itself) hid npm's
    // default Windows global prefix `%AppData%\npm` from anyone whose shell sits in their
    // home directory, silently failing updates closed in a normal setup.
    const home = "C:\\Users\\dev";
    const appDataNpm = `${home}\\AppData\\Roaming\\npm\\npm.cmd`;
    const env = {
      PATH: `${home}\\AppData\\Roaming\\npm`,
      APPDATA: `${home}\\AppData\\Roaming`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd: home,
      exists: path => path === appDataNpm,
    })).toBe(appDataNpm);
  });

  test.each([
    ["C:\\Users\\dev", "C:\\Users\\dev\\AppData\\Local\\Volta\\bin", "LOCALAPPDATA", "C:\\Users\\dev\\AppData\\Local"],
    ["C:\\", "C:\\Program Files\\nodejs", "ProgramFiles", "C:\\Program Files"],
    ["C:\\Users\\dev", "C:\\Users\\dev\\scoop\\apps\\nodejs-lts\\current", "USERPROFILE", "C:\\Users\\dev"],
    ["C:\\Users\\dev", "C:\\Users\\dev\\scoop\\apps\\nodejs-lts\\current\\bin", "USERPROFILE", "C:\\Users\\dev"],
    ["C:\\Users\\dev", "C:\\Users\\dev\\scoop\\apps\\nodejs\\current", "USERPROFILE", "C:\\Users\\dev"],
    ["C:\\Users\\dev", "C:\\Users\\dev\\scoop\\apps\\nodejs\\current\\bin", "USERPROFILE", "C:\\Users\\dev"],
  ])("resolves trusted npm from broad cwd %s", (cwd, directory, envKey, root) => {
    const npm = `${directory}\\npm.cmd`;
    expect(resolveNpmCommand("win32", { PATH: directory, PATHEXT: ".CMD", [envKey]: root }, {
      cwd, exists: path => path === npm, realpath: path => path,
    })).toBe(npm);
  });

  test("does not trust a Scoop npm inside the launch tree or arbitrary Scoop apps", () => {
    const home = "C:\\Users\\dev";
    const root = `${home}\\scoop\\apps\\nodejs-lts\\current`;
    const npm = `${root}\\bin\\npm.cmd`;
    const env = { PATH: `${root}\\bin`, USERPROFILE: home, PATHEXT: ".CMD" };
    const deps = { exists: (path: string) => path === npm, realpath: (path: string) => path };
    expect(resolveNpmCommand("win32", env, { ...deps, cwd: home })).toBe(npm);
    expect(resolveNpmCommand("win32", env, { ...deps, cwd: root })).toBeNull();
    expect(resolveNpmCommand("win32", env, { ...deps, cwd: `${root}\\bin` })).toBeNull();
    expect(resolveNpmCommand("win32", {
      ...env, PATH: `${home}\\scoop\\apps\\other\\current\\bin`,
    }, { cwd: home, exists: () => true })).toBeNull();
  });

  test.each(["nodejs", "nodejs-lts"])("canonicalizes only the short-home alias for Scoop %s persisted bins", appName => {
    const physicalHome = "C:\\Users\\Runner Administrator";
    for (const home of ["C:\\Users\\RUNNER~1", physicalHome]) {
      const app = `${home}\\scoop\\apps\\${appName}`;
      const physicalApp = `${physicalHome}\\scoop\\apps\\${appName}`;
      const current = `${app}\\current`;
      const version = `${physicalApp}\\24.1.0`;
      const entry = `${current}\\bin`;
      const candidate = `${entry}\\npm.cmd`;
      const expectedPersist = `${home}\\scoop\\persist\\${appName}\\bin`;
      const physicalPersist = `${physicalHome}\\scoop\\persist\\${appName}\\bin`;
      const cwdAlias = "C:\\launch-alias";
      const baseline = new Map<string, string>([
        [home, physicalHome], [app, physicalApp], [current, version],
        [entry, physicalPersist], [candidate, `${physicalPersist}\\npm.cmd`],
        [expectedPersist, physicalPersist], [physicalPersist, physicalPersist],
        [cwdAlias, physicalHome],
      ]);
      const resolve = (overrides: Array<[string, string | undefined]> = []) => {
        const paths = new Map<string, string | undefined>(baseline);
        for (const [from, to] of overrides) paths.set(from, to);
        return resolveNpmCommand("win32", { USERPROFILE: home, PATH: entry, PATHEXT: ".CMD" }, {
          cwd: cwdAlias, exists: path => path === candidate,
          realpath: path => {
            const target = paths.get(path);
            if (target === undefined) throw new Error("unresolved synthetic path");
            return target;
          },
        });
      };
      expect(resolve()).toBe(candidate);
      for (const redirected of [`${physicalHome}\\other-bin`, "D:\\another-home\\bin"]) {
        // Even resolving the expected persist path reaches the attacker target:
        // accepting that result would silently redefine the trusted suffix.
        expect(resolve([[entry, redirected], [candidate, `${redirected}\\npm.cmd`],
          [expectedPersist, redirected], [physicalPersist, redirected]])).toBeNull();
      }
      expect(resolve([[candidate, `${physicalHome}\\elsewhere\\npm.cmd`]])).toBeNull();
      expect(resolve([[current, "D:\\outside-app"]])).toBeNull();
      expect(resolve([[current, physicalApp]])).toBeNull();
      expect(resolve([[cwdAlias, version]])).toBeNull();
      expect(resolve([[cwdAlias, physicalPersist]])).toBeNull();
      expect(resolve([[home, "D:\\different-home"]])).toBeNull();
      expect(resolve([[home, undefined]])).toBeNull();
    }
  });

  test.skipIf(process.platform !== "win32")("resolves real Scoop junctions but rejects resolved cwd and redirected targets", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-scoop-node-"));
    try {
      const app = join(home, "scoop", "apps", "nodejs-lts");
      const version = join(app, "24.1.0");
      const current = join(app, "current");
      const bin = join(current, "bin");
      mkdirSync(join(version, "bin"), { recursive: true });
      writeFileSync(join(version, "bin", "npm.cmd"), "@echo off\r\n");
      symlinkSync(version, current, "junction");
      const env = { PATH: bin, USERPROFILE: home, PATHEXT: ".CMD", SystemRoot: "C:\\Windows" };
      const npm = join(bin, "npm.cmd");

      expect(resolveNpmCommand("win32", env, { cwd: home })).toBe(npm);
      expect(resolveNpmCommand("win32", env, { cwd: version })).toBeNull();
      expect(npmInvocation(["--version"], "win32", env, { cwd: join(version, "bin") })).toBeNull();

      rmSync(join(version, "bin"), { recursive: true });
      const persistBin = join(home, "scoop", "persist", "nodejs-lts", "bin");
      mkdirSync(persistBin, { recursive: true });
      writeFileSync(join(persistBin, "npm.cmd"), "@echo off\r\n");
      symlinkSync(persistBin, join(version, "bin"), "junction");
      expect(resolveNpmCommand("win32", env, { cwd: home })).toBe(npm);
      expect(resolveNpmCommand("win32", env, { cwd: persistBin })).toBeNull();

      // Remove the directory junction itself, retaining the populated target.
      rmdirSync(join(version, "bin"));
      expect(readFileSync(join(persistBin, "npm.cmd"), "utf8")).toBe("@echo off\r\n");
      const outsideBin = join(home, "other-bin");
      mkdirSync(outsideBin);
      writeFileSync(join(outsideBin, "npm.cmd"), "@echo off\r\n");
      symlinkSync(outsideBin, join(version, "bin"), "junction");
      expect(resolveNpmCommand("win32", env, { cwd: home })).toBeNull();

      rmdirSync(current);
      expect(readFileSync(join(version, "bin", "npm.cmd"), "utf8")).toBe("@echo off\r\n");
      const outside = join(home, "other-app");
      mkdirSync(join(outside, "bin"), { recursive: true });
      writeFileSync(join(outside, "bin", "npm.cmd"), "@echo off\r\n");
      symlinkSync(outside, current, "junction");
      expect(resolveNpmCommand("win32", env, { cwd: home })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not admit NO_JUNCTION or a custom Scoop root under the home", () => {
    const home = "C:\\Users\\dev";
    for (const entry of [
      `${home}\\scoop\\apps\\nodejs-lts\\24.1.0\\bin`,
      `${home}\\custom-scoop\\apps\\nodejs-lts\\current\\bin`,
    ]) {
      expect(resolveNpmCommand("win32", { PATH: entry, USERPROFILE: home, PATHEXT: ".CMD" }, {
        cwd: home, exists: () => true,
      })).toBeNull();
    }
  });

  test("ignores npm candidates in current-directory subtrees", () => {
    const projectNpm = `${cwd}\\node_modules\\.bin\\npm.cmd`;
    const env = {
      PATH: `${cwd}\\node_modules\\.bin;C:\\Program Files\\nodejs`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };
    const existing = new Set([projectNpm, trustedNpm]);

    expect(resolveNpmCommand("win32", env, {
      cwd,
      exists: path => existing.has(path),
    })).toBe(trustedNpm);

    const invocation = npmInvocation(["install", "-g", "pkg@latest"], "win32", env, {
      cwd,
      exists: path => existing.has(path),
    });
    expect(invocation?.args.at(-1)).toContain("nodejs\\npm.cmd");
    expect(invocation?.args.at(-1)).not.toContain("node_modules\\.bin\\npm.cmd");
  });

  test("still skips the current directory when it is a PATH entry under the home tree", () => {
    // The narrower rule must not lose the actual defense: a PATH entry equal to the
    // launch directory stays excluded even though it sits inside the user's home.
    const home = "C:\\Users\\dev";
    const project = `${home}\\untrusted`;
    const env = {
      PATH: `${project};${home}\\AppData\\Roaming\\npm`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };
    const existing = new Set([
      `${project}\\npm.cmd`,
      `${home}\\AppData\\Roaming\\npm\\npm.cmd`,
    ]);

    expect(resolveNpmCommand("win32", env, {
      cwd: project,
      exists: path => existing.has(path),
    })).toBe(`${home}\\AppData\\Roaming\\npm\\npm.cmd`);
  });

  test("fails closed when npm is available only from the current directory", () => {
    const env = {
      PATH: `${cwd};.`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd,
      exists: path => path === `${cwd}\\npm.cmd`,
    })).toBeNull();
    expect(npmInvocation(["view", "pkg@latest", "version"], "win32", env, {
      cwd,
      exists: path => path === `${cwd}\\npm.cmd`,
    })).toBeNull();
  });

  test("rejects the launch directory even when it is the trusted global npm prefix", () => {
    // Regression: with cwd === %APPDATA%\npm the PATH entry equal to the launch
    // directory satisfied both the subtree check and the trusted-prefix exception,
    // re-admitting the exact current-directory candidate this hardening forbids.
    const appData = "C:\\Users\\dev\\AppData\\Roaming";
    const appDataNpmDir = `${appData}\\npm`;
    const env = {
      PATH: appDataNpmDir,
      APPDATA: appData,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };
    const only = `${appDataNpmDir}\\npm.cmd`;

    expect(resolveNpmCommand("win32", env, {
      cwd: appDataNpmDir,
      exists: path => path === only,
    })).toBeNull();
    expect(npmInvocation(["install", "-g", "pkg@latest"], "win32", env, {
      cwd: appDataNpmDir,
      exists: path => path === only,
    })).toBeNull();
  });
});
