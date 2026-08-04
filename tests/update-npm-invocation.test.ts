import { describe, expect, test } from "bun:test";
import {
  npmInvocation,
  resolveNpmCommand,
} from "../src/update/npm-invocation.mjs";

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
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd: home,
      exists: path => path === appDataNpm,
    })).toBe(appDataNpm);
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
});
